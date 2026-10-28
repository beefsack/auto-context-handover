import {
  formatDiagLine,
  openCodeStageText,
  SEED_FRAMING,
  type SoftNudgeStage,
} from "../source/shared/handover-text.ts";
import { seedTooLarge } from "../source/shared/seed-size.ts";
import type { HandoverRecord, RolloverStatus } from "./store.ts";

export const TOOL_NAMES = {
  handover: "mcp_auto_context_handover_context_handover",
  read: "mcp_auto_context_handover_read_handover",
} as const;

export const HANDOVER_INPUT_SCHEMA = {
  type: "object",
  properties: {
    handover: { type: "string" },
    summary: { type: "string" },
    capability: { type: "string", description: "Host-only binding minted by the PreToolUse hook. Never invent a value." },
  },
  required: ["handover", "summary"],
  additionalProperties: false,
} as const;

export const READ_INPUT_SCHEMA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    capability: { type: "string", description: "Host-only binding minted by the PreToolUse hook. Never invent a value." },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const;

// Counters come from the last saved session state, but tools run before the
// save, so every measurement normally lags one model response and may retain
// an older nonzero response when the latest save has no counters. Disclosed in
// every nudge and read so the lag is never mistaken for live usage.
export const LAG_DISCLOSURE =
  `Measured from the last saved session counters, which normally lag one model response because tools run before the save, and may retain an older nonzero response when the latest save has no counters.`;

export function readInvocation(sessionId: string): string {
  return `${TOOL_NAMES.read}({"sessionID":${JSON.stringify(sessionId)}})`;
}

export function titleFor(handover: string, summary: string): string {
  const firstLine = (text: string): string | undefined =>
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  const raw = firstLine(summary) ?? firstLine(handover) ?? "context handover";
  return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
}

/** Stable advisory context appended on every over-soft tool call. Never a permission decision. */
export function buildAdvisory(stage: SoftNudgeStage, estimate: number, soft: number): string {
  return (
    `Auto-context-handover is installed. See the installed workflow intro for the full handover workflow. As installed at session start: ${openCodeStageText(stage)} ` +
    `Finish the current unit of work, then call ${TOOL_NAMES.handover} with the full handover text. ` +
    `Do not start new work after this unit. ` +
    `The handover replaces any required final report for this session. ` +
    `Before storage, read-only task instructions still allow calling the handover tool because it writes only plugin storage. ` +
    `Call only after this nudge or an explicit handover request. ` +
    `${LAG_DISCLOSURE} ` +
    `Diagnostics: estimated-context-tokens=${estimate}, soft-limit=${soft}.`
  );
}

export function successorLine(successorId: string | undefined): string {
  if (successorId) return `Successor root session: ${JSON.stringify(successorId)}.`;
  return `Successor root session: unknown (creation failed or still pending; re-read the handover and roll over manually).`;
}

/** Tool backstop refusal for closed sources. Names the successor; never claims a total session stop. */
export function buildLockedReason(toolName: string, sourceId: string, successorId: string | undefined): string {
  return (
    `This session is locked after a context handover and cannot do more work. ` +
    `Denied ${toolName}. The locked caller cannot itself read; default: open a fresh live root session and read the handover with ${readInvocation(sourceId)}, ` +
    `then continue in the successor. ${successorLine(successorId)} ` +
    `This is a tool backstop only, not a total session stop.`
  );
}

/** The one successor seed: full handover once, with source backlink and title-based framing. */
export function buildSuccessorPrompt(sourceId: string, title: string, handover: string): string {
  return (
    `Context handover from source session ${JSON.stringify(sourceId)} (closed). Title: ${title}. ` +
    `The full handover follows exactly once; it is the authoritative handover, do not ask for it again. ` +
    `Source backlink for the verbatim record: ${readInvocation(sourceId)}.\n\n` +
    `Full handover:\n${handover}\n\n${SEED_FRAMING}`
  );
}

export function statusLines(status?: RolloverStatus): string {
  const successor =
    status?.successorId !== undefined
      ? `Successor root session: ${JSON.stringify(status.successorId)}.`
      : `Successor root session: unknown (creation failed or still pending; re-read the handover and roll over manually).`;
  const admitted =
    status?.admitted === true
      ? "admitted"
      : status?.admitted === false
        ? "not admitted"
        : "unknown (uncertain; inspect the successor and server before any retry; never resubmit blindly)";
  const error = status === undefined ? "unknown" : typeof status?.error === "string" && status.error.length > 0 ? status.error : "none";
  return `${successor} Admission: ${admitted}. Error: ${error}.`;
}

/** Advisory-only seed warning using the actual complete successor prompt estimate. */
export function seedWarningForPrompt(seedPrompt: string, soft: number | undefined): string | undefined {
  if (soft === undefined) return undefined;
  const estimate = Math.ceil(seedPrompt.length / 4);
  if (!seedTooLarge(estimate, soft)) return undefined;
  return (
    `Seed size warning (advisory only): successor prompt is about ${estimate} tokens (chars/4 estimate), ` +
    `over 50% of the soft limit ${soft}; compress carried finished notes at the next handover ` +
    `and keep the successor prompt minimal.`
  );
}
export function provenanceLine(record: HandoverRecord): string {
  const text = (value: string): string => (value.length > 0 ? value : "unknown");
  return (
    `Provenance: source session ${JSON.stringify(text(record.sessionId))}, ` +
    `workspace ${JSON.stringify(text(record.workspaceId))}, ` +
    `effective model ${JSON.stringify(text(record.model))} ` +
    `(recorded only; the adapter never requests model overrides, and unknown means the original was unknown).`
  );
}

export function shortReply(record: HandoverRecord, successorId: string): string {
  return (
    `Context handover stored for session ${JSON.stringify(record.sessionId)}. ` +
    `The source session is closed and cannot do more work. ` +
    `Successor root session ${JSON.stringify(successorId)} was created in the same workspace ` +
    `and the full handover was submitted to it once. ` +
    `Default: open a fresh live root session and call ${readInvocation(record.sessionId)} for the verbatim handover.`
  );
}

export function fullText(record: HandoverRecord, status?: RolloverStatus): string {
  return (
    `${provenanceLine(record)}\n` +
    `${formatDiagLine({
      reason: record.diagnostics.reason,
      stage: record.diagnostics.stage,
      estimate: record.diagnostics.estimatedTokens,
      soft: record.diagnostics.soft,
    })}\n` +
    `Measurement lag: ${LAG_DISCLOSURE}\n` +
    `Status: ${statusLines(status)}\n` +
    `${record.handover}\n\n${SEED_FRAMING}`
  );
}

export function missingText(sessionId: string): string {
  return [
    `No stored handover for session ${JSON.stringify(sessionId)}.`,
    `Diagnostics: reason=unknown, stage=unknown, estimated-context-tokens=unknown, soft-limit=unknown`,
    `Provenance: unknown.`,
  ].join("\n");
}
