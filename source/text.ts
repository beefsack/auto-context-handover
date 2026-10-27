// Fixed wording. Stage texts change only at stage boundaries; no live
// numbers, so nudges stay stable across requests.

import type { Stage } from "./measure.ts"

export const HANDOVER_DESCRIPTION = `Call this tool only after the plugin nudges you about the context limit, or when the user explicitly asks for a handover. Do not call it just to finish a task; give a normal final response instead. Once nudged, call exactly once per session when you are done with the current unit of work, then stop. Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never summarized or reworded) plus a short status/outcome/next-step summary in "summary".

Write the handover with these sections:
1. Original instructions, role, and constraints (verbatim where it matters): role; active user scope and critical rules/prohibitions verbatim, or verified reload instructions (file/skill); agent, provider/model/variant, permissions/tool restrictions, config scope, delegation/question/commit limits.
2. Completed work and decisions: changed files; explicit user decisions vs implicitly accepted proposals vs agent-adopted choices; separate direct verification (command/result) from others' reports (source), live observations, and unverified work.
3. In-progress work and exact current state: exact stopping point, unresolved risks, continuation/compaction status, known predecessor session ID chain; flag history gaps.
4. Key snippets (short, copyable): only essential snippets.
5. Negative knowledge: explicit dead ends, failed approaches, what NOT to try again.
6. Prioritized next steps for the successor session.

Prefer durable docs over repeated background; omit personal trivia; never trim unresolved risks or verification distinctions; mark unknowns rather than inventing history/controls. Keep concise and avoid repetitive prose.

Do not paste secrets. What happens next depends on this session's policy, not on this call: a primary root session rotates to a fresh session seeded from your text; a subagent (child) session only stores the text, locks, and returns your short summary to its parent; with onHandover.primary=lock the session locks with no successor at all. A locked session refuses further handover calls.`

export function buildNudge(stage: Stage): string {
  switch (stage) {
    case "warn1":
      return (
        `Auto-context-handover notice. Context is filling. ` +
        `Finish the current unit of work, then call the context_handover tool with the full handover text. ` +
        `Do not start new work after this unit.`
      )
    case "warn2":
      return (
        `Auto-context-handover warning. Wrap up now: complete only the step in progress, ` +
        `then call the context_handover tool with the full handover text. Starting new work risks losing state to compaction.`
      )
    default:
      return (
        `Auto-context-handover final warning. Stop after this step and call the context_handover tool ` +
        `with the full handover text. Do not defer the handover past this response.`
      )
  }
}

export function buildHardDirective(hardTokens?: number): string {
  const scope = hardTokens !== undefined ? `hard limit of ${hardTokens} tokens` : "hard limit"
  return (
    `Context window ${scope} reached. ` +
    `Only the context_handover tool remains available. ` +
    `Call it now with the full handover text, then stop. Do not attempt any other tool call; they are disabled.`
  )
}

export function buildLockedDirective(reason: string): string {
  return (
    `Session handed over and locked (${reason}). ` +
    `All tools are disabled. Stop here and wait for the user; do not continue work in this session.`
  )
}

export function buildSuccessorSeed(handover: string, sourceSessionID: string): string {
  return (
    `Continuing work handed over from session ${sourceSessionID}. ` +
    `If anything below is unclear, read the full stored handover with the read_handover tool for session ${sourceSessionID}.\n\n` +
    `--- handover from session ${sourceSessionID} ---\n${handover}\n--- end of handover ---`
  )
}

export function buildForwardNotice(newSessionID: string): string {
  return `Work continued in session ${newSessionID}. This session is handed over and locked; continue there.`
}

export function buildLockedFinalReply(reason: string, finalReply: string): string {
  return (
    `Session handed over and locked (${reason}). ` +
    `Emit ONLY the following short final reply and then stop; do not call any tools or continue work: ${finalReply}`
  )
}

export function buildLockModeNotice(sessionID: string, reason: string): string {
  return (
    `Handover stored for session ${sessionID} and the session is locked (${reason}). ` +
    `No successor was created; the user continues here manually. ` +
    `Use the read_handover tool with sessionID ${JSON.stringify(sessionID)} to read the full stored text.`
  )
}

export function buildSubagentReturn(summary: string, sessionID: string): string {
  return (
    `${summary}\n\nHandover stored for subagent session ${sessionID}. ` +
    `Use the read_handover tool with sessionID ${JSON.stringify(sessionID)} to read the full text. ` +
    `This session ends here; the parent agent decides how to continue.`
  )
}
