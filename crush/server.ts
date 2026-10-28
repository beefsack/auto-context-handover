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
import {
  HANDOVER_SECTIONS,
} from "../source/shared/handover-text.ts";
import type { CrushApi } from "./client.ts";
import { CrushHttpClient } from "./client.ts";
import { resolveSocket } from "./hook.ts";
import {
  baseDirFromEnv,
  CrushStore,
  DuplicateHandoverError,
  HANDOVER_TOOL,
  PendingError,
  READ_TOOL,
  type HandoverDiagnostics,
  type HandoverRecord,
} from "./store.ts";
import {
  buildSuccessorPrompt,
  fullText,
  HANDOVER_INPUT_SCHEMA,
  missingText,
  readInvocation,
  READ_INPUT_SCHEMA,
  seedWarningForPrompt,
  shortReply,
  successorLine,
  titleFor,
  TOOL_NAMES,
} from "./text.ts";

export const SERVER_NAME = "auto-context-handover";
export const SERVER_VERSION = "0.1.0";
// Namespace prefix the host applies to registered tools, derived from text.ts
// so the server also accepts the fully namespaced form defensively.
const TOOL_NAMESPACE_PREFIX = TOOL_NAMES.handover.slice(0, -HANDOVER_TOOL.length);

export const HANDOVER_DESCRIPTION =
  `Call this tool only after a context nudge or an explicit user handover request. ` +
  `Do not call it just to finish a task; give a normal final response instead. ` +
  `Once nudged, call exactly once when done with the current unit of work, then stop. ` +
  `Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never summarized or reworded) ` +
  `plus a short status/outcome/next-step summary in "summary".\n\n` +
  `${HANDOVER_SECTIONS}\n\n` +
  `Crush-root clarification: the plugin records source root session, workspace, and effective model only; ` +
  `requested model overrides, agent/chain provenance, and original task capture are unavailable in this adapter, do not invent them. ` +
  `There is no parent workflow; the shared template's parent/plugin-record line applies only to the stored source record.\n\n` +
  `After persistence (handover stored and source closed) the server creates one successor ROOT session in the same workspace, ` +
  `persists its id before prompt admission, and submits the full handover to it exactly once. ` +
  `The closed source cannot do more work. ` +
  `After the call, end your turn with exactly the receipt text it returns as your final native message and then stop.`;

export const READ_DESCRIPTION =
  `Read a stored context handover. Pass the target root session id in "sessionID". ` +
  `Returns the full verbatim handover with provenance and diagnostics; there is no compact mode. ` +
  `Any live host-bound root may read any stored session id; the binding capability is checked, never a model-supplied caller id.`;

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: `crush server: ${message}` }], isError: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function shortName(name: string): string {
  return name.startsWith(TOOL_NAMESPACE_PREFIX) ? name.slice(TOOL_NAMESPACE_PREFIX.length) : name;
}

function normalizeDiagnostics(value: unknown): HandoverDiagnostics {
  const record = asRecord(value);
  const soft = record?.soft;
  if (soft !== undefined && (typeof soft !== "number" || !Number.isFinite(soft) || soft <= 0)) {
    throw new Error("stored diagnostics has an invalid soft limit");
  }
  const reason = record?.reason;
  const stage = record?.stage;
  const estimatedTokens = record?.estimatedTokens;
  const softValue = record?.soft;
  return {
    reason: reason === "nudged" || reason === "not-nudged" || reason === "unknown" ? reason : "unknown",
    ...(stage === "warn1" || stage === "warn2" || stage === "final" ? { stage } : {}),
    ...(typeof estimatedTokens === "number" && Number.isFinite(estimatedTokens)
      ? { estimatedTokens }
      : {}),
    ...(typeof softValue === "number" && Number.isFinite(softValue) && softValue > 0
      ? { soft: softValue }
      : {}),
  };
}

function lockedText(sourceId: string, successorId: string | undefined): string {
  return (
    `This session is locked after a context handover and cannot do more work. ` +
    `The locked caller cannot itself read; default: open a fresh live root session and read the handover with ${readInvocation(sourceId)}, then continue in the successor. ` +
    `${successorLine(successorId)}`
  );
}

function statusOf(store: CrushStore, sourceId: string): string | undefined {
  try {
    return store.getStatus(sourceId)?.successorId;
  } catch {
    return undefined;
  }
}

function fullStatusOf(store: CrushStore, sourceId: string): import("./store.ts").RolloverStatus | undefined {
  try {
    return store.getStatus(sourceId);
  } catch {
    return undefined;
  }
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
 * Never retries after an uncertain create/admission: the stored handover and
 * closed source are kept, and the error names the successor id (when known)
 * plus explicit manual recovery.
 */
export async function executeTool(
  toolName: string,
  rawArgs: unknown,
  store: CrushStore,
  api: CrushApi,
): Promise<CallToolResult> {
  const invoked = shortName(toolName);
  if (invoked !== HANDOVER_TOOL && invoked !== READ_TOOL) {
    return fail(`unknown tool ${JSON.stringify(toolName)}`);
  }
  // Only the host-minted capability is read from runtime input; every other
  // runtime field is ignored in favor of the exact stored args.
  const runtime = asRecord(rawArgs);
  if (!runtime || typeof runtime.capability !== "string") {
    return fail(`tool input must include {"capability":"<64 hex chars>"}`);
  }
  let pending;
  try {
    pending = store.consumePending(runtime.capability);
  } catch (error) {
    if (error instanceof PendingError) return fail(error.message);
    throw error;
  }
  if (pending.tool !== invoked) {
    return fail(`capability was bound to ${JSON.stringify(pending.tool)} and cannot invoke ${JSON.stringify(invoked)}`);
  }
  const caller = pending.caller;

  if (invoked === HANDOVER_TOOL) {
    if (!caller.workspaceId) {
      return fail("handover binding is missing the workspace; no successor can be created in the same workspace");
    }
    const sourceId = caller.sessionId;
    let closed: HandoverRecord | undefined;
    try {
      closed = store.getHandover(sourceId);
    } catch (error) {
      return fail(`cannot verify lock state for session ${JSON.stringify(sourceId)}: ${(error as Error).message}`);
    }
    if (closed) return fail(lockedText(sourceId, statusOf(store, sourceId)));
    const original = asRecord(pending.args);
    if (!original) return fail("stored tool input is not an object");
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
    let diagnostics: HandoverDiagnostics;
    try {
      diagnostics = normalizeDiagnostics(pending.diagnostics);
    } catch (error) {
      return fail((error as Error).message);
    }
    const record: HandoverRecord = {
      sessionId: sourceId,
      workspaceId: caller.workspaceId,
      model: caller.model && caller.model.length > 0 ? caller.model : "unknown",
      handover: original.handover,
      summary: original.summary,
      closed: true,
      diagnostics,
    };
    try {
      store.saveHandover(record);
    } catch (error) {
      if (error instanceof DuplicateHandoverError) {
        return fail(`handover already stored for session ${JSON.stringify(sourceId)}; the first handover is immutable`);
      }
      return fail(`handover storage failed and nothing was stored: ${(error as Error).message}`);
    }

    const title = titleFor(record.handover, record.summary);
    const seedForWarning = buildSuccessorPrompt(sourceId, title, record.handover);
    const seedWarning = seedWarningForPrompt(seedForWarning, record.diagnostics.soft);
    const seedWarningSuffix = seedWarning ? `\n${seedWarning}` : "";
    let successorId: string;
    try {
      successorId = (await api.createSession(record.workspaceId, title)).id;
    } catch (error) {
      try {
        store.updateStatus(sourceId, { error: (error as Error).message });
      } catch {}
      return fail(
        `handover stored and source session ${JSON.stringify(sourceId)} is closed, ` +
        `but successor creation in workspace ${JSON.stringify(record.workspaceId)} failed: ${(error as Error).message}. ` +
        `Creation is uncertain (a timeout/network error may have been accepted externally). ` +
        `Nothing was retried. Inspect the server/workspaces before any retry; never resubmit blindly. ` +
        `Manual recovery: inspect for a root session created with title ` +
        `${JSON.stringify(title)}, or create a root session in the same workspace with that title, ` +
        `then submit the full handover from ${readInvocation(sourceId)} to it exactly once after inspection.` +
        seedWarningSuffix,
      );
    }
    if (successorId === sourceId) {
      try {
        store.updateStatus(sourceId, { successorId, error: "successor id equals source id" });
      } catch {}
      return fail(
        `handover stored and source session ${JSON.stringify(sourceId)} is closed, ` +
        `but the created successor id equals the source id; refusing to admit to avoid a self-loop. ` +
        `Nothing was retried. Inspect the server/workspaces before any retry; never resubmit blindly.` +
        seedWarningSuffix,
      );
    }
    // Persist the successor id BEFORE prompt admission so a later admission
    // failure still names the successor for manual recovery. No admitted flag:
    // admission is still uncertain at this point.
    try {
      store.updateStatus(sourceId, { successorId });
    } catch (error) {
      return fail(
        `handover stored and successor ${JSON.stringify(successorId)} created, ` +
        `but successor bookkeeping failed: ${(error as Error).message}. ` +
        `Nothing was submitted yet and nothing was retried. Manual recovery: inspect the successor, then submit the full handover ` +
        `from ${readInvocation(sourceId)} to successor ${JSON.stringify(successorId)} exactly once after inspection.` +
        seedWarningSuffix,
      );
    }
    const seed = buildSuccessorPrompt(sourceId, title, record.handover);
    try {
      await api.sendAgentPrompt(record.workspaceId, successorId, seed);
    } catch (error) {
      try {
        store.updateStatus(sourceId, { successorId, error: (error as Error).message });
      } catch {}
      return fail(
        `handover stored and source session ${JSON.stringify(sourceId)} is closed; ` +
        `successor ${JSON.stringify(successorId)} exists but prompt admission is uncertain (a timeout/network error may have been accepted externally): ${(error as Error).message}. ` +
        `Nothing was retried. Inspect the successor and server before any retry; never resubmit blindly. ` +
        `Manual recovery: inspect successor ${JSON.stringify(successorId)}, then submit the full handover from ${readInvocation(sourceId)} ` +
        `to it exactly once only if missing.` +
        seedWarningSuffix,
      );
    }
    try {
      store.updateStatus(sourceId, { successorId, admitted: true });
    } catch (error) {
      return textResult(
        `${shortReply(record, successorId)}\n` +
        `Warning: successor bookkeeping failed after a successful admission: ${(error as Error).message}. ` +
        `The handover was submitted once; do not resubmit.` +
        seedWarningSuffix,
      );
    }
    return textResult(`${shortReply(record, successorId)}${seedWarningSuffix}`);
  }

  const original = asRecord(pending.args);
  if (!original) return fail("stored tool input is not an object");
  for (const key of Object.keys(original)) {
    if (key !== "sessionID") {
      return fail(`stored tool input has unknown field ${JSON.stringify(key)}; only "sessionID" is accepted`);
    }
  }
  if (typeof original.sessionID !== "string" || original.sessionID.length === 0) {
    return fail(`stored "sessionID" must be a non-empty string`);
  }
  try {
    if (store.getHandover(caller.sessionId)) {
      return fail(lockedText(caller.sessionId, statusOf(store, caller.sessionId)));
    }
  } catch (error) {
    return fail(`cannot verify lock state for session ${JSON.stringify(caller.sessionId)}: ${(error as Error).message}`);
  }
  const target = original.sessionID;
  let found: HandoverRecord | undefined;
  try {
    found = store.getHandover(target);
  } catch (error) {
    return fail(`cannot read handover for session ${JSON.stringify(target)}: ${(error as Error).message}`);
  }
  if (!found) return textResult(missingText(target));
  const status = fullStatusOf(store, target);
  const body = fullText(found, status);
  const seedPrompt = buildSuccessorPrompt(found.sessionId, titleFor(found.handover, found.summary), found.handover);
  const warning = seedWarningForPrompt(seedPrompt, found.diagnostics.soft);
  return textResult(warning ? `${body}\n${warning}` : body);
}

export function createServer(store: CrushStore, api: CrushApi): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await executeTool(request.params.name, request.params.arguments, store, api);
    } catch (error) {
      return fail(`unexpected failure: ${(error as Error).message}`);
    }
  });
  return server;
}

async function main(): Promise<void> {
  let store: CrushStore;
  let api: CrushHttpClient;
  try {
    store = new CrushStore(baseDirFromEnv(process.env));
    api = new CrushHttpClient(resolveSocket(process.env));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
    return;
  }
  await createServer(store, api).connect(new StdioServerTransport());
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
    process.stderr.write(`crush server: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
