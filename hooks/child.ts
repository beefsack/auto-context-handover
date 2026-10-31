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
import type { TurnStepEvent } from "./claude-types.ts"
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
export const CHILD_DEFAULT_SOFT = 200000

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
    `If your task starts with an [${SUCCESSOR_MARKER_TAG} child:<id>] marker, first call ${READ_FULL}({"childId":"<id>","full":true}) for that child id to load the full handover and the original task (the successor pointer always requests full:true; recorded successors receive full automatically even without the flag). ` +
    `The original task is reference only; completed steps are done and must not be repeated; targeted rereads are allowed only to resolve open questions; predecessor facts are trusted unless marked unverified. ` +
    `Your parent reads a compact view via ${READ_FULL} (full on request) and continues the work in a successor.`
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
    `When a subagent returns a "${CHILD_SUMMARY_PREFIX}" reply, read the handover via ${READ_FULL} (compact parent view by default: header, pending decisions, Prioritized next steps excerpt, successor pointer; pass full:true for the full original task and handover verbatim), ` +
    `then start a successor of the same agent type with the same model override, ` +
    `spawned with the reader's short successor prompt VERBATIM ` +
    `(marker plus reader instruction to continue from 'Prioritized next steps'; do not paste the handover or original task), ` +
    `without confirmation as the user's configured default; you may append redirection after the prompt. ` +
    `The original task is reference only; completed steps are done and must not be repeated; targeted rereads are allowed only to resolve open questions; predecessor facts are trusted unless marked unverified. ` +
    `The plugin's recorded agent type/model override/chain is authoritative and overrides handover prose on conflict. ` +
    `If a subagent ends without a delivered report, call ${READ_FULL} with its child id BEFORE messaging or resuming it; ` +
    `a stored handover counts as a reply. Never SendMessage to or resume a handed-over subagent; start a successor instead, ` +
    `which continues and replaces the predecessor as the same logical subagent and does not count as additional under subagent-count limits. ` +
    `The readback shows generation, predecessor chain, next-step count, baseline/start context and last-batch increase, and seed-size diagnostics; if the seed exceeds 50% of soft, ask the child to compress carried-over finished notes. ` +
    `A recorded successor caller (leading marker/stored predecessor link) receives the full handover automatically; otherwise request full:true (the generated successor pointer always includes full:true). ` +
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
  `Read a stored subagent handover by childId (a parent agent can read a child's handover, and any live session can read a locked one's; a successor child reads its predecessor by childId; no caller authorization, open policy). ` +
  `Takes childId: the child agent id from the short reply; optional full: true returns the full original task and handover verbatim. ` +
  `Default is a compact parent view: header lines (diagnostics, provenance, generation, predecessor chain, next-step count, seed size, baseline), pending user decisions, the Prioritized next steps excerpt, and the short successor prompt (marker prefix plus exact reader instruction). ` +
  `Full original task and handover appear with full:true (the generated successor pointer always requests full:true) or automatically for a recorded successor caller with stored lineage from its leading [auto-context-handover:continue child:<id>] marker (predecessor link); callers without full:true or recorded lineage receive the compact view. ` +
  `If the next-steps section cannot be extracted, the compact view says so and points to full:true. ` +
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
  /** Effective request effort observed at handover, not a requested spawn override. */
  readonly effort?: TurnStepEvent["effort"]
  readonly predecessorAgentId?: string
  readonly originAgentId?: string
  readonly generation?: number
  /** Bounded original-capture failure text persisted when the original write is rejected. Memory first, store fallback. */
  readonly originalCaptureError?: string
  /**
   * Freshness timestamp for spawn-only chains (Date.now() at persist time).
   * Lets orphan spawn metadata sort by recency; records without it (legacy)
   * still sort oldest. Never a lineage claim.
   */
  readonly storedAt?: number
  /**
   * Observed unresolvable lineage (malformed successor marker): the chain is
   * uncertain and never evicted. Absent means no such observation; only an
   * explicit true counts, never a default.
   */
  readonly lineageUncertain?: boolean
}

export function isSpawnProvenance(value: unknown): value is SpawnProvenance {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  if (record.agentType !== undefined && typeof record.agentType !== "string") return false
  if (record.modelOverride !== undefined && record.modelOverride !== null && typeof record.modelOverride !== "string") return false
  if (record.effort !== undefined && !isRequestEffort(record.effort)) return false
  if (record.predecessorAgentId !== undefined && typeof record.predecessorAgentId !== "string") return false
  if (record.originAgentId !== undefined && typeof record.originAgentId !== "string") return false
  if (record.generation !== undefined && (typeof record.generation !== "number" || !Number.isInteger(record.generation) || record.generation < 1)) return false
  if (record.originalCaptureError !== undefined && typeof record.originalCaptureError !== "string") return false
  if (record.storedAt !== undefined && (typeof record.storedAt !== "number" || !Number.isFinite(record.storedAt))) return false
  if (record.lineageUncertain !== undefined && typeof record.lineageUncertain !== "boolean") return false
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

export function isRequestEffort(value: unknown): value is NonNullable<TurnStepEvent["effort"]> {
  return (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && ["low", "medium", "high", "xhigh", "max"].includes(value))
}

/** Required read-before-decision sentence for every Claude short reply. */
export const READ_BEFORE_DECISION = `Read the handover before replying to the user or making any decision about the task.`

export function buildProvenanceReadback(provenance?: SpawnProvenance): string {
  return (
    `Start a successor of the same agent type ${formatAgentTypeReadback(provenance?.agentType)} ` +
    `with the same model override ${formatModelOverrideReadback(provenance?.modelOverride)} (variant/effort=${provenance?.effort ?? "unknown"}). ` +
    `Reuse the original spawn parameters, including effort.`
  )
}

export interface ChildRecord {
  readonly handover: string
  /**
   * Model-authored summary (canonical, lossless). Always persisted in new
   * records; the delivered short reply is derived from it and not stored.
   * Legacy records may carry a persisted shortReply fallback instead.
   */
  readonly summary: string
  readonly agentId: string
  readonly parentSessionId: string | undefined
  /**
   * Delivered short reply. Present in legacy records; omitted in new records
   * (derived via shortReplyOf). Never delimiter-parsed: user/model summary
   * text may itself contain the prefix delimiter.
   */
  readonly shortReply?: string
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
  /** Latest observed request effort at handover; absent means unknown. */
  readonly effort?: TurnStepEvent["effort"]
  /** Short-marker predecessor child id; absent means origin or unknown (legacy/missing). */
  readonly predecessorAgentId?: string
  /** Chain origin child id; absent means unknown origin (legacy/malformed/missing). */
  readonly originAgentId?: string
  /** Generation number: 1 for origins, predecessor + 1 for successors; absent when unknown. No fixed cap. */
  readonly generation?: number
}

export interface ChildDiag extends HandoverDiag {
  /** First measured per-request total for this child; unknown when reload/legacy/no measurement. */
  readonly baseline?: number | "unknown"
  /** Last batch increase (latest total minus previous total); unknown with <2 measurements, reload, or legacy. */
  readonly growth?: number | "unknown"
}

export function isChildRecord(value: unknown): value is ChildRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.tombstone === "boolean" && record.tombstone === true) return false
  return (
    typeof record.handover === "string" &&
    typeof record.summary === "string" &&
    typeof record.agentId === "string" &&
    (record.shortReply === undefined || typeof record.shortReply === "string") &&
    record.closed === true
  )
}

/**
 * Delivered short reply for a record: the persisted legacy reply when
 * present, else derived losslessly from the canonical summary. Derivation
 * never parses the summary out of generated text.
 */
export function shortReplyOf(
  record: Pick<ChildRecord, "summary" | "shortReply" | "agentId">,
  provenance?: SpawnProvenance,
): string {
  if (typeof record.shortReply === "string") return record.shortReply
  return buildChildShortReply(record.summary || "Handover stored.", record.agentId, provenance)
}

/**
 * Compact closure tombstone left when size retention evicts a handed-over
 * child. Preserves the lock (closed:true) and minimal lineage; the payload
 * (handover/summary/shortReply) is gone. Reads report expired; expired ids
 * never seed a fabricated new origin.
 */
export interface ChildTombstone {
  readonly tombstone: true
  readonly expired: true
  readonly agentId: string
  readonly closed: true
  readonly storedAt: number
  readonly predecessorAgentId?: string
  readonly originAgentId?: string
  readonly generation?: number
}

export function isChildTombstone(value: unknown): value is ChildTombstone {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.tombstone === true &&
    record.expired === true &&
    typeof record.agentId === "string" &&
    record.closed === true
  )
}

export function buildChildTombstone(args: {
  readonly agentId: string
  readonly storedAt?: number
  readonly predecessorAgentId?: string
  readonly originAgentId?: string
  readonly generation?: number
}): ChildTombstone {
  return {
    tombstone: true,
    expired: true,
    agentId: args.agentId,
    closed: true,
    storedAt: args.storedAt ?? Date.now(),
    ...(args.predecessorAgentId === undefined ? {} : { predecessorAgentId: args.predecessorAgentId }),
    ...(args.originAgentId === undefined ? {} : { originAgentId: args.originAgentId }),
    ...(args.generation === undefined ? {} : { generation: args.generation }),
  }
}

/** Expired-read result text for an evicted child id. Explicit, never a fabricated payload. */
export function buildExpiredReadback(agentId: string): string {
  return (
    `Handover for subagent ${agentId} has expired and is no longer stored: ` +
    `size-based retention evicted its whole chain to stay within the plugin store budget. ` +
    `This compact closure tombstone preserves the lock: the child remains handed over and locked, ` +
    `it cannot do more work, and it must not be messaged or resumed. ` +
    `Start a fresh subagent to investigate and continue; do not treat this id as a new chain origin for lineage.`
  )
}

/** Expired-lock denial for gate/duplicate/handover paths. Keeps the lock wording plus expiry. */
export function buildExpiredChildDeny(agentId: string): string {
  return (
    `This subagent session is locked after a context handover and cannot answer questions or do more work. ` +
    `Its stored handover has expired under size-based retention (tombstone preserves the lock); ` +
    `no payload can be recovered for ${agentId}. ` +
    `Call SubagentHandback now with ONLY a brief expired notice as your final delivery and then stop; ` +
    `a plain-text final may not reach your parent and does not count as delivery.`
  )
}

// ---------------------------------------------------------------------------
// Size-based retention accounting (fixed policy, no TTL, no configuration).
// Budget 3 MiB projected; host cap 4 MiB leaves 1 MiB headroom.
// ---------------------------------------------------------------------------

/** Projected serialized store budget: evict oldest eligible whole chains above this. */
export const STORE_BUDGET_BYTES = 3 * 1024 * 1024

/** Host plugin-store cap, retained for headroom documentation. */
export const HOST_CAP_BYTES = 4 * 1024 * 1024

/** UTF-8 byte length without Node APIs (surrogate pairs count 4). */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/** Serialized byte size of one store entry: JSON key spelling (quotes and
 * escapes included) plus colon plus JSON value. */
export function estimateEntryBytes(key: string, value: unknown): number {
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? "null"
  } catch {
    serialized = "null"
  }
  return utf8ByteLength(JSON.stringify(key)) + 1 + utf8ByteLength(serialized)
}

/**
 * Complete serialized store estimate over all keys with the pending
 * replacement applied (old entry for pendingKey subtracted, new added).
 * Counts every key family, not only payload keys. Models the aggregate JSON
 * object: outer braces plus comma separators plus per-entry key/value sizes,
 * so key escapes and structural punctuation are included, not just raw payload
 * bytes. Missing (undefined) values count as absent (concurrent delete).
 */
export function estimateStoreBytes(
  entries: Iterable<readonly [string, unknown]>,
  pending?: { readonly key: string; readonly value: unknown },
): number {
  const merged = new Map<string, unknown>()
  for (const [key, value] of entries) {
    if (value === undefined) continue
    merged.set(key, value)
  }
  if (pending !== undefined) merged.set(pending.key, pending.value)
  let total = 2
  let count = 0
  for (const [key, value] of merged) {
    total += estimateEntryBytes(key, value)
    count++
  }
  if (count > 0) total += count - 1
  return total
}

export type StoreKeyFamily = "child" | "spawn" | "original" | "activity" | "pin" | "other"

export function parseStoreKey(key: string): { readonly family: StoreKeyFamily; readonly id: string } {
  const at = key.indexOf(":")
  if (at < 0) return { family: "other", id: key }
  const head = key.slice(0, at)
  const id = key.slice(at + 1)
  if (head === "child" || head === "spawn" || head === "original" || head === "activity" || head === "pin") {
    return { family: head, id }
  }
  return { family: "other", id: key }
}

/** Chain activity record: last activity per chain. Written without eviction scans. */
export interface ChainActivity {
  readonly lastActive: number
}

export function isChainActivity(value: unknown): value is ChainActivity {
  if (typeof value !== "object" || value === null) return false
  return typeof (value as Record<string, unknown>).lastActive === "number"
}

/** Active-chain pin: spawn-time ownership so live chains survive cross-session eviction. Retired on session end, never TTL-expired. */
export interface ChainPin {
  readonly owner: string
  readonly updatedAt: number
}

export function isChainPin(value: unknown): value is ChainPin {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.owner === "string" && typeof record.updatedAt === "number"
}

export function activityKey(chain: string): string {
  return `activity:${chain}`
}

export function pinKey(agentId: string): string {
  return `pin:${agentId}`
}

export type ChainKind = "origin" | "legacy" | "uncertain"

/**
 * Protection-boundary classification for one agent id.
 *
 * - origin: merged child/spawn lineage names an originAgentId; the id belongs
 *   to that origin's whole chain. Every claim agrees (origins match,
 *   predecessors match, generations match); any both-present disagreement is
 *   a conflict, never guessed: uncertain.
 * - legacy: no lineage claims at all in either record (every lineage field
 *   absent). Explicitly evictable. A generation without any origin or
 *   predecessor is still a claim, not legacy.
 * - uncertain: an explicit unresolvable-lineage observation, a
 *   present-but-invalid (malformed) lineage field such as an empty origin, a
 *   predecessor without a resolvable origin, a generation without lineage, or
 *   conflicting claims. Never inferred, never evicted; retains
 *   conservatively.
 */
export function classifyChain(
  child: ChildRecord | ChildTombstone | undefined,
  spawn: SpawnProvenance | undefined,
): { readonly kind: ChainKind; readonly origin?: string } {
  // Explicit uncertainty persists across reloads: a malformed-marker
  // observation never resolves to an evictable chain.
  if (spawn?.lineageUncertain === true) return { kind: "uncertain" }
  // Raw reads: stored JSON may hold present-but-invalid lineage values that
  // the typed guards do not reject (records) or that fail them (spawn). Any
  // present, non-undefined lineage field that is not a valid value is a
  // malformed claim, never an absent one.
  const childRaw = child as Record<string, unknown> | undefined
  const spawnRaw = spawn as Record<string, unknown> | undefined
  const validText = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined
  const malformedText = (value: unknown): boolean => value !== undefined && validText(value) === undefined
  const validGeneration = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined
  const malformedGeneration = (value: unknown): boolean => value !== undefined && validGeneration(value) === undefined
  if (
    malformedText(childRaw?.originAgentId) || malformedText(spawnRaw?.originAgentId) ||
    malformedText(childRaw?.predecessorAgentId) || malformedText(spawnRaw?.predecessorAgentId) ||
    malformedGeneration(childRaw?.generation) || malformedGeneration(spawnRaw?.generation)
  ) {
    return { kind: "uncertain" }
  }
  const childOrigin = validText(childRaw?.originAgentId)
  const spawnOrigin = validText(spawnRaw?.originAgentId)
  // Conflicting claims are never guessed: retain as uncertain.
  if (childOrigin !== undefined && spawnOrigin !== undefined && childOrigin !== spawnOrigin) {
    return { kind: "uncertain" }
  }
  const childPredecessor = validText(childRaw?.predecessorAgentId)
  const spawnPredecessor = validText(spawnRaw?.predecessorAgentId)
  if (childPredecessor !== undefined && spawnPredecessor !== undefined && childPredecessor !== spawnPredecessor) {
    return { kind: "uncertain" }
  }
  const childGeneration = validGeneration(childRaw?.generation)
  const spawnGeneration = validGeneration(spawnRaw?.generation)
  if (childGeneration !== undefined && spawnGeneration !== undefined && childGeneration !== spawnGeneration) {
    return { kind: "uncertain" }
  }
  const origin = childOrigin ?? spawnOrigin
  if (origin !== undefined) return { kind: "origin", origin }
  const predecessor = childPredecessor ?? spawnPredecessor
  if (predecessor !== undefined) return { kind: "uncertain" }
  // A generation without any origin or predecessor is an unverifiable claim.
  if (childGeneration !== undefined || spawnGeneration !== undefined) return { kind: "uncertain" }
  return { kind: "legacy" }
}

export interface ChainGroup {
  /** Origin id for origin chains, singleton id for legacy chains. */
  readonly chain: string
  readonly kind: ChainKind
  readonly keys: string[]
  /** Last activity: activity record wins, else max storedAt, else 0 (legacy/untimestamped sort oldest). */
  readonly lastActive: number
}

export function chainActivityOf(chain: string, byKey: Map<string, unknown>): number | undefined {
  const value = byKey.get(activityKey(chain))
  return isChainActivity(value) ? value.lastActive : undefined
}

function storedAtOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const at = (value as Record<string, unknown>).storedAt
  return typeof at === "number" && Number.isFinite(at) ? at : undefined
}

/**
 * Group store keys into whole chains. Origin chains collect every member id
 * resolving to that origin plus original:<origin> and activity:<origin>.
 * Legacy ids form singleton chains. Uncertain ids form singleton groups
 * flagged uncertain (never evictable). Unknown/other families ride along with
 * the size estimate but are never evicted by chain reclamation.
 * Present-but-unverifiable child/spawn values are quarantined into uncertain
 * singletons and never attached to a valid member chain, as is a child
 * record whose recorded agentId conflicts with its store key; an orphan
 * original/activity key named as a predecessor, origin, or claimed identity
 * by any (valid or raw malformed) member stays with that member's chain
 * instead of being reclaimed independently.
 */
export function groupChains(byKey: Map<string, unknown>): Map<string, ChainGroup> {
  const childOf = new Map<string, ChildRecord | ChildTombstone>()
  const spawnOf = new Map<string, SpawnProvenance>()
  // Undefined means absent (concurrent delete), never malformed.
  const malformedKeys = new Set<string>()
  const malformedIds = new Set<string>()
  for (const [key, value] of byKey) {
    const parsed = parseStoreKey(key)
    if (value === undefined) continue
    if (parsed.family === "child" && (isChildRecord(value) || isChildTombstone(value))) {
      // A conflicting recorded identity (agentId disagrees with the store
      // key) is never guessed: quarantine as uncertain, never attach it to a
      // valid member chain.
      if (value.agentId !== parsed.id) {
        malformedKeys.add(key)
        malformedIds.add(parsed.id)
      } else childOf.set(parsed.id, value)
    } else if (parsed.family === "spawn" && isSpawnProvenance(value)) spawnOf.set(parsed.id, value)
    else if (parsed.family === "child" || parsed.family === "spawn") {
      malformedKeys.add(key)
      malformedIds.add(parsed.id)
    }
  }
  const groups = new Map<string, ChainGroup>()
  const taken = new Set<string>()
  const groupOfMember = new Map<string, ChainGroup>()
  const take = (mapKey: string, chain: string, kind: ChainKind, key: string): ChainGroup => {
    let group = groups.get(mapKey)
    if (!group) {
      group = { chain, kind, keys: [], lastActive: 0 }
      groups.set(mapKey, group)
    }
    if (!taken.has(key)) {
      group.keys.push(key)
      taken.add(key)
    }
    return group
  }
  // Quarantine first: a malformed key (plus the id's original/activity, which
  // document the same unverifiable chain) forms an uncertain singleton and is
  // never attached to a valid member chain.
  for (const id of [...malformedIds].sort()) {
    let home: ChainGroup | undefined
    for (const key of [`child:${id}`, `spawn:${id}`, originalRecordKey(id), activityKey(id)]) {
      if (byKey.has(key)) home = take(`uncertain:${id}`, id, "uncertain", key)
    }
    // Orphan original/activity keys naming this quarantined id as a
    // predecessor/origin resolve their home here instead of becoming
    // independent reclaimable legacy groups.
    if (home !== undefined) groupOfMember.set(id, home)
  }
  const memberIds = new Set<string>([...childOf.keys(), ...spawnOf.keys()])
  // First pass: origin chains from verified membership only.
  for (const id of memberIds) {
    const classified = classifyChain(childOf.get(id), spawnOf.get(id))
    if (classified.kind === "origin" && classified.origin !== undefined) {
      const chain = classified.origin
      for (const key of [`child:${id}`, `spawn:${id}`]) {
        if (byKey.has(key) && !malformedKeys.has(key)) groupOfMember.set(id, take(`origin:${chain}`, chain, "origin", key))
      }
    }
  }
  // Origin-level keys.
  for (const [mapKey, group] of groups) {
    if (group.kind !== "origin") continue
    for (const key of [originalRecordKey(group.chain), activityKey(group.chain)]) {
      if (byKey.has(key) && !taken.has(key)) take(mapKey, group.chain, group.kind, key)
    }
  }
  // Second pass: legacy and uncertain singletons for ids not in an origin
  // chain. Origin-classified ids always take their valid keys above; anything
  // left is legacy (no claims) or uncertain (unresolvable claims).
  const covered = new Set<string>()
  for (const id of memberIds) {
    if (groupOfMember.has(id)) covered.add(id)
  }
  for (const id of memberIds) {
    if (covered.has(id)) continue
    const classified = classifyChain(childOf.get(id), spawnOf.get(id))
    const kind: ChainKind = classified.kind === "uncertain" ? "uncertain" : "legacy"
    for (const key of [`child:${id}`, `spawn:${id}`, originalRecordKey(id), activityKey(id)]) {
      if (byKey.has(key) && !taken.has(key)) groupOfMember.set(id, take(`${kind}:${id}`, id, kind, key))
    }
  }
  // Identifiable related references from every child/spawn value, valid or
  // raw malformed: an orphan original/activity key whose id is named as a
  // predecessor, origin, or conflicting recorded identity by any member stays
  // with that member's chain instead of being reclaimed as an independent
  // legacy group. Raw nonempty strings only; nothing is guessed.
  const referrerOf = new Map<string, string>()
  const noteReferrer = (ref: unknown, referrer: string): void => {
    if (typeof ref === "string" && ref.length > 0 && !referrerOf.has(ref)) referrerOf.set(ref, referrer)
  }
  for (const [key, value] of byKey) {
    const parsed = parseStoreKey(key)
    if (parsed.family !== "child" && parsed.family !== "spawn") continue
    if (value === undefined || value === null || typeof value !== "object") continue
    const raw = value as Record<string, unknown>
    noteReferrer(raw.predecessorAgentId, parsed.id)
    noteReferrer(raw.originAgentId, parsed.id)
    // A conflicting recorded identity also names its claimed chain.
    if (parsed.family === "child") noteReferrer(raw.agentId, parsed.id)
  }
  for (const [key] of byKey) {
    const parsed = parseStoreKey(key)
    if (parsed.family !== "original" && parsed.family !== "activity") continue
    if (taken.has(key)) continue
    const referrer = referrerOf.get(parsed.id)
    const home = referrer === undefined ? undefined : groupOfMember.get(referrer)
    if (home !== undefined) {
      home.keys.push(key)
      taken.add(key)
    } else {
      take(`legacy:${parsed.id}`, parsed.id, "legacy", key)
    }
  }
  // Last activity per group.
  for (const group of groups.values()) {
    let last = chainActivityOf(group.chain, byKey) ?? Number.NEGATIVE_INFINITY
    for (const key of group.keys) {
      const at = storedAtOf(byKey.get(key))
      if (at !== undefined && at > last) last = at
    }
    (group as { lastActive: number }).lastActive = last === Number.NEGATIVE_INFINITY ? 0 : last
  }
  return groups
}

/**
 * Oldest-first evictable ordering. Rank 0 is legacy chains plus untimestamped
 * origin chains (lastActive 0): both count as oldest and are evicted first,
 * so a recent timestamped legacy still precedes a timestamped origin while an
 * untimestamped origin is never put behind a recent legacy. Within each rank,
 * by lastActive ascending (untimestamped 0 sorts oldest), ties by chain id.
 * Uncertain groups are never returned.
 */
export function orderEvictableChains(groups: Map<string, ChainGroup>): ChainGroup[] {
  const rank = (group: ChainGroup): number => (group.kind === "legacy" || group.lastActive === 0 ? 0 : 1)
  return [...groups.values()]
    .filter((group) => group.kind !== "uncertain" && group.keys.length > 0)
    .sort((a, b) => rank(a) - rank(b) || a.lastActive - b.lastActive || (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0))
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

/** Extract the pending-decisions marker from a child summary, inline or on its own line, with list continuation. Unknown when absent; never manufactured. */
export function extractPendingDecisions(summary: unknown): string | undefined {
  if (typeof summary !== "string") return undefined
  const at = summary.search(/user decisions pending\s*:/i)
  if (at < 0) return undefined
  const after = summary.slice(at).replace(/[^:]*:/, "")
  const [first, ...rest] = after.split("\n")
  const head = (first ?? "").trim()
  if (head.length > 0) {
    const items = [head]
    for (const line of rest) {
      if (line.trim() === "") break
      items.push(line.trim())
    }
    return `User decisions pending: ${items.join("; ")}`
  }
  const items: string[] = []
  for (const line of rest) {
    if (line.trim() === "") break
    items.push(line.trim())
  }
  if (items.length === 0) return undefined
  return `User decisions pending: ${items.join("; ")}`
}

/** Extract the Prioritized next steps body to boundary/end, excluding its heading. Undefined when absent/truncated/ambiguous. */
export function extractNextStepsSection(handover: string): string | undefined {
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
  // Same ambiguity rules as countNextSteps: prose or post-boundary items invalidate.
  let stopped = false
  let end = rest.length
  for (let i = 0; i < rest.length; i++) {
    const line = rest[i] ?? ""
    if (stopped) {
      if (isTopLevelItem(line)) return undefined
      continue
    }
    if (line.trim() === "") continue
    if (isTopLevelItem(line)) continue
    if (/^\s/.test(line)) continue
    if (isHeadingBoundary(line)) {
      stopped = true
      end = i
      continue
    }
    return undefined
  }
  const excerpt = rest.slice(0, end).join("\n").trim()
  // Must contain at least one step; countNextSteps enforces the same.
  if (countNextSteps(handover) === undefined) return undefined
  return excerpt.length > 0 ? excerpt : undefined
}

/** Baseline/start-context and last-batch-increase diagnostics line. Unknown for reload/legacy/single-measurement. */
export function buildBaselineLine(baseline: number | "unknown", growth: number | "unknown"): string {
  const start = typeof baseline === "number" ? String(Math.floor(baseline)) : "unknown"
  const delta = typeof growth === "number" ? String(Math.floor(growth)) : "unknown"
  return `Baseline: start-context-tokens=${start}, last-batch-increase=${delta}.`
}

/** Pending-decisions line for the compact parent view. Honest unknown, never manufactured. */
export function buildPendingLine(summary: unknown): string {
  const pending = extractPendingDecisions(summary)
  if (pending !== undefined) return pending
  return `User decisions pending: unknown (no pending line in summary; request full:true to check).`
}

/** Compact parent readback: headers plus pending, next-steps excerpt, and pointer. No full texts. */
export function buildCompactReadback(args: {
  readonly header: string
  readonly diagLine: string
  readonly baselineLine: string
  readonly provenanceLine: string
  readonly generationLine: string
  readonly seedSizeLine: string
  readonly pendingLine: string
  readonly nextStepsExcerpt: string | undefined
  readonly successorMarker: string
  readonly targetId: string
}): string {
  const nextBlock = args.nextStepsExcerpt !== undefined
    ? `Prioritized next steps (excerpt, continue here):\n${args.nextStepsExcerpt}`
    : `Prioritized next steps: unknown (could not extract; request full:true with {"childId":${JSON.stringify(args.targetId)},"full":true} for the full handover).`
  return (
    `${args.header}\n${args.diagLine}\n${args.baselineLine}\n${args.provenanceLine}\n${args.generationLine}\n${args.seedSizeLine}\n${args.pendingLine}\n\n` +
    `${nextBlock}\n\n` +
    `Successor pointer (spawn with this prompt VERBATIM; you may append redirection; do not paste texts):\n${args.successorMarker}\n\n` +
    `Compact view: full original task and handover withheld. Request full:true with {"childId":${JSON.stringify(args.targetId)},"full":true}. ` +
    `Recorded successors (leading [${SUCCESSOR_MARKER_TAG} child:${args.targetId}] marker/stored predecessor link) receive full automatically.`
  )
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
  const invocation = `${READ_FULL}({"childId":${JSON.stringify(predecessorAgentId)},"full":true})`
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
    `First call ${READ_FULL}({"childId":${JSON.stringify(agentId)}}) to read the handover (compact by default; pass full:true for full texts; recorded successors receive full automatically). ` +
    `${READ_BEFORE_DECISION} ` +
    `Then start a successor of the same agent type ${formatAgentTypeReadback(provenance?.agentType)} ` +
    `with the same model override ${formatModelOverrideReadback(provenance?.modelOverride)} (variant/effort=${provenance?.effort ?? "unknown"}), ` +
    `spawned with the reader's short successor prompt VERBATIM ` +
    `(marker plus reader instruction to continue from 'Prioritized next steps'; reuse the original spawn parameters, including effort; do not paste the handover or original task). ` +
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
    `Continuing work handed over from subagent ${childId} (agent type: ${agentType}; model override: ${modelOverride}; variant/effort=${provenance?.effort ?? "unknown"}).\n` +
    `Original task: reference only (load it via ${READ_FULL}({"childId":${JSON.stringify(childId)},"full":true}) alongside this handover; do not repeat completed steps).\n\n` +
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
  readonly baselineLine?: string
  readonly provenanceLine: string
  readonly generationLine: string
  readonly seedSizeLine: string
  readonly accessNote?: string
  readonly originalPrompt: string | undefined
  readonly originalNote: string
  readonly handover: string
  readonly successorMarker: string
}): string {
  const head = [
    args.header,
    args.diagLine,
    ...(args.baselineLine !== undefined ? [args.baselineLine] : []),
    args.provenanceLine,
    args.generationLine,
    args.seedSizeLine,
    ...(args.accessNote !== undefined ? [args.accessNote] : []),
  ].join("\n")
  return (
    `${head}\n\n` +
    buildSuccessorPayloadText(args)
  )
}

/** Claude reference-variant locked reply, with or without provenance. Names the exact reader call and the VERBATIM pointer without reproducing it. */
export function buildLockedChildReply(agentId: string, provenance?: SpawnProvenance): string {
  return (
    `${CHILD_SUMMARY_PREFIX} This subagent session is locked after a context handover and cannot answer questions or do more work. ` +
    `First call ${READ_FULL}({"childId":${JSON.stringify(agentId)}}) to read the handover (compact by default; pass full:true for full texts; recorded successors receive full automatically). ` +
    `${READ_BEFORE_DECISION} ` +
    `Then start a successor of the same agent type ${formatAgentTypeReadback(provenance?.agentType)} ` +
    `with the same model override ${formatModelOverrideReadback(provenance?.modelOverride)} (variant/effort=${provenance?.effort ?? "unknown"}) ` +
    `(or a fresh subagent to investigate and continue), ` +
    `spawned with the reader's short successor prompt VERBATIM ` +
    `(marker plus reader instruction to continue from 'Prioritized next steps'; reuse the original spawn parameters, including effort; do not paste the handover or original task). ` +
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
      ...(isRequestEffort(value.effort) ? { effort: value.effort } : {}),
      ...(typeof value.predecessorAgentId === "string" && value.predecessorAgentId.length > 0
        ? { predecessorAgentId: value.predecessorAgentId } : {}),
      ...(typeof value.originAgentId === "string" && value.originAgentId.length > 0
        ? { originAgentId: value.originAgentId } : {}),
      ...(typeof value.generation === "number" && Number.isInteger(value.generation) && value.generation >= 1
        ? { generation: value.generation } : {}),
      ...(typeof value.originalCaptureError === "string" && value.originalCaptureError.length > 0
        ? { originalCaptureError: value.originalCaptureError.slice(0, 300) } : {}),
      ...(typeof value.storedAt === "number" && Number.isFinite(value.storedAt)
        ? { storedAt: value.storedAt } : {}),
      ...(value.lineageUncertain === true ? { lineageUncertain: true } : {}),
    }
    return built.agentType === undefined && built.modelOverride === undefined && built.effort === undefined &&
      built.predecessorAgentId === undefined && built.originAgentId === undefined && built.generation === undefined &&
      built.originalCaptureError === undefined && built.storedAt === undefined && built.lineageUncertain === undefined
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
    ...(first.effort ?? second.effort) === undefined ? {} : { effort: first.effort ?? second.effort },
    ...(first.predecessorAgentId ?? second.predecessorAgentId) === undefined ? {}
      : { predecessorAgentId: (first.predecessorAgentId ?? second.predecessorAgentId) as string },
    ...(first.originAgentId ?? second.originAgentId) === undefined ? {}
      : { originAgentId: (first.originAgentId ?? second.originAgentId) as string },
    ...(first.generation ?? second.generation) === undefined ? {}
      : { generation: (first.generation ?? second.generation) as number },
    ...(first.originalCaptureError ?? second.originalCaptureError) === undefined ? {}
      : { originalCaptureError: (first.originalCaptureError ?? second.originalCaptureError) as string },
    ...(first.lineageUncertain === true || second.lineageUncertain === true ? { lineageUncertain: true } : {}),
    ...(first.storedAt ?? second.storedAt) === undefined ? {}
      : { storedAt: (first.storedAt ?? second.storedAt) as number },
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
