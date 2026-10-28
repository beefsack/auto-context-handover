// Claude Code child-adapter pieces (Node-free; imported by hooks/ only).
//
// The six-section handover instruction text is shared byte-for-byte with the
// OpenCode description (see ../source/shared/handover-text.ts). Threshold
// parsing reuses parseThreshold from ../source/shared/threshold.ts, and the
// staged nudge leads plus fixed soft boundaries reuse openCodeStageText and
// softStage from ../source/shared/handover-text.ts. The child adapter needs
// only an integer soft threshold (no window, no cap, no percentages: the
// child window is unknown) with staged escalation at soft, soft*1.1,
// soft*1.2.
//
// The child tool description carries no OpenCode policy: no primary root
// rollover, no onHandover mode, no sessionID reader, and no locked-root
// semantics. After the handover is stored the child calls SubagentHandback
// with the stored short reply as its final delivery and then stops; plain
// text is a last-resort fallback only when SubagentHandback is absent since
// plain-text finals may not reach the parent on the native handback path.
// It never synthesizes a bypass.

import { parseThreshold, type ThresholdSpec } from "../source/shared/threshold.ts"
import { seedTooLarge } from "../source/shared/seed-size.ts"
import {
  CHILD_ROLLOVER_GUIDANCE,
  CHILD_SUMMARY_PREFIX,
  HANDOVER_SECTIONS,
  openCodeStageText,
  SEED_FRAMING,
  softStage,
  withChildSummaryPrefix,
  type HandoverDiag,
  type SoftNudgeStage,
} from "../source/shared/handover-text.ts"

export { HANDOVER_SECTIONS, CHILD_SUMMARY_PREFIX, softStage, openCodeStageText, type SoftNudgeStage }
export type ClaudeChildStage = SoftNudgeStage

export const PLUGIN_NAME = "auto-context-handover"
export const HANDOVER_TOOL = "context_handover"
export const READ_TOOL = "read_handover"
export const HANDOVER_FULL = `mcp__${PLUGIN_NAME}__${HANDOVER_TOOL}`
export const READ_FULL = `mcp__${PLUGIN_NAME}__${READ_TOOL}`

/** Short successor marker tag. The full marker is `[auto-context-handover:continue child:<id>]`. */
export const SUCCESSOR_MARKER_TAG = "auto-context-handover:continue"

/** Default child soft threshold in tokens. Uncapped: the child window is unknown. */
export const CHILD_DEFAULT_SOFT = 150000

/** Start-of-task introduction for `classic.SubagentStart` additionalContext: who installed the plugin and what to do when a notice arrives. */
export function buildClaudeChildIntro(): string {
  return (
    `The user installed and configured the auto-context-handover plugin to limit context usage with handovers instead of compaction. ` +
    `After a batch of tool calls, a notice may appear next to a tool result when your context passes the user's configured limit. ` +
    `When you receive one, finish the current step, load ${HANDOVER_FULL} via ToolSearch select:${HANDOVER_FULL} for its schema/template (its description is invisible until loaded), ` +
    `call it with the full handover text, then deliver via SubagentHandback and stop. ` +
    `Plain text is a last resort only when the SubagentHandback tool is absent; plain-text finals may not reach your parent on the native handback path. ` +
    `That notice overrides task final-report/output instructions for this step only; before the handover is stored, writing plugin storage is allowed under read-only task instructions. ` +
    `After the handover is stored, call only SubagentHandback and stop; do not call any other tools. ` +
    `If your task starts with an [${SUCCESSOR_MARKER_TAG} child:<id>] marker, first call ${READ_FULL} for that child id to load the full handover and the original task. ` +
    `The original task is reference only; completed steps are done and must not be repeated; predecessor facts are trusted unless marked unverified. ` +
    `Your parent receives the full handover intact via ${READ_FULL} and continues the work.`
  )
}

/** Unified parent discretion: usual ask-only, with a stall/scope-growth check-in exception. No generation cap. */
export const PARENT_DISCRETION =
  `ask the user only about handover-listed user-owned decisions unrelated to context size, ` +
  `except checking in with the user is allowed if progress stalls or remaining work grows`

/** Concise static root introduction for context only, no measurement or gating. */
export function buildClaudeRootIntro(): string {
  return (
    `The user installed and configured the auto-context-handover plugin for subagent context handovers; root native compaction is unchanged. ` +
    `When a subagent returns a "${CHILD_SUMMARY_PREFIX}" reply, read the full handover via ${READ_FULL}, ` +
    `then start a successor of the same agent type with the same model override, ` +
    `spawned with the reader's short successor prompt VERBATIM ` +
    `(marker plus reader instruction to continue from 'Prioritized next steps'; do not paste the handover or original task), ` +
    `without confirmation as the user's configured default; you may append redirection after the prompt. ` +
    `The original task is reference only; completed steps are done and must not be repeated; predecessor facts are trusted unless marked unverified. ` +
    `If a subagent ends without a delivered report, call ${READ_FULL} with its child id BEFORE messaging or resuming it; ` +
    `a stored handover counts as a reply. Never SendMessage to or resume a handed-over subagent; start a successor instead, ` +
    `which continues and replaces the predecessor as the same logical subagent and does not count as additional under subagent-count limits. ` +
    `The readback shows generation, predecessor chain, next-step count, and seed-size diagnostics; if the seed exceeds 50% of soft, ask the child to compress carried-over finished notes. ` +
    `${READ_BEFORE_DECISION} ` +
    `Ask the user only about handover-listed user-owned decisions; checking in is allowed if progress stalls or remaining work grows. ` +
    `Never ask about context size.`
  )
}

/** Staged notice: OpenCode stage lead plus the fallback essentials, pointing at the start-of-task introduction for details. */
export function buildClaudeChildNudge(stage: ClaudeChildStage): string {
  return (
    `${openCodeStageText(stage)} ` +
    `This auto-context-handover notice (see the plugin introduction at the start of this task) ` +
    `overrides task final-report/output instructions for this step. ` +
    `Load ${HANDOVER_FULL} via ToolSearch select:${HANDOVER_FULL}, ` +
    `then call ${HANDOVER_FULL} with the full handover text, then deliver via SubagentHandback and stop. ` +
    `Plain text is a last resort only when the SubagentHandback tool is absent; plain-text finals may not reach the parent on the native handback path. ` +
    `"Unit of work" means the current step, not the whole task. ` +
    `The full handover reaches the parent intact via ${READ_FULL}. ` +
    CHILD_ROLLOVER_GUIDANCE
  )
}

const CHILD_PREAMBLE =
  `Only call this tool in a subagent (child) loop, and only after the plugin nudges you about the context limit or when the user explicitly asks for a handover. ` +
  `The model running this child writes the full handover content and summary, then stops. ` +
  `The summary must start with ${JSON.stringify(CHILD_SUMMARY_PREFIX)}. ` +
  `In the summary include a line "User decisions pending: none" or "User decisions pending: <list>". ` +
  `This is a context rollover, not task completion; put remaining work in prioritized executable next steps and never turn context size or remaining volume into user questions. ` +
  `Do not paste secrets. Root sessions must never call it.`

const CHILD_AFTER =
  `After the tool reports the handover as stored, call SubagentHandback with the short reply it returned as your final delivery and then stop; call only SubagentHandback, do not call any other tools or continue work. ` +
  `A plain-text final may not reach your parent on the native handback path and does not count as delivery; plain text is a last resort only when the SubagentHandback tool is absent. ` +
  `The short reply starts with ${JSON.stringify(CHILD_SUMMARY_PREFIX)}; never turn context size or remaining volume into user questions. ` +
  `This is a rollover, not completion; the parent normally continues in a successor of the same agent type (not guaranteed), spawned with the reader's short successor prompt VERBATIM (marker plus reader instruction to continue from 'Prioritized next steps'). ` +
  `The original task is reference only; completed steps are done and must not be repeated; predecessor facts are trusted unless marked unverified; preserve verification distinctions and do not recast predecessor direct evidence as successor direct verification. ` +
  `The adapter forwards the SubagentHandback message; host delivery and any classifier review are observed only through the tool result. ` +
  `Never synthesize a separate report that bypasses classification.`

/** Child-only tool description: preamble plus the shared six-section handover text plus stored-handover guidance. */
export const CHILD_HANDOVER_DESCRIPTION = `${CHILD_PREAMBLE}\n\n${HANDOVER_SECTIONS}\n\n${CHILD_AFTER}`

export const CHILD_READ_DESCRIPTION =
  `Read the full stored handover text for a subagent child (a parent agent can read a child's handover, and any live session can read a locked one's; a successor child can read its predecessor's handover by childId). ` +
  `Takes childId: the child agent id from the short reply. Returns header lines (generation, predecessor chain, next-step count, seed-size diagnostics), ` +
  `the original task prompt verbatim once, the handover verbatim once, and the short successor prompt (marker prefix plus exact reader instruction). ` +
  `Fails when no handover was stored for that id. Missing or malformed lineage reports unknown origin honestly. The plugin store record is independent of compaction.`

/** Integer-only soft threshold. Percentages are rejected: no child window to resolve them against. */
export function parseChildSoft(value: unknown): number {
  let spec: ThresholdSpec
  try {
    spec = parseThreshold(value)
  } catch {
    throw new Error(
      `child soft threshold must be a positive integer of tokens (no percentages; the child window is unknown), got ${JSON.stringify(value)}`,
    )
  }
  if (spec.kind !== "tokens") {
    throw new Error(
      `child soft threshold must be a positive integer of tokens (no percentages; the child window is unknown), got ${JSON.stringify(value)}`,
    )
  }
  return spec.tokens
}

export function childRecordKey(agentId: string): string {
  return `child:${agentId}`
}

/**
 * Observed spawn provenance. `agentType` undefined means unknown (no spawn or
 * SubagentStart observed, reload, storage outage, or malformed input).
 * `modelOverride` undefined means unknown; null means observed with no
 * override (model field absent, so agent default then parent applies);
 * a string is the requested override alias/id. Never the effective result
 * model, usage model, or root model, and never rewritten.
 * Lineage fields are observe-only: `predecessorAgentId` is the short-marker
 * predecessor parsed from the spawn prompt; `originAgentId` is the chain
 * origin (first generation); `generation` is 1 for origins, predecessor + 1
 * for successors, undefined when unknown (legacy/malformed/missing).
 */
export interface SpawnProvenance {
  readonly agentType?: string
  readonly modelOverride?: string | null
  readonly predecessorAgentId?: string
  readonly originAgentId?: string
  readonly generation?: number
  /** Bounded original-capture failure text persisted when the original write is rejected. Memory first, store fallback. */
  readonly originalCaptureError?: string
}

export function isSpawnProvenance(value: unknown): value is SpawnProvenance {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  if (record.agentType !== undefined && typeof record.agentType !== "string") return false
  if (record.modelOverride !== undefined && record.modelOverride !== null && typeof record.modelOverride !== "string") return false
  if (record.predecessorAgentId !== undefined && typeof record.predecessorAgentId !== "string") return false
  if (record.originAgentId !== undefined && typeof record.originAgentId !== "string") return false
  if (record.generation !== undefined && (typeof record.generation !== "number" || !Number.isInteger(record.generation) || record.generation < 1)) return false
  if (record.originalCaptureError !== undefined && typeof record.originalCaptureError !== "string") return false
  return true
}

/** Short successor marker tag is declared near the top (used by intros above). */

/** Build the short successor pointer marker for a predecessor child id. */
export function buildSuccessorMarker(predecessorAgentId: string): string {
  return `[${SUCCESSOR_MARKER_TAG} child:${predecessorAgentId}]`
}

export type MarkerStatus = "absent" | "valid" | "malformed"

export interface ClassifiedMarker {
  readonly status: MarkerStatus
  readonly predecessor?: string
}

const MARKER_ID = String.raw`([^\s\[\]]+)`
const VALID_MARKER = new RegExp(String.raw`^\s*\[auto-context-handover:continue\s+child:${MARKER_ID}\]`)
const RESERVED_MARKER_PREFIX = /^\s*\[auto-context-handover:continue/

/**
 * Classify a spawn prompt by its leading marker. Only a marker at the start
 * (optional leading whitespace) counts; quoted or mid-text occurrences are
 * absent. A reserved prefix that fails the valid shape is malformed, never a
 * new origin. The id is any non-whitespace, non-bracket run.
 */
export function classifySuccessorMarker(prompt: unknown): ClassifiedMarker {
  if (typeof prompt !== "string" || prompt.length === 0) return { status: "absent" }
  const valid = VALID_MARKER.exec(prompt)
  if (valid?.[1] !== undefined) return { status: "valid", predecessor: valid[1] }
  if (RESERVED_MARKER_PREFIX.test(prompt)) return { status: "malformed" }
  return { status: "absent" }
}

/**
 * Parse the short successor marker from an observed spawn prompt. Returns the
 * predecessor child id for a leading valid marker, else undefined (absent or
 * malformed are both unknown; use classifySuccessorMarker to tell them apart).
 */
export function parseSuccessorMarker(prompt: unknown): string | undefined {
  const classified = classifySuccessorMarker(prompt)
  return classified.status === "valid" ? classified.predecessor : undefined
}

/** Minimal spawn metadata keyed by child id so a reload retains provenance for the eventual ChildRecord. */
export function spawnRecordKey(agentId: string): string {
  return `spawn:${agentId}`
}

/** Original task prompt keyed by chain origin id. Stored once per chain; successors inherit by reference. */
export function originalRecordKey(originAgentId: string): string {
  return `original:${originAgentId}`
}

export interface OriginalRecord {
  readonly prompt: string
  readonly originAgentId: string
  readonly storedAt: number
}

export function isOriginalRecord(value: unknown): value is OriginalRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.prompt === "string" &&
    record.prompt.length > 0 &&
    typeof record.originAgentId === "string" &&
    record.originAgentId.length > 0
  )
}

export function formatAgentTypeReadback(agentType?: string): string {
  return agentType !== undefined && agentType.length > 0
    ? `(recorded: ${agentType})`
    : `(recorded: unknown, use predecessor spawn params)`
}

export function formatModelOverrideReadback(modelOverride?: string | null): string {
  if (typeof modelOverride === "string" && modelOverride.length > 0) return `(recorded: ${modelOverride})`
  if (modelOverride === null) return `(recorded: no override)`
  return `(recorded: unknown, use predecessor spawn params)`
}

/** Required read-before-decision sentence for every Claude short reply. */
export const READ_BEFORE_DECISION = `Read the handover before replying to the user or making any decision about the task.`

export function buildProvenanceReadback(provenance?: SpawnProvenance): string {
  return (
    `Start a successor of the same agent type ${formatAgentTypeReadback(provenance?.agentType)} ` +
    `with the same model override ${formatModelOverrideReadback(provenance?.modelOverride)}.`
  )
}

export interface ChildRecord {
  readonly handover: string
  readonly summary: string
  readonly agentId: string
  readonly parentSessionId: string | undefined
  readonly shortReply: string
  readonly closed: true
  readonly storedAt: number
  /** Native SubagentHandback delivery observed: true delivered, false stored without delivery, absent unknown (legacy/reload). */
  readonly handbackDelivered?: boolean
  readonly diag?: ChildDiag
  /** Turn observed at handover time; unknown for legacy records. */
  readonly handoverTurnId?: string
  /** Exposed spawn agent type; unknown (absent) for legacy/reload records. */
  readonly agentType?: string
  /** Requested spawn model override; absent means unknown, null means observed no override. */
  readonly modelOverride?: string | null
  /** Short-marker predecessor child id; absent means origin or unknown (legacy/missing). */
  readonly predecessorAgentId?: string
  /** Chain origin child id; absent means unknown origin (legacy/malformed/missing). */
  readonly originAgentId?: string
  /** Generation number: 1 for origins, predecessor + 1 for successors; absent when unknown. No fixed cap. */
  readonly generation?: number
}

export type ChildDiag = HandoverDiag

export function isChildRecord(value: unknown): value is ChildRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.handover === "string" &&
    typeof record.summary === "string" &&
    typeof record.agentId === "string" &&
    typeof record.shortReply === "string" &&
    record.closed === true
  )
}

const stripBold = (text: string): string => {
  let out = text.trim()
  if (out.startsWith("**") && out.endsWith("**") && out.length >= 4) out = out.slice(2, -2).trim()
  return out
}

/** True for a "Prioritized next steps" heading: optional #/number/bold, title, optional successor suffix, optional colon. */
export function isNextStepsHeading(line: string): boolean {
  let text = line.trim().replace(/^#{1,6}\s+/, "").trim()
  text = stripBold(text).replace(/^\d+\s*[.)]\s+/, "").trim()
  text = stripBold(text)
  // Tolerate one trailing parenthetical, e.g. "... successor (short)".
  text = text.replace(/\s*\([^()]*\)\s*:?\s*$/, (m) => (m.includes(":") ? ":" : "")).trim()
  text = stripBold(text)
  return /^prioritized next steps(?:\s+for\s+the\s+successor(?:\s+session)?)?\s*:?$/i.test(text)
}

/** True for a column-zero numbered or bullet item. Indented lines are nested continuations, never steps. */
function isTopLevelItem(line: string): boolean {
  return /^(?:\d+[.)]|[-*+])\s+\S/.test(line)
}

/** True for a clear section boundary: ATX heading, full-line bold title, or rule. Numbered lines always count as steps, never as boundaries. */
function isHeadingBoundary(line: string): boolean {
  const text = line.trim()
  if (/^#{1,6}\s+\S/.test(text)) return true
  if (/^\*\*.+\*\*$/.test(text)) return true
  return /^(---+|___+|\*\*\*+)\s*$/.test(text)
}

/**
 * Count executable next steps under the "Prioritized next steps" heading.
 * Numbered (`1.`/`1)`) and bullet (`-`/`*`/`+`) items at column zero count;
 * a short final step still counts (it is never a boundary). Stops at a clear
 * heading boundary or the end. Returns undefined when the heading is absent,
 * when nothing follows it (truncated), or when a non-item, non-boundary line
 * or a later item after a boundary makes the count ambiguous: unknown, never
 * a partial count. No line or step caps.
 */
export function countNextSteps(handover: string): number | undefined {
  if (typeof handover !== "string" || handover.length === 0) return undefined
  const lines = handover.split("\n")
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (isNextStepsHeading(lines[i] ?? "")) {
      start = i
      break
    }
  }
  if (start < 0) return undefined
  const rest = lines.slice(start + 1)
  if (rest.every((line) => line.trim() === "")) return undefined
  let count = 0
  let stopped = false
  for (const line of rest) {
    if (stopped) {
      if (isTopLevelItem(line)) return undefined
      continue
    }
    if (line.trim() === "") continue
    if (isTopLevelItem(line)) {
      count++
      continue
    }
    if (/^\s/.test(line)) continue
    if (isHeadingBoundary(line)) {
      stopped = true
      continue
    }
    return undefined
  }
  return count
}

/** Rough token estimate for seed-size diagnostics: ceil(chars/4), matching measure.ts trailing estimate. */
export function estimateSeedTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Shared seed-size boundary (canonical in source/shared/seed-size.ts); aliased here for hooks callers. Warns, never blocks. */
export const isSeedTooLarge = seedTooLarge

/** Seed-size diagnostics line with compress advice when over half of soft. Stored text is never rewritten. */
export function buildSeedSizeLine(seedEstimate: number, softTokens: number): string {
  if (isSeedTooLarge(seedEstimate, softTokens)) {
    return (
      `Seed size: ~${seedEstimate} tokens vs soft ${softTokens} (over 50%). ` +
      `Ask the child to compress carried-over finished notes on the next handover; do not rewrite stored text.`
    )
  }
  return `Seed size: ~${seedEstimate} tokens vs soft ${softTokens}.`
}

/** Human-readable origin status: explicit unknown for legacy/malformed/missing, never a memory placeholder. */
export function formatOriginReadback(originAgentId?: string): string {
  if (typeof originAgentId === "string" && originAgentId.length > 0) return `(origin: ${originAgentId})`
  return `(origin: unknown legacy origin)`
}

/** Generation and predecessor chain line. Unknown when lineage is absent. No fixed cap. */
export function buildGenerationLine(record: Pick<ChildRecord, "agentId" | "predecessorAgentId" | "originAgentId" | "generation">, nextSteps?: number): string {
  const generation = typeof record.generation === "number" ? `generation ${record.generation}` : `generation unknown`
  const predecessor = typeof record.predecessorAgentId === "string" && record.predecessorAgentId.length > 0
    ? `predecessor ${record.predecessorAgentId}`
    : `predecessor none/unknown`
  const origin = formatOriginReadback(record.originAgentId)
  const steps = typeof nextSteps === "number" ? `next steps: ${nextSteps}` : `next steps: unknown`
  return `Chain: ${generation}, ${predecessor}, ${origin}, ${steps}.`
}

/** Successor-facing guidance: shared seed framing (reference rule, no-repeat, predecessor-trust, verification distinctions, next-steps entry) plus handback delivery. */
export const SUCCESSOR_GUIDANCE =
  `${SEED_FRAMING} ` +
  `Deliver the final report via SubagentHandback; plain text is a last resort only when the SubagentHandback tool is absent.`

/** Parent-to-spawn successor prompt: the short marker prefix first (so a pasted prompt still links), then the exact reader call and next-steps instruction. No spawn/redirect orders to the successor itself; the parent appends redirection in its own prompt heading. */
export function buildSuccessorPointer(predecessorAgentId: string): string {
  const marker = buildSuccessorMarker(predecessorAgentId)
  const invocation = `${READ_FULL}({"childId":${JSON.stringify(predecessorAgentId)}})`
  return (
    `${marker} First call ${invocation} to load the full handover and the original task, then continue from 'Prioritized next steps'.`
  )
}

export function buildChildShortReply(summary: string, agentId: string, provenance?: SpawnProvenance): string {
  // Concise Claude-only reply: the headed summary, then parent read-first
  // with the exact reader call, same type/override, and the VERBATIM reader
  // pointer described but not reproduced (the reader provides it). Reference
  // framing lives in the reader output, not here. Keeps the incomplete
  // prefix, rollover framing, redirect, and ask-only rules.
  const headed = withChildSummaryPrefix(summary)
  return (
    `${headed}\n\nTask is NOT complete; this is a context rollover. ` +
    `First call ${READ_FULL}({"childId":${JSON.stringify(agentId)}}) to read the full handover. ` +
    `${READ_BEFORE_DECISION} ` +
    `Then start a successor of the same agent type ${formatAgentTypeReadback(provenance?.agentType)} ` +
    `with the same model override ${formatModelOverrideReadback(provenance?.modelOverride)}, ` +
    `spawned with the reader's short successor prompt VERBATIM ` +
    `(marker plus reader instruction to continue from 'Prioritized next steps'; do not paste the handover or original task). ` +
    `The parent may redirect; ${PARENT_DISCRETION}.`
  )
}

/** Persisted native-delivery status value for the diagnostics line. Unknown for legacy records. */
export function formatHandbackDeliveredValue(delivered?: unknown): "yes" | "no" | "unknown" {
  if (delivered === true) return "yes"
  if (delivered === false) return "no"
  return "unknown"
}

/** Persisted native-delivery status line. Unknown for legacy records. */
export function formatHandbackDelivered(delivered?: unknown): string {
  return `Handback delivered: ${formatHandbackDeliveredValue(delivered)}`
}

/** Child-addressed stored instruction returned by the handover tool: handback call first, short reply retained. */
export function buildHandoverStoredInstruction(shortReply: string): string {
  return (
    `Handover stored. Call SubagentHandback now with the report below as your final delivery and then stop; do not call any other tools or continue work. ` +
    `The adapter forwards your SubagentHandback message carrying the stored short reply below; host delivery and any classifier review are observed only through the tool result, never claimed here. ` +
    `A plain-text final may not reach your parent on the native handback path and does not count as delivery. ` +
    `Plain text is a last resort only when the SubagentHandback tool is absent.\n\n${shortReply}`
  )
}

/** Ready-to-paste successor seed: VERBATIM handover, original-task reference, successor guidance, reader-first pointer, handback delivery. */
export function buildClaudeSuccessorSeed(childId: string, handover: string, provenance?: SpawnProvenance): string {
  const agentType = provenance?.agentType || "unknown - use predecessor spawn params"
  const modelOverride = provenance?.modelOverride === null
    ? "no override"
    : provenance?.modelOverride || "unknown - use predecessor spawn params"
  return (
    `Continuing work handed over from subagent ${childId} (agent type: ${agentType}; model override: ${modelOverride}).\n` +
    `Original task: reference only (load it via ${READ_FULL}({"childId":${JSON.stringify(childId)}}) alongside this handover; do not repeat completed steps).\n\n` +
    `--- handover from subagent ${childId} (VERBATIM, do not paraphrase) ---\n${handover}\n--- end of handover ---\n\n` +
    `${SUCCESSOR_GUIDANCE}\n\n` +
    `${buildSuccessorPointer(childId)} ` +
    `When this work is handed over, call ${HANDOVER_FULL} with the full handover text, then deliver via SubagentHandback and stop.`
  )
}

/** Successor-facing payload: original once, handover once, guidance, pointer. The seed estimate measures this exact text. */
export function buildSuccessorPayloadText(args: {
  readonly originalPrompt: string | undefined
  readonly originalNote: string
  readonly handover: string
  readonly successorMarker: string
}): string {
  const originalBlock = args.originalPrompt !== undefined
    ? `--- original task (VERBATIM, reference only; do not repeat completed steps) ---\n${args.originalPrompt}\n--- end of original task ---`
    : `--- original task ---\n${args.originalNote}\n--- end of original task ---`
  return (
    `${originalBlock}\n\n` +
    `--- handover (VERBATIM, do not paraphrase) ---\n${args.handover}\n--- end of handover ---\n\n` +
    `${SUCCESSOR_GUIDANCE}\n\n` +
    `Successor pointer (spawn with this prompt VERBATIM; you may append redirection; do not paste the texts above):\n${args.successorMarker}`
  )
}

/**
 * Reference-workflow readback body: header lines plus the successor payload
 * (original verbatim once, handover verbatim once, guidance, pointer).
 * Stored text is never rewritten.
 */
export function buildReferenceReadback(args: {
  readonly header: string
  readonly diagLine: string
  readonly provenanceLine: string
  readonly generationLine: string
  readonly seedSizeLine: string
  readonly originalPrompt: string | undefined
  readonly originalNote: string
  readonly handover: string
  readonly successorMarker: string
}): string {
  return (
    `${args.header}\n${args.diagLine}\n${args.provenanceLine}\n${args.generationLine}\n${args.seedSizeLine}\n\n` +
    buildSuccessorPayloadText(args)
  )
}

/** Claude reference-variant locked reply, with or without provenance. Names the exact reader call and the VERBATIM pointer without reproducing it. */
export function buildLockedChildReply(agentId: string, provenance?: SpawnProvenance): string {
  return (
    `${CHILD_SUMMARY_PREFIX} This subagent session is locked after a context handover and cannot answer questions or do more work. ` +
    `First call ${READ_FULL}({"childId":${JSON.stringify(agentId)}}) to read the full handover. ` +
    `${READ_BEFORE_DECISION} ` +
    `Then start a successor of the same agent type ${formatAgentTypeReadback(provenance?.agentType)} ` +
    `with the same model override ${formatModelOverrideReadback(provenance?.modelOverride)} ` +
    `(or a fresh subagent to investigate and continue), ` +
    `spawned with the reader's short successor prompt VERBATIM ` +
    `(marker plus reader instruction to continue from 'Prioritized next steps'; do not paste the handover or original task). ` +
    `The parent may redirect; ${PARENT_DISCRETION}.`
  )
}

/** Fill missing lineage/provenance fields from a fallback (stored spawn metadata or memory). Record fields win; sanitized. */
export function mergeProvenance(primary?: SpawnProvenance, fallback?: SpawnProvenance): SpawnProvenance | undefined {
  const clean = (value: SpawnProvenance | undefined): SpawnProvenance | undefined => {
    if (value === undefined) return undefined
    const built: SpawnProvenance = {
      ...(typeof value.agentType === "string" && value.agentType.length > 0 ? { agentType: value.agentType } : {}),
      ...(typeof value.modelOverride === "string" && value.modelOverride.length > 0
        ? { modelOverride: value.modelOverride }
        : value.modelOverride === null ? { modelOverride: null } : {}),
      ...(typeof value.predecessorAgentId === "string" && value.predecessorAgentId.length > 0
        ? { predecessorAgentId: value.predecessorAgentId } : {}),
      ...(typeof value.originAgentId === "string" && value.originAgentId.length > 0
        ? { originAgentId: value.originAgentId } : {}),
      ...(typeof value.generation === "number" && Number.isInteger(value.generation) && value.generation >= 1
        ? { generation: value.generation } : {}),
      ...(typeof value.originalCaptureError === "string" && value.originalCaptureError.length > 0
        ? { originalCaptureError: value.originalCaptureError.slice(0, 300) } : {}),
    }
    return built.agentType === undefined && built.modelOverride === undefined &&
      built.predecessorAgentId === undefined && built.originAgentId === undefined && built.generation === undefined &&
      built.originalCaptureError === undefined
      ? undefined
      : built
  }
  const first = clean(primary)
  const second = clean(fallback)
  if (first === undefined) return second
  if (second === undefined) return first
  return {
    agentType: first.agentType ?? second.agentType,
    ...(first.modelOverride !== undefined ? { modelOverride: first.modelOverride }
      : second.modelOverride !== undefined ? { modelOverride: second.modelOverride } : {}),
    ...(first.predecessorAgentId ?? second.predecessorAgentId) === undefined ? {}
      : { predecessorAgentId: (first.predecessorAgentId ?? second.predecessorAgentId) as string },
    ...(first.originAgentId ?? second.originAgentId) === undefined ? {}
      : { originAgentId: (first.originAgentId ?? second.originAgentId) as string },
    ...(first.generation ?? second.generation) === undefined ? {}
      : { generation: (first.generation ?? second.generation) as number },
    ...(first.originalCaptureError ?? second.originalCaptureError) === undefined ? {}
      : { originalCaptureError: (first.originalCaptureError ?? second.originalCaptureError) as string },
  }
}

export function buildLockedChildDeny(agentId: string, provenance?: SpawnProvenance): string {
  const locked = buildLockedChildReply(agentId, provenance)
  return (
    `This subagent session is locked after a context handover and cannot answer questions or do more work. ` +
    `All further work tools and duplicate handovers are denied. ` +
    `Call SubagentHandback now with ONLY the following locked reply as your final delivery and then stop; ` +
    `a plain-text final may not reach your parent and does not count as delivery, ` +
    `plain text is a last resort only when the SubagentHandback tool is absent: ${locked}`
  )
}

/** Latest per-request token sum, counted once (never cumulative across requests). Invalid usage yields undefined. */
export function sumTurnUsage(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined
  const record = usage as Record<string, unknown>
  const fields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const
  let total = 0
  for (const field of fields) {
    const value = record[field]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
    total += value
  }
  return total > 0 ? total : undefined
}
