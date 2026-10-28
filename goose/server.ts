import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HANDOVER_SECTIONS } from "../source/shared/handover-text.ts";
import { softStage } from "../source/shared/handover-text.ts";
import { resolveSoft } from "./hook.ts";
import {
  estimateFromUsage,
  exportSessionJson,
  isRootSession,
  modelFromExport,
  SessionExportError,
  type ExportedSession,
  type SessionReader,
} from "./session.ts";
import {
  baseDirFromEnv,
  DuplicateHandoverError,
  GooseStore,
  HANDOVER_TOOL,
  READ_TOOL,
  type HandoverDiagnostics,
} from "./store.ts";
import {
  fullText,
  HANDOVER_INPUT_SCHEMA,
  missingText,
  READ_INPUT_SCHEMA,
  seedWarningForRecord,
  shortReceipt,
} from "./text.ts";

export const SERVER_NAME = "auto-context-handover";
export const SERVER_VERSION = "0.1.0";
export const PIN_ENV_VAR = "AGENT_SESSION_ID";

export const HANDOVER_DESCRIPTION =
  `Call this tool only after a context nudge or an explicit user handover request. ` +
  `Do not call it just to finish a task; give a normal final response instead. ` +
  `Once nudged, call exactly once when done with the current unit of work, then stop. ` +
  `Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never summarized or reworded) ` +
  `plus a short status/outcome/next-step summary in "summary".\n\n` +
  `${HANDOVER_SECTIONS}\n\n` +
  `Goose-root clarification: the plugin records the source root session id and the model from the native session export only; ` +
  `requested model overrides, agent/chain provenance, and original task capture are unavailable in this adapter, do not invent them. ` +
  `There is no successor workflow: nothing is closed automatically and no successor is created. ` +
  `After the call, end your turn with exactly the receipt text it returns as your final native message and then stop.`;

export const READ_DESCRIPTION =
  `Read a stored context handover. Pass the target root session id in "sessionID". ` +
  `Returns the full verbatim handover with provenance and diagnostics; there is no compact mode. ` +
  `Any live host-bound caller (including child sessions) may read any stored session id by intentional policy; ` +
  `root classification is required only for the writer. The binding transport identity is checked, never a model-supplied caller id.`;

export type { SessionReader };

function defaultReader(env: NodeJS.ProcessEnv): SessionReader {
  return (sessionId: string) => exportSessionJson(sessionId, env);
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: `goose server: ${message}` }], isError: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Accepts the bare tool name or any `<extkey>__<tool>` host-namespaced form. */
function shortName(name: string): string | undefined {
  if (name === HANDOVER_TOOL || name === READ_TOOL) return name;
  const suffix = name.split("__").pop();
  if (suffix === HANDOVER_TOOL || suffix === READ_TOOL) return suffix;
  return undefined;
}

/**
 * Host identity from the per-call request `_meta` (Goose injects
 * `agent-session-id` on every tool call). Case-insensitive like the host.
 * Never read from model args: schemas reject unknown fields.
 */
export function metaSessionId(meta: unknown): string | undefined {
  const record = asRecord(meta);
  if (!record) return undefined;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "agent-session-id") {
      return typeof value === "string" && value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

function diagStageFor(estimate: number | undefined, soft: number): HandoverDiagnostics["stage"] {
  if (estimate === undefined) return undefined;
  const stage = softStage(estimate, soft);
  if (stage === "ok") return undefined;
  return stage === "warn3" ? "final" : stage;
}

export function listTools(): Tool[] {
  return [
    {
      name: HANDOVER_TOOL,
      description: HANDOVER_DESCRIPTION,
      inputSchema: { ...HANDOVER_INPUT_SCHEMA, required: [...HANDOVER_INPUT_SCHEMA.required] },
    },
    {
      name: READ_TOOL,
      description: READ_DESCRIPTION,
      inputSchema: { ...READ_INPUT_SCHEMA, required: [...READ_INPUT_SCHEMA.required] },
    },
  ];
}

/**
 * Writer binding (fail closed): the per-call `_meta` id must equal the pinned
 * process id AND a fresh native export of that id must return the same owner
 * id as a `user` root with a null parent. An unavailable root check refuses
 * the write; native child sessions are excluded. The reader needs only the
 * live host binding and may then read any retained id.
 */
export async function executeTool(
  toolName: string,
  rawArgs: unknown,
  meta: unknown,
  store: GooseStore,
  reader: SessionReader,
  pinnedId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CallToolResult> {
  const invoked = shortName(toolName);
  if (invoked === undefined) {
    return fail(`unknown tool ${JSON.stringify(toolName)}`);
  }
  if (typeof pinnedId !== "string" || pinnedId.length === 0) {
    return fail(`host identity is not pinned (${PIN_ENV_VAR} missing); refusing call`);
  }
  const caller = metaSessionId(meta);
  if (caller === undefined) {
    return fail(`tool input is missing host identity (_meta agent-session-id is required)`);
  }
  if (caller !== pinnedId) {
    return fail(`host identity mismatch; refusing call`);
  }

  if (invoked === HANDOVER_TOOL) {
    let exported: ExportedSession;
    try {
      exported = reader(caller);
    } catch (error) {
      const detail = error instanceof SessionExportError ? error.message : (error as Error).message;
      return fail(`root check unavailable, write refused: ${detail}`);
    }
    if (typeof exported.id !== "string" || exported.id !== caller || exported.id !== pinnedId) {
      return fail(`exported owner id does not match the bound host session; write refused`);
    }
    if (!isRootSession(exported)) {
      return fail(`only root user sessions can store a handover; native child sessions are excluded`);
    }
    const original = asRecord(rawArgs);
    if (!original) return fail(`stored tool input is not an object`);
    for (const key of Object.keys(original)) {
      if (key !== "handover" && key !== "summary") {
        return fail(`stored tool input has unknown field ${JSON.stringify(key)}; only "handover" and "summary" are accepted`);
      }
    }
    if (typeof original.handover !== "string" || original.handover.length === 0) {
      return fail(`stored "handover" must be a non-empty string`);
    }
    if (typeof original.summary !== "string") {
      return fail(`stored "summary" must be a string`);
    }
    let soft: number | undefined;
    try {
      soft = resolveSoft(env);
    } catch (error) {
      // An invalid soft limit disables notices, not the writer: log concisely
      // and store without soft/stage diagnostics; the usage estimate stays.
      process.stderr.write(`goose server: ${(error as Error).message}\n`);
      soft = undefined;
    }
    const estimate = estimateFromUsage(exported);
    const stage = soft === undefined ? undefined : diagStageFor(estimate, soft);
    const record = {
      sessionId: caller,
      model: modelFromExport(exported),
      handover: original.handover,
      summary: original.summary,
      diagnostics: {
        reason: "unknown" as const,
        ...(stage === undefined ? {} : { stage }),
        ...(estimate === undefined ? {} : { estimatedTokens: estimate }),
        ...(soft === undefined ? {} : { soft }),
      },
    };
    try {
      store.saveHandover(record);
    } catch (error) {
      if (error instanceof DuplicateHandoverError) {
        return fail(`handover already stored for session ${JSON.stringify(caller)}; the first handover is immutable`);
      }
      return fail(`handover storage failed and nothing was stored: ${(error as Error).message}`);
    }
    return textResult(shortReceipt(record));
  }

  const original = asRecord(rawArgs);
  if (!original) return fail(`stored tool input is not an object`);
  for (const key of Object.keys(original)) {
    if (key !== "sessionID") {
      return fail(`stored tool input has unknown field ${JSON.stringify(key)}; only "sessionID" is accepted`);
    }
  }
  if (typeof original.sessionID !== "string" || original.sessionID.length === 0) {
    return fail(`stored "sessionID" must be a non-empty string`);
  }
  const target = original.sessionID;
  let found;
  try {
    found = store.getHandover(target);
  } catch (error) {
    return fail(`cannot read handover for session ${JSON.stringify(target)}: ${(error as Error).message}`);
  }
  if (!found) return textResult(missingText(target));
  const warning = seedWarningForRecord(found);
  const body = fullText(found);
  return textResult(warning ? `${body}\n${warning}` : body);
}

export function createServer(
  store: GooseStore,
  reader: SessionReader,
  pinnedId: string,
  env: NodeJS.ProcessEnv = process.env,
): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await executeTool(request.params.name, request.params.arguments, extra._meta, store, reader, pinnedId, env);
    } catch (error) {
      return fail(`unexpected failure: ${(error as Error).message}`);
    }
  });
  return server;
}

async function main(): Promise<void> {
  const pinnedId = process.env[PIN_ENV_VAR];
  if (typeof pinnedId !== "string" || pinnedId.length === 0) {
    process.stderr.write(`goose server: ${PIN_ENV_VAR} must be set by the host stdio extension process\n`);
    process.exit(1);
    return;
  }
  let store: GooseStore;
  try {
    store = new GooseStore(baseDirFromEnv(process.env));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
    return;
  }
  await createServer(store, defaultReader(process.env), pinnedId, process.env).connect(new StdioServerTransport());
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

const invokedAsMain = isMainModule();

if (invokedAsMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`goose server: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
