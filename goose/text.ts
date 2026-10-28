import {
  formatDiagLine,
  HANDOVER_SECTIONS,
  openCodeStageText,
  SEED_FRAMING,
  type SoftNudgeStage,
} from "../source/shared/handover-text.ts";
import { seedTooLarge } from "../source/shared/seed-size.ts";
import type { HandoverRecord } from "./store.ts";

// Model-visible names under the release plugin extension
// `auto-context-handover:auto-context-handover` (plugin.json name plus the
// `.mcp.json` server name). Goose exposes stdio extension tools as
// `<extkey>__<tool>` where extkey is name_to_key(extension name): ASCII
// alphanumerics plus `-`/`_` preserved, whitespace removed, every other byte
// (including `:`) replaced with `_`, then lowercased. The server also accepts
// the bare form.
export const TOOL_NAMES = {
  handover: "auto-context-handover_auto-context-handover__context_handover",
  read: "auto-context-handover_auto-context-handover__read_handover",
} as const;

export const HANDOVER_INPUT_SCHEMA = {
  type: "object",
  properties: {
    handover: { type: "string" },
    summary: { type: "string" },
  },
  required: ["handover", "summary"],
  additionalProperties: false,
} as const;

export const READ_INPUT_SCHEMA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const;

// Counters come from the last persisted provider report, not a live request
// measurement. Disclosed in every denial and read so the lag is never
// mistaken for live usage.
export const LAG_DISCLOSURE =
  `Measured from the last persisted provider report (usage.total_tokens, else input+output; cache subsets never added), ` +
  `not a live request measurement; changes since that report are omitted. ` +
  `The cumulative accumulated_usage ledger is billing history, not context pressure, and is ignored.`;

export function readInvocation(sessionId: string): string {
  return `${TOOL_NAMES.read}({"sessionID":${JSON.stringify(sessionId)}})`;
}

/** Stop-gate denial: one policy block per turn-end attempt, model-visible. */
export function buildStopDenial(
  stage: SoftNudgeStage,
  sessionId: string,
  estimate: number,
  soft: number,
): string {
  return (
    `${openCodeStageText(stage)} ` +
    `The user enabled this installed plugin's Stop-denial workflow. A unit means only the step in progress, not the whole task. ` +
    `Finish the current unit of work, then call ${TOOL_NAMES.handover} with the full handover text. ` +
    `Do not start new work after this unit. ` +
    `The handover replaces any required final report for this session. ` +
    `Before storage, read-only task instructions still allow calling the handover tool because it writes only plugin storage. ` +
    `Call only after this denial or an explicit handover request. ` +
    `${LAG_DISCLOSURE} ` +
    `Diagnostics: estimated-context-tokens=${estimate}, soft-limit=${soft}. ` +
    `Attribution: source root session ${JSON.stringify(sessionId)}. ` +
    `After the call, end your turn with exactly the receipt text it returns as your final native message and then stop. ` +
    `There is no automatic continuation: a fresh session must be opened manually and continue with ` +
    `${readInvocation(sessionId)}; never resume this session for new work.`
  );
}

export function provenanceLine(record: HandoverRecord): string {
  const text = (value: string): string => (value.length > 0 ? value : "unknown");
  return (
    `Provenance: source root session ${JSON.stringify(text(record.sessionId))}, ` +
    `effective model ${JSON.stringify(text(record.model))} ` +
    `(recorded from the native session export only; unknown means the export carried none).`
  );
}

export function shortReceipt(record: HandoverRecord): string {
  return (
    `Context handover stored for session ${JSON.stringify(record.sessionId)}. ` +
    `End your turn with exactly this receipt as your final native message and then stop ` +
    `(advisory only: nothing is locked and no successor was created). ` +
    `Manual continuation default: open a fresh session and call ${readInvocation(record.sessionId)} for the verbatim handover.`
  );
}

export function fullText(record: HandoverRecord): string {
  return (
    `${provenanceLine(record)}\n` +
    `${formatDiagLine({
      reason: record.diagnostics.reason,
      stage: record.diagnostics.stage,
      estimate: record.diagnostics.estimatedTokens,
      soft: record.diagnostics.soft,
    })}\n` +
    `Measurement lag: ${LAG_DISCLOSURE}\n` +
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

/** Advisory-only seed warning using the manual-continuation payload estimate. */
export function seedWarningForRecord(record: HandoverRecord): string | undefined {
  const soft = record.diagnostics.soft;
  if (soft === undefined) return undefined;
  const estimate = Math.ceil(`${record.handover}\n\n${SEED_FRAMING}`.length / 4);
  if (!seedTooLarge(estimate, soft)) return undefined;
  return (
    `Seed size warning (advisory only): manual-continuation payload is about ${estimate} tokens (chars/4 estimate), ` +
    `over 50% of the soft limit ${soft}; compress carried finished notes at the next handover ` +
    `and keep the continuation prompt minimal.`
  );
}

export const SESSION_BANNER =
  `Auto-context-handover (goose) installed. Root sessions only: call ${TOOL_NAMES.handover} after a context notice ` +
  `or an explicit handover request; read any stored handover with ${TOOL_NAMES.read}. ` +
  `A context Stop gate is active only when AUTO_CONTEXT_HANDOVER_GOOSE_STOP=1. ` +
  `Stored handovers never auto-continue; open a fresh session and read back manually.`;
