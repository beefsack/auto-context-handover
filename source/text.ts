// Fixed wording. Stage texts change only at stage boundaries; no live
// numbers, so nudges stay stable across requests.

import type { Stage } from "./measure.ts"
import {
  buildChildContinuationReply,
  buildLockedChildFollowup,
  CHILD_ROLLOVER_GUIDANCE,
  CHILD_SUMMARY_PREFIX,
  HANDOVER_SECTIONS,
  openCodeStageText,
  SEED_FRAMING,
  withChildSummaryPrefix,
} from "./shared/handover-text.ts"

const HANDOVER_LEAD = `Call this tool only after the plugin nudges you about the context limit, or when the user explicitly asks for a handover. Do not call it just to finish a task; give a normal final response instead. Once nudged, call exactly once per session when you are done with the current unit of work, then stop. Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never summarized or reworded) plus a short status/outcome/next-step summary in "summary".`

const HANDOVER_TAIL = `Do not paste secrets. What happens next depends on this session's policy, not on this call: a primary root session rotates to a fresh session seeded from your text; a subagent (child) session only stores the text, locks, and returns your short summary to its parent; with onHandover.primary=lock the session locks with no successor at all. A locked session refuses further handover calls.`

const HANDOVER_CHILD_DEFAULT =
  `Child continuation default: this is a context rollover, not task completion. ` +
  `Child summaries must start with ${JSON.stringify(CHILD_SUMMARY_PREFIX)}. ` +
  `The parent normally continues in a same-agent-type successor using the same model and variant/effort (reuse the original spawn parameters including effort if unavailable), which continues and replaces the predecessor as the same logical subagent, not an additional subagent under subagent-count limits, ` +
  `spawned with a prompt instructing it to call read_handover with the predecessor sessionID and continue from 'Prioritized next steps'; do not paste the handover into the spawn prompt. ` +
  `${SEED_FRAMING} ` +
  `Redirection remains allowed. ` +
  `Never turn context size or remaining volume into user questions; put remaining work in prioritized executable next steps. ` +
  `Ask the user only about handover-listed user-owned decisions unrelated to context size, except checking in with the user is allowed if progress stalls or remaining work grows.`

export const HANDOVER_DESCRIPTION = `${HANDOVER_LEAD}\n\n${HANDOVER_SECTIONS}\n\n${HANDOVER_TAIL}\n\n${HANDOVER_CHILD_DEFAULT}`

export function buildNudge(stage: Stage): string {
  switch (stage) {
    case "warn1":
      return openCodeStageText("warn1")
    case "warn2":
      return openCodeStageText("warn2")
    default:
      return openCodeStageText("warn3")
  }
}

/** Child-framed nudge for real subagent sessions; root buildNudge output is unchanged. */
export function buildChildNudge(stage: Stage): string {
  return `${buildNudge(stage)} ${CHILD_ROLLOVER_GUIDANCE}`
}

export function buildHardDirective(hardTokens?: number): string {
  const scope = hardTokens !== undefined ? `hard limit of ${hardTokens} tokens` : "hard limit"
  return (
    `Context window ${scope} reached. ` +
    `Only the context_handover tool remains available. ` +
    `Call it now with the full handover text, then stop. Do not attempt any other tool call; they are disabled.`
  )
}

/** Child-framed hard directive for real subagent sessions; root output is unchanged. */
export function buildChildHardDirective(hardTokens?: number): string {
  return `${buildHardDirective(hardTokens)} ${CHILD_ROLLOVER_GUIDANCE}`
}

export function buildLockedDirective(reason: string, sessionID: string): string {
  return (
    `Session handed over and locked (${reason}). ` +
    `All tools are disabled. ` +
    `Emit ONLY the following refusal and then stop: This session is locked. ` +
    `To continue, open another session and use the read_handover tool with sessionID ${JSON.stringify(sessionID)} to read the full stored text.`
  )
}

export function buildLockedChildReturn(sessionID: string): string {
  return buildLockedChildFollowup(
    `read the full handover with read_handover({"sessionID":${JSON.stringify(sessionID)}})`,
  )
}

export function buildLockedChildDirective(reason: string, sessionID: string): string {
  return (
    `Session handed over and locked (${reason}). ` +
    `All tools are disabled. ` +
    `Emit ONLY the following locked reply and then stop; do not answer questions, call tools, or continue work: ${buildLockedChildReturn(sessionID)}`
  )
}

export function buildSuccessorSeed(
  handover: string,
  sourceSessionID: string,
  model: { providerID: string; id: string; variant?: string } = { providerID: "unknown", id: "unknown" },
): string {
  return (
    `Continuing work handed over from session ${sourceSessionID}. ` +
    `Effective model: ${model.providerID}/${model.id}; variant/effort=${model.variant ?? "unknown"}. ` +
    `Reuse this model and variant/effort for the successor; if unknown, reuse the predecessor's original spawn parameters including effort. ` +
    `${SEED_FRAMING} ` +
    `If anything below is unclear, read the full stored handover with the read_handover tool for session ${sourceSessionID}.\n\n` +
    `--- handover from session ${sourceSessionID} ---\n${handover}\n--- end of handover ---`
  )
}

export function buildForwardNotice(newSessionID: string): string {
  return `Work continued in session ${newSessionID}. This session is handed over and locked; continue there.`
}

export function buildLockModeNotice(sessionID: string, reason: string): string {
  return (
    `Handover stored for session ${sessionID} and the session is locked (${reason}). ` +
    `No successor was created; the user continues here manually. ` +
    `Use the read_handover tool with sessionID ${JSON.stringify(sessionID)} to read the full stored text.`
  )
}

export function buildSubagentReturn(
  summary: string,
  sessionID: string,
  model: { providerID: string; id: string; variant?: string } = { providerID: "unknown", id: "unknown" },
): string {
  const continuation = buildChildContinuationReply(
    withChildSummaryPrefix(summary),
    `read the full handover with read_handover({"sessionID":${JSON.stringify(sessionID)}})`,
    `${model.providerID}/${model.id}; variant/effort=${model.variant ?? "unknown"}`,
  )
  return (
    `Handover stored; end your turn now with exactly the following text as your final message and then stop.\n\n${continuation}`
  )
}
