// Shared six-section handover instruction text. Used byte-for-byte by the
// OpenCode HANDOVER_DESCRIPTION (see ../text.ts) and by the Claude Code child
// tool description. Node-free; no host imports. This section carries no
// session policy: no root rollover, no onHandover mode, no reader argument
// names, and no lock semantics. Each adapter adds its own call/policy framing
// around it.
export const HANDOVER_SECTIONS = `Write the handover with these sections:
1. Original instructions, role, and constraints (verbatim where it matters): role; active user scope and critical rules/prohibitions verbatim, or verified reload instructions (file/skill); permissions/tool restrictions, config scope, delegation/question/commit limits.
2. Completed work and decisions: changed files; explicit user decisions vs implicitly accepted proposals vs agent-adopted choices; separate direct verification (command/result) from others' reports (source), live observations, and unverified work.
3. In-progress work and exact current state: exact stopping point, unresolved risks, continuation/compaction status; flag history gaps.
4. Key snippets (short, copyable): only essential snippets.
5. Negative knowledge: explicit dead ends, failed approaches, what NOT to try again.
6. Prioritized next steps for the successor session: steps the successor can execute directly; reaching the context limit is not a roadblock and never a reason to ask the user; escalate only a user-owned decision that is independent of the context limit. Keep open questions explicitly; do not drop them.

State instruction deviations, triggered stop conditions, failed or erroring calls, and unverified claims plainly; never mark work PASS or complete while a deviation or triggered stop is unresolved; the summary must not claim more than the body.

Do not describe your own agent type, model (including override), or chain; the plugin records authoritative provenance and the parent uses the plugin record even if this handover says otherwise.

Prefer durable docs over repeated background; omit personal trivia; never trim unresolved risks or verification distinctions; mark unknowns rather than inventing history/controls. Keep concise and avoid repetitive prose.`

// Required first line of every child short summary and short reply.
export const CHILD_SUMMARY_PREFIX = "Context handover (incomplete):"

// Shared seed/continuation framing for every generated successor seed and
// child continuation reply. Title-based only: never a numeric "section 6".
// States the original-task reference rule, the no-repeat rule, the
// predecessor-trust rule, the verification-distinction facts rule, and the
// next-steps entry point. Adapters compose it with their exact reader
// invocation; standalone root nudge text stays unchanged.
export const SEED_FRAMING =
  `The original task is reference only; completed steps are done and must not be repeated. ` +
  `Predecessor facts are trusted unless marked unverified; preserve verification distinctions and do not recast predecessor direct evidence as successor direct verification. ` +
  `Targeted rereads of already-covered material are allowed only to resolve open questions; never repeat completed steps. ` +
  `Continue from 'Prioritized next steps'.`

// Shared child rollover guidance appended to child nudges and directives.
// Dependency-free; adapters compose it around their own stage texts.
export const CHILD_ROLLOVER_GUIDANCE =
  `This is a rollover, not completion; the parent normally continues in a successor (not guaranteed). ` +
  `The short summary must start with ${JSON.stringify(CHILD_SUMMARY_PREFIX)}. ` +
  `Put remaining work in prioritized executable next steps; never turn context size or remaining volume into user questions.`

// Shared OpenCode stage leads, byte-for-byte with the OpenCode adapter's
// fixed nudge wording. Claude child nudges reuse these leads so both
// adapters escalate at the same soft, soft*1.1, soft*1.2 boundaries.
export const OPENCODE_WARN1 =
  `Auto-context-handover notice. Context is filling. ` +
  `Finish the current unit of work, then call the context_handover tool with the full handover text. ` +
  `Do not start new work after this unit.`

export const OPENCODE_WARN2 =
  `Auto-context-handover warning. Wrap up now: complete only the step in progress, ` +
  `then call the context_handover tool with the full handover text. Starting new work risks losing state to compaction.`

export const OPENCODE_WARN3 =
  `Auto-context-handover final warning. Stop after this step and call the context_handover tool ` +
  `with the full handover text. Do not defer the handover past this response.`

export type SoftNudgeStage = "warn1" | "warn2" | "warn3"

/** Fixed stage lead shared by both adapters; OpenCode-visible text is byte-identical. */
export function openCodeStageText(stage: SoftNudgeStage): string {
  switch (stage) {
    case "warn1":
      return OPENCODE_WARN1
    case "warn2":
      return OPENCODE_WARN2
    default:
      return OPENCODE_WARN3
  }
}

/**
 * Fixed-boundary stage for integer soft thresholds: warn at soft, then
 * soft*(1+0.1), soft*(1+0.2). Mirrors the OpenCode default offsets;
 * expressions match measure.stageOf so boundaries are identical.
 */
export function softStage(estimate: number, soft: number): "ok" | SoftNudgeStage {
  if (estimate >= soft * (1 + 0.2)) return "warn3"
  if (estimate >= soft * (1 + 0.1)) return "warn2"
  if (estimate >= soft * (1 + 0)) return "warn1"
  return "ok"
}

/** Prefix a child short summary once; empty summaries fall back to a stored marker. */
export function withChildSummaryPrefix(summary: string): string {
  const clean = summary.trim()
  if (clean.startsWith(CHILD_SUMMARY_PREFIX)) return clean
  return `${CHILD_SUMMARY_PREFIX} ${clean || "handover stored."}`
}

/**
 * Shared child continuation reply. The reader invocation is
 * adapter-specific (exact tool call with the adapter's ID argument).
 */
export function buildChildContinuationReply(headedSummary: string, readerInvocation: string): string {
  return (
    `${headedSummary}\n\nTask is NOT complete; this is a context rollover. ` +
    `Default: ${readerInvocation}, ` +
    `spawn a successor of the same agent type, ` +
    `seed it with the original task pointer and the full handover. ` +
    `${SEED_FRAMING} ` +
    `The parent may redirect; ask the user only about handover-listed user-owned decisions unrelated to context size.`
  )
}

/**
 * Shared locked-child follow-up. Distinct from the initial continuation
 * reply: states the lock after a context handover, refuses questions and
 * further work, then prescribes the exact reader call and a successor or
 * fresh subagent. Keeps the incomplete prefix and same-agent successor
 * default. Adapter supplies the exact reader invocation.
 */
export function buildLockedChildFollowup(readerInvocation: string): string {
  return (
    `${CHILD_SUMMARY_PREFIX} This subagent session is locked after a context handover and cannot answer questions or do more work. ` +
    `Default: ${readerInvocation}, ` +
    `spawn a successor of the same agent type (or a fresh subagent to investigate and continue), ` +
    `seed it with the original task pointer and the full handover. ` +
    `${SEED_FRAMING} ` +
    `The parent may redirect; ask the user only about handover-listed user-owned decisions unrelated to context size.`
  )
}

export interface HandoverDiag {
  readonly reason?: unknown
  readonly stage?: unknown
  readonly estimate?: unknown
  readonly soft?: unknown
}

/** One labelled diagnostics header line for read_handover output. Unknown when unavailable. */
export function formatDiagLine(diag?: HandoverDiag): string {
  const text = (value: unknown): string =>
    typeof value === "string" && value.length > 0 ? value : "unknown"
  const num = (value: unknown): string =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(Math.floor(value)) : "unknown"
  return `Diagnostics: reason=${text(diag?.reason)}, stage=${text(diag?.stage)}, estimated-context-tokens=${num(diag?.estimate)}, soft-limit=${num(diag?.soft)}`
}
