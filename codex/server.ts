import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import {
  formatDiagLine,
  HANDOVER_SECTIONS,
  SEED_FRAMING,
} from "../source/shared/handover-text.ts";
import { seedTooLarge } from "../source/shared/seed-size.ts";
import {
  baseDirFromEnv,
  CodexStore,
  DuplicateHandoverError,
  HANDOVER_TOOL,
  PendingError,
  READ_TOOL,
  type HandoverDiagnostics,
  type HandoverRecord,
} from "./store.ts";
import {
  HANDOVER_INPUT_SCHEMA,
  READ_INPUT_SCHEMA,
  readInvocation,
  shortReply,
  successorPrompt,
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
  `plus a short status/outcome/next-step summary in "summary".\n\n${HANDOVER_SECTIONS}\n\n` +
  `After the call, end your turn with exactly the receipt text it returns as your final native message and then stop. ` +
  `A handed-over session is locked and cannot do more work.`;

export const READ_DESCRIPTION =
  `Read a stored context handover. Pass the target child session id in "childId". ` +
  `Omit "full" (or set it false) for the compact parent summary with diagnostics, provenance, ` +
  `a next-steps excerpt, and the successor default; set "full" true for the verbatim handover text. ` +
  `Any live bound caller may read any stored child id; the binding capability is checked, never a model-supplied caller id.`;

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: `codex server: ${message}` }], isError: true };
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
  if (typeof soft !== "number" || !Number.isFinite(soft) || soft <= 0) {
    throw new Error("stored diagnostics are missing the required positive soft limit");
  }
  const reason = record?.reason;
  const stage = record?.stage;
  const estimatedTokens = record?.estimatedTokens;
  return {
    reason: reason === "nudged" || reason === "not-nudged" ? reason : "not-nudged",
    ...(stage === "warn1" || stage === "warn2" || stage === "final" ? { stage } : {}),
    ...(typeof estimatedTokens === "number" && Number.isFinite(estimatedTokens)
      ? { estimatedTokens }
      : {}),
    soft,
  };
}

function lockedText(childId: string): string {
  return (
    `This subagent session is locked after a context handover and cannot do more work. ` +
    `Default: ${readInvocation(childId, true)}, then ${successorPrompt(childId)}`
  );
}

function titleFor(record: HandoverRecord): string {
  const firstLine = (text: string): string | undefined =>
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  const raw = firstLine(record.summary) ?? firstLine(record.handover) ?? `handover for ${record.childId}`;
  return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
}

function stripTitleMarkers(text: string): string {
  return text.trim().replace(/\*/g, "").trim();
}

/** Exact "Prioritized next steps" title: optional ATX/number/bold, then only an optional colon and optional "for the successor session" suffix. */
function isNextStepsTitle(line: string): boolean {
  let text = line.trim().replace(/^#{1,6}\s+/, "").trim();
  text = stripTitleMarkers(text).replace(/^\d+\s*[.)]\s+/, "").trim();
  text = stripTitleMarkers(text);
  return /^prioritized next steps(?:\s*:\s*for the successor session|\s+for the successor session)?\s*:?\s*$/i.test(text);
}

/** True for a clear section boundary ending a next-steps excerpt. */
function isExcerptBoundary(line: string): boolean {
  const text = line.trim();
  if (/^#{1,6}\s+\S/.test(text)) return true;
  if (/^\*\*.+\*\*$/.test(text)) return true;
  return /^(---+|___+|\*\*\*+)\s*$/.test(text);
}

/**
 * Extract the Prioritized next steps body after its title line, to the next
 * heading boundary or the end. Undefined when the title is absent or nothing
 * follows it; never falls back to body text, which would fabricate steps.
 */
function extractNextSteps(handover: string): string | undefined {
  const lines = handover.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isNextStepsTitle(lines[i] ?? "")) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  if (rest.every((line) => line.trim() === "")) return undefined;
  const end = rest.findIndex((line) => isExcerptBoundary(line));
  const excerpt = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  if (excerpt.length === 0) return undefined;
  return excerpt.length > 600 ? `${excerpt.slice(0, 600)}...` : excerpt;
}

function excerptLine(record: HandoverRecord): string {
  const excerpt = extractNextSteps(record.handover);
  if (excerpt !== undefined) return `Next steps excerpt: ${excerpt}`;
  return (
    `Next steps excerpt: unknown (could not extract; ` +
    `read the full handover with ${readInvocation(record.childId, true)}).`
  );
}

function seedSizeLine(record: HandoverRecord): string {
  // Successor-facing payload is the verbatim handover plus seed framing
  // (provenance/diagnostics headers excluded); chars/4 is the token proxy.
  const payloadChars = `${record.handover}\n\n${SEED_FRAMING}`.length;
  const estimate = Math.ceil(payloadChars / 4);
  const soft = record.diagnostics.soft;
  if (seedTooLarge(estimate, soft)) {
    return (
      `Seed size warning: successor payload is about ${estimate} tokens (chars/4 estimate), ` +
      `over 50% of the soft limit ${soft}; compress carried finished notes at the next handover ` +
      `and keep the successor prompt minimal.`
    );
  }
  return `Seed size: successor payload is about ${estimate} tokens (chars/4 estimate), ${payloadChars} chars against soft limit ${soft}.`;
}

function provenanceLine(record: HandoverRecord): string {
  const text = (value: string): string => (value.length > 0 ? value : "unknown");
  return (
    `Provenance: parent session ${JSON.stringify(text(record.parentSessionId))}, ` +
    `agent type ${JSON.stringify(text(record.agentType))}, model ${JSON.stringify(text(record.model))}.`
  );
}

function compactText(record: HandoverRecord): string {
  return [
    `Handover summary for child ${JSON.stringify(record.childId)}.`,
    provenanceLine(record),
    formatDiagLine({
      reason: record.diagnostics.reason,
      stage: record.diagnostics.stage,
      estimate: record.diagnostics.estimatedTokens,
      soft: record.diagnostics.soft,
    }),
    `Pending user decisions: unknown (deferred to full read).`,
    `Title: ${titleFor(record)}`,
    excerptLine(record),
    `Successor default: ${successorPrompt(record.childId)}`,
    seedSizeLine(record),
  ].join("\n");
}

function fullText(record: HandoverRecord): string {
  return (
    `${provenanceLine(record)}\n` +
    `${formatDiagLine({
      reason: record.diagnostics.reason,
      stage: record.diagnostics.stage,
      estimate: record.diagnostics.estimatedTokens,
      soft: record.diagnostics.soft,
    })}\n` +
    `${record.handover}\n\n${SEED_FRAMING}`
  );
}

function missingText(childId: string): string {
  return [
    `No stored handover for child ${JSON.stringify(childId)}.`,
    `Diagnostics: reason=unknown, stage=unknown, estimated-context-tokens=unknown, soft-limit=unknown`,
    `Provenance: unknown.`,
    `Pending user decisions: unknown (deferred to full read).`,
  ].join("\n");
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

export async function executeTool(toolName: string, rawArgs: unknown, store: CodexStore): Promise<CallToolResult> {
  const invoked = shortName(toolName);
  if (invoked !== HANDOVER_TOOL && invoked !== READ_TOOL) {
    return fail(`unknown tool ${JSON.stringify(toolName)}`);
  }
  const args = asRecord(rawArgs);
  if (!args || Object.keys(args).length !== 1 || typeof args.capability !== "string") {
    return fail(`tool input must be exactly {"capability":"<64 hex chars>"}`);
  }
  let pending;
  try {
    pending = store.consumePending(args.capability);
  } catch (error) {
    if (error instanceof PendingError) return fail(error.message);
    throw error;
  }
  if (pending.tool !== invoked) {
    return fail(`capability was bound to ${JSON.stringify(pending.tool)} and cannot invoke ${JSON.stringify(invoked)}`);
  }
  const caller = pending.caller;

  if (invoked === HANDOVER_TOOL) {
    if (!caller.childId) {
      return fail("root sessions cannot store a context handover; only a bound child session can");
    }
    const childId = caller.childId;
    let closed: HandoverRecord | undefined;
    try {
      closed = store.getHandover(childId);
    } catch (error) {
      return fail(`cannot verify lock state for child ${JSON.stringify(childId)}: ${(error as Error).message}`);
    }
    if (closed) return fail(lockedText(childId));
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
      childId,
      parentSessionId: caller.sessionId,
      agentType: caller.agentType && caller.agentType.length > 0 ? caller.agentType : "unknown",
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
        return fail(`handover already stored for child ${JSON.stringify(childId)}; the first handover is immutable`);
      }
      return fail(`handover storage failed and nothing was stored: ${(error as Error).message}`);
    }
    return textResult(shortReply(record));
  }

  const original = asRecord(pending.args);
  if (!original) return fail("stored tool input is not an object");
  for (const key of Object.keys(original)) {
    if (key !== "childId" && key !== "full") {
      return fail(`stored tool input has unknown field ${JSON.stringify(key)}; only "childId" and "full" are accepted`);
    }
  }
  if (typeof original.childId !== "string" || original.childId.length === 0) {
    return fail(`stored "childId" must be a non-empty string`);
  }
  if (original.full !== undefined && typeof original.full !== "boolean") {
    return fail(`stored "full" must be a boolean when present`);
  }
  const target = original.childId;
  if (caller.childId) {
    let closed: HandoverRecord | undefined;
    try {
      closed = store.getHandover(caller.childId);
    } catch (error) {
      return fail(`cannot verify lock state for child ${JSON.stringify(caller.childId)}: ${(error as Error).message}`);
    }
    if (closed) return fail(lockedText(caller.childId));
  }
  let found: HandoverRecord | undefined;
  try {
    found = store.getHandover(target);
  } catch (error) {
    return fail(`cannot read handover for child ${JSON.stringify(target)}: ${(error as Error).message}`);
  }
  if (!found) return textResult(missingText(target));
  if (original.full === true) return textResult(fullText(found));
  return textResult(compactText(found));
}

export function createServer(store: CodexStore): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await executeTool(request.params.name, request.params.arguments, store);
    } catch (error) {
      return fail(`unexpected failure: ${(error as Error).message}`);
    }
  });
  return server;
}

async function main(): Promise<void> {
  let store: CodexStore;
  try {
    store = new CodexStore(baseDirFromEnv(process.env));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
    return;
  }
  await createServer(store).connect(new StdioServerTransport());
}

const invokedAsMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`codex server: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
