// Claude Code subagent-only handover adapter (Node-free runtime module).
//
// Root sessions get context only (classic.SessionStart additionalContext),
// no nudges, no handover action, no gating, and no rollover; native
// compaction is untouched. Only subagent child loops are measured (latest
// per-request turn.step usage, never cumulative, never the root window),
// nudged once per batch at the integer soft boundary, and stopped through a
// single stored record per agentId. Unverified integration risks (child
// feedback routing, tool availability under real allowlists, classifier
// review of short returns, resumptions, installed-package loading) are
// documented in the README, not claimed here.

import type {
  AgentInfo,
  AgentSpawnInput,
  AgentSpawnResult,
  ClassicBatchEvent,
  ClassicBatchResult,
  ClassicSessionStartEvent,
  ClassicSessionStartResult,
  ClassicSubagentStartEvent,
  ClassicSubagentStartResult,
  ClassicSubagentStopEvent,
  ClassicSubagentStopResult,
  Engine,
  On,
  RegisterOptions,
  SessionEndEvent,
  ToolCallEvent,
  ToolCallResult,
  TurnCompleteEvent,
  TurnStepEvent,
  TurnStepResult,
} from "./claude-types.ts"
import {
  activityKey,
  buildBaselineLine,
  buildChildShortReply,
  buildClaudeChildIntro,
  buildClaudeChildNudge,
  buildClaudeRootIntro,
  buildCompactReadback,
  buildExpiredChildDeny,
  buildExpiredReadback,
  buildChildTombstone,
  buildGenerationLine,
  buildHandoverStoredInstruction,
  buildLockedChildDeny,
  buildLockedChildReply,
  buildPendingLine,
  buildProvenanceReadback,
  buildReferenceReadback,
  buildSeedSizeLine,
  buildSuccessorMarker,
  buildSuccessorPayloadText,
  buildSuccessorPointer,
  chainActivityOf,
  CHILD_DEFAULT_SOFT,
  CHILD_HANDOVER_DESCRIPTION,
  CHILD_READ_DESCRIPTION,
  childRecordKey,
  classifyChain,
  classifySuccessorMarker,
  countNextSteps,
  estimateSeedTokens,
  estimateStoreBytes,
  extractNextStepsSection,
  formatHandbackDeliveredValue,
  formatOriginReadback,
  groupChains,
  HANDOVER_FULL,
  HANDOVER_TOOL,
  isChainActivity,
  isChainPin,
  isChildRecord,
  isChildTombstone,
  isOriginalRecord,
  isSpawnProvenance,
  mergeProvenance,
  orderEvictableChains,
  originalRecordKey,
  parseChildSoft,
  parseStoreKey,
  pinKey,
  READ_FULL,
  READ_TOOL,
  spawnRecordKey,
  softStage,
  STORE_BUDGET_BYTES,
  shortReplyOf,
  sumTurnUsage,
  type ChainActivity,
  type ChainPin,
  type ChildDiag,
  type ChildRecord,
  type ChildTombstone,
  type OriginalRecord,
  type SpawnProvenance,
} from "./child.ts"
import { formatDiagLine } from "../source/shared/handover-text.ts"

const SUBAGENT_HANDBACK = "SubagentHandback"

const HANDOVER_SCHEMA = {
  type: "object",
  properties: {
    handover: { type: "string" },
    summary: { type: "string" },
  },
  required: ["handover", "summary"],
} as Record<string, unknown>

// Reserved host identity (ToolCallEvent.agentId) is never a user argument:
// the read target is childId, supplied by the calling (parent) loop.
// Optional full:true returns full verbatim texts; default is compact.
const READ_SCHEMA = {
  type: "object",
  properties: {
    childId: { type: "string" },
    full: { type: "boolean" },
  },
  required: ["childId"],
} as Record<string, unknown>

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const storageDeny = (action: string, key: string, error: unknown): ToolCallResult => ({
  deny:
    `auto-context-handover: storage unavailable while ${action} (${key}), refusing to act: ` +
    `${error instanceof Error ? error.message : String(error)}`,
})

async function readRecord($: Engine, agentId: string): Promise<ChildRecord | ChildTombstone | undefined> {
  const value = await $.store.get(childRecordKey(agentId))
  if (isChildRecord(value)) return value
  if (isChildTombstone(value)) return value
  return undefined
}

async function readSpawnMeta($: Engine, agentId: string): Promise<SpawnProvenance | undefined> {
  try {
    const value = await $.store.get(spawnRecordKey(agentId))
    return isSpawnProvenance(value) ? value : undefined
  } catch {
    return undefined
  }
}

const provenanceOf = (record: ChildRecord | ChildTombstone | undefined): SpawnProvenance | undefined => {
  // Tolerant readback: sanitize optional metadata so malformed legacy or
  // hand-written records degrade to unknown instead of throwing. Empty
  // strings are treated as unknown. Never synthesize a pending-none claim.
  if (!record || typeof record !== "object") return undefined
  const raw: Record<string, unknown> = record as unknown as Record<string, unknown>
  const agentType = typeof raw.agentType === "string" && raw.agentType.length > 0 ? raw.agentType : undefined
  const override = (raw as { modelOverride?: unknown }).modelOverride
  const modelOverride =
    typeof override === "string" && override.length > 0 ? override : override === null ? null : undefined
  const predecessorAgentId = typeof raw.predecessorAgentId === "string" && raw.predecessorAgentId.length > 0
    ? (raw.predecessorAgentId as string)
    : undefined
  const originAgentId = typeof raw.originAgentId === "string" && raw.originAgentId.length > 0
    ? (raw.originAgentId as string)
    : undefined
  const generation = typeof raw.generation === "number" && Number.isInteger(raw.generation) && raw.generation >= 1
    ? (raw.generation as number)
    : undefined
  if (agentType === undefined && modelOverride === undefined && predecessorAgentId === undefined && originAgentId === undefined && generation === undefined) return undefined
  return {
    ...(agentType === undefined ? {} : { agentType }),
    ...(modelOverride === undefined ? {} : { modelOverride }),
    ...(predecessorAgentId === undefined ? {} : { predecessorAgentId }),
    ...(originAgentId === undefined ? {} : { originAgentId }),
    ...(generation === undefined ? {} : { generation }),
  }
}

async function readOriginal($: Engine, originAgentId: string): Promise<OriginalRecord | undefined> {
  try {
    const value = await $.store.get(originalRecordKey(originAgentId))
    return isOriginalRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Documented terminal agent-list statuses (AgentInfo: running, completed,
 * failed, killed, or another engine task status). Only these positively
 * terminal values filter; an absent status or any other engine value retains
 * liveness so an unknown vocabulary never strands a live loop.
 */
const TERMINAL_AGENT_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "killed"])

/** True for a listed loop that is still active: not a teammate and not positively terminal. */
const isLiveLoopAgent = (agent: AgentInfo): boolean => {
  if (agent.type === "teammate") return false
  const status = agent.status
  if (typeof status === "string" && TERMINAL_AGENT_STATUSES.has(status.trim().toLowerCase())) return false
  return true
}

/** True only for a known, non-teammate loop. Unknown/internal ids and teammates are ignored. Terminal status does not change identity: a completed loop is still a child for tool/gate purposes; liveness filtering belongs only to eviction protection (liveChainIds). */
async function isChildLoop($: Engine, agentId: string): Promise<boolean> {
  const agents = await $.agent.list()
  if (!Array.isArray(agents)) return false
  const found = agents.find((agent) => agent?.id === agentId)
  if (!found) return false
  if (found.type === "teammate") return false
  return true
}

export interface RetentionScan {
  readonly ok: boolean
  /** Whole-chain keys removed, in eviction order. */
  readonly evicted: string[]
  /** Chains dropped as tombstoned closures (lock preserved). */
  readonly tombstoned: string[]
  /** True when cleanup errors occurred; ok is always false then (explicit retry, never hidden behind success). */
  readonly partial: boolean
  readonly partialErrors: string[]
  /** Explicit quota/partial failure text when ok is false. Retryable. */
  readonly failure?: string
}

/**
 * Enumerate store keys with canonical direct host access ($.store.keys()).
 * Hosts without enumeration fail open (undefined, never an empty-list claim).
 */
async function listStoreKeys($: Engine): Promise<string[] | undefined> {
  try {
    return await $.store.keys()
  } catch {
    return undefined
  }
}

/** Explicit scan-failure result: no estimate was possible, nothing was deleted, nothing was stored, nothing locked. Retryable. */
const scanIncomplete = (detail: string, errors: string[]): RetentionScan => ({
  ok: false,
  evicted: [],
  tombstoned: [],
  partial: false,
  partialErrors: errors,
  failure:
    `auto-context-handover: store scan incomplete (${detail}); ` +
    `projected store cannot be estimated against the 3 MiB budget. ` +
    `Retry the write; no payload was stored and no lock was taken.`,
})

/**
 * Size-based whole-chain reclamation. Estimates the complete serialized store
 * with the pending replacement; while projected above budget, evicts the
 * oldest eligible whole chain (legacy/origin by last activity) until it fits.
 * Never evicts protected chains (current, inflight, live-listed, pinned),
 * uncertain-membership chains, unknown/other key families, or the pending
 * key's own chain. Closed child payloads become tombstones (lock preserved);
 * spawn/original/activity keys are deleted. Scans run on writes only; callers
 * must never invoke this from reads or lifecycle activity updates.
 */
export async function reclaimForWrite(
  $: Engine,
  pendingKey: string,
  pendingValue: unknown,
  protectChains: ReadonlySet<string>,
): Promise<RetentionScan> {
  const keys = await listStoreKeys($)
  // No silent success without a complete view: missing enumeration fails
  // explicitly (retryable) before any under-budget success, and never
  // authorizes deletion. An unreadable huge value could otherwise hide an
  // over-budget store.
  if (!Array.isArray(keys)) {
    return scanIncomplete("key enumeration unavailable", ["scan: store key enumeration unavailable"])
  }
  const byKey = new Map<string, unknown>()
  const unreadable: string[] = []
  for (const key of keys) {
    if (typeof key !== "string") continue
    try {
      const value = await $.store.get(key)
      // A concurrently deleted key reads back undefined: absent, not zero.
      if (value === undefined) continue
      byKey.set(key, value)
    } catch {
      // Unreadable entries are retained conservatively and excluded from
      // grouping. They cannot be sized, so a scan that must evict with an
      // incomplete view fails explicitly (retryable) instead of guessing.
      unreadable.push(key)
    }
  }
  // Unreadable entries fail before any under-budget success: without a
  // complete view no projection is trustworthy. No deletion is authorized.
  if (unreadable.length > 0) {
    return scanIncomplete(
      `${unreadable.length} unreadable keys, first: ${unreadable[0]}`,
      unreadable.map((key) => `scan ${key}: unreadable during size estimation`),
    )
  }
  const pendingParsed = parseStoreKey(pendingKey)
  const pendingId = pendingParsed.id
  let projected = estimateStoreBytes(byKey, { key: pendingKey, value: pendingValue })
  if (projected <= STORE_BUDGET_BYTES) return { ok: true, evicted: [], tombstoned: [], partial: false, partialErrors: [] }
  // Resolve the pending key's own chain so it is never evicted from under
  // the write (origin chains by origin id, legacy singletons by id).
  const pendingChain = await resolveChainOf($, byKey, pendingId, undefined).catch(() => undefined)
  const groups = groupChains(byKey)
  const livePins = new Set<string>()
  for (const [key, value] of byKey) {
    if (parseStoreKey(key).family === "pin" && isChainPin(value)) livePins.add(parseStoreKey(key).id)
  }
  // Combined per-ID membership uncertainty: child and spawn records for one
  // id classify merged (valid-but-conflicting origins are uncertain, never
  // guessed per-key), and any guard-invalid value or conflicting recorded
  // identity is uncertain too. Every raw nonempty-string predecessor/origin
  // ref (plus a mismatched claimed identity) shields its referenced chain,
  // since evicting it would strand the reference. Unknown/other families
  // stay size-only noncandidates.
  const childById = new Map<string, ChildRecord | ChildTombstone>()
  const spawnById = new Map<string, SpawnProvenance>()
  const rawRefsById = new Map<string, Set<string>>()
  const malformedMember = new Set<string>()
  const noteRawRef = (id: string, ref: unknown): void => {
    if (typeof ref !== "string" || ref.length === 0) return
    let refs = rawRefsById.get(id)
    if (!refs) {
      refs = new Set<string>()
      rawRefsById.set(id, refs)
    }
    refs.add(ref)
  }
  for (const [key, value] of byKey) {
    const parsed = parseStoreKey(key)
    if (parsed.family !== "child" && parsed.family !== "spawn") continue
    if (parsed.family === "child" && (isChildRecord(value) || isChildTombstone(value))) {
      if (value.agentId !== parsed.id) malformedMember.add(parsed.id)
      else childById.set(parsed.id, value)
    } else if (parsed.family === "spawn" && isSpawnProvenance(value)) {
      spawnById.set(parsed.id, value)
    } else if (value !== undefined) {
      malformedMember.add(parsed.id)
    }
    if (value !== null && typeof value === "object") {
      const raw = value as Record<string, unknown>
      noteRawRef(parsed.id, raw.predecessorAgentId)
      noteRawRef(parsed.id, raw.originAgentId)
      if (parsed.family === "child") noteRawRef(parsed.id, raw.agentId)
    }
  }
  const uncertainRefs = new Set<string>()
  for (const id of new Set<string>([...childById.keys(), ...spawnById.keys(), ...malformedMember, ...rawRefsById.keys()])) {
    if (!malformedMember.has(id) && classifyChain(childById.get(id), spawnById.get(id)).kind !== "uncertain") continue
    for (const ref of rawRefsById.get(id) ?? []) uncertainRefs.add(ref)
  }
  const eligible = orderEvictableChains(groups).filter((group) => {
    if (protectChains.has(group.chain)) return false
    if (uncertainRefs.has(group.chain)) return false
    if (pendingChain !== undefined && group.chain === pendingChain) return false
    // The pending singleton id itself is always current (legacy or origin member).
    if (group.kind === "legacy" && group.chain === pendingId) return false
    for (const key of group.keys) {
      if (key === pendingKey) return false
      const parsed = parseStoreKey(key)
      if ((parsed.family === "child" || parsed.family === "spawn") && protectChains.has(parsed.id)) return false
      if ((parsed.family === "child" || parsed.family === "spawn") && livePins.has(parsed.id)) return false
      if ((parsed.family === "child" || parsed.family === "spawn") && uncertainRefs.has(parsed.id)) return false
    }
    return true
  })
  const evicted: string[] = []
  const tombstoned: string[] = []
  const partialErrors: string[] = []
  for (const group of eligible) {
    if (projected <= STORE_BUDGET_BYTES) break
    // Tombstone closed child payloads first (lock preservation), then delete
    // the remaining chain keys. Tombstones consume space; account for them.
    let tombstoneFailed = false
    for (const key of group.keys) {
      const parsed = parseStoreKey(key)
      if (parsed.family !== "child") continue
      const current = byKey.get(key)
      if (!isChildRecord(current)) continue
      // Preserve grouping across a partial retry: merge validated spawn
      // provenance so a child that raced its metadata keeps its origin link
      // instead of collapsing to a legacy singleton. Preserve the original
      // member timestamp (or the chain's pre-eviction activity) so evicting
      // does not refresh the chain's age behind newer chains on retry.
      const spawnValue = byKey.get(spawnRecordKey(parsed.id))
      const merged = mergeProvenance(
        provenanceOf(current),
        isSpawnProvenance(spawnValue) ? spawnValue : undefined,
      )
      const tomb = buildChildTombstone({
        agentId: parsed.id,
        storedAt: typeof current.storedAt === "number"
          ? current.storedAt
          : group.lastActive > 0
            ? group.lastActive
            : Date.now(),
        ...(merged?.predecessorAgentId === undefined ? {} : { predecessorAgentId: merged.predecessorAgentId }),
        ...(merged?.originAgentId === undefined ? {} : { originAgentId: merged.originAgentId }),
        ...(merged?.generation === undefined ? {} : { generation: merged.generation }),
      })
      try {
        await $.store.set(key, tomb)
        byKey.set(key, tomb)
        tombstoned.push(parsed.id)
      } catch (error) {
        tombstoneFailed = true
        partialErrors.push(`tombstone ${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (tombstoneFailed) {
      // A chain whose lock cannot be preserved stays whole: sibling keys are
      // retained (never split) so the next write can retry the full chain.
      partialErrors.push(`retain ${group.chain}: tombstone failed, chain kept whole for retry`)
      projected = estimateStoreBytes(byKey, { key: pendingKey, value: pendingValue })
      continue
    }
    for (const key of group.keys) {
      const parsed = parseStoreKey(key)
      if (parsed.family === "child") {
        const current = byKey.get(key)
        // Tombstoned payloads stay as tombstones; only remove non-record keys here.
        if (isChildTombstone(current)) continue
        if (isChildRecord(current)) continue
      }
      try {
        await $.store.delete(key)
        byKey.delete(key)
        evicted.push(key)
      } catch (error) {
        partialErrors.push(`delete ${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Chains whose child payloads were tombstoned but whose tombstone writes
    // failed keep their payloads (retained, retryable) — never deleted.
    projected = estimateStoreBytes(byKey, { key: pendingKey, value: pendingValue })
  }
  // Any cleanup error fails explicitly (retryable), even when the projected
  // store now fits: partial cleanup must never be silently hidden behind an
  // ok:true. Error recording rides in partialErrors/evicted/tombstoned.
  if (projected <= STORE_BUDGET_BYTES && partialErrors.length === 0) {
    return { ok: true, evicted, tombstoned, partial: false, partialErrors }
  }
  const failure = partialErrors.length > 0 && projected <= STORE_BUDGET_BYTES
    ? `auto-context-handover: store cleanup incomplete (${partialErrors.length} errors, first: ${partialErrors[0]}); ` +
      `projected store fits the 3 MiB budget but partial cleanup failed. Retry the write to complete cleanup; no payload was stored and no lock was taken.`
    : partialErrors.length > 0
      ? `auto-context-handover: store budget exceeded and partial cleanup failed (${partialErrors.length} errors, first: ${partialErrors[0]}); ` +
        `projected store remains over the 3 MiB budget. Retry the write after activity settles; no payload was stored and no lock was taken.`
      : `auto-context-handover: store budget exceeded with no safely evictable chains (current, active, and uncertain-membership chains are protected); ` +
        `projected store remains over the 3 MiB budget. Retry later; no payload was stored and no lock was taken.`
  return { ok: false, evicted, tombstoned, partial: partialErrors.length > 0, partialErrors, failure }
}

/**
 * Resolve the whole-chain id for one agent id: merged stored origin wins;
 * a stored predecessor without an origin is uncertain (undefined, never
 * guessed); otherwise the id itself is a legacy singleton chain. Memory
 * provenance supplements the store for in-flight ids.
 */
export async function resolveChainOf(
  $: Engine,
  byKey: Map<string, unknown>,
  agentId: string,
  memory: SpawnProvenance | undefined,
): Promise<string | undefined> {
  const childValue = byKey.get(childRecordKey(agentId))
  const child = isChildRecord(childValue) || isChildTombstone(childValue) ? childValue : undefined
  let spawn = memory
  const spawnValue = byKey.get(spawnRecordKey(agentId))
  if (spawn === undefined && isSpawnProvenance(spawnValue)) spawn = spawnValue
  const classified = classifyChain(child, spawn)
  if (classified.kind === "origin") return classified.origin
  if (classified.kind === "uncertain") return undefined
  return agentId
}

/** Best-effort activity refresh. Never triggers an eviction scan; failures are ignored. Returns false when the refresh did not persist. */
async function touchChainActivity($: Engine, chain: string | undefined): Promise<boolean> {
  if (chain === undefined) return true
  try {
    const key = activityKey(chain)
    const current = await $.store.get(key)
    void chainActivityOf(chain, new Map([[key, current]]))
    await $.store.set(key, { lastActive: Date.now() } satisfies ChainActivity)
    return true
  } catch {
    // Activity is advisory; reads and continuations never fail for it.
    return false
  }
}

/** Best-effort active pin for a newly spawned child. Never triggers a scan. Returns false when the pin did not persist. */
async function pinActiveChild($: Engine, agentId: string): Promise<boolean> {
  try {
    const owner = await $.session.id()
    if (typeof owner !== "string" || owner.length === 0) return false
    await $.store.set(pinKey(agentId), { owner, updatedAt: Date.now() } satisfies ChainPin)
    return true
  } catch {
    // Pins are conservative protection; spawn never fails for them.
    return false
  }
}

/** Live non-teammate, non-terminal loop ids for eviction protection. Terminal statuses (completed/failed/killed) release their chains; unknown statuses retain. List outages protect nothing extra. */
async function liveChainIds($: Engine): Promise<Set<string>> {
  const ids = new Set<string>()
  try {
    const agents = await $.agent.list()
    if (Array.isArray(agents)) {
      for (const agent of agents) {
        if (typeof agent?.id === "string" && agent.id.length > 0 && isLiveLoopAgent(agent)) ids.add(agent.id)
      }
    }
  } catch {
    // List outages protect nothing extra; pins and inflight still apply.
  }
  return ids
}

const quotaDeny = (scan: RetentionScan, key: string): ToolCallResult => ({
  deny:
    `auto-context-handover: storage budget refuses the write (${key}); ` +
    `${scan.failure ?? "projected store exceeds the 3 MiB budget with no safely evictable chains."} ` +
    (scan.partial ? `Partial cleanup removed ${scan.evicted.length} keys with ${scan.partialErrors.length} errors; retry the same call. ` : `Retry the same call; `) +
    `nothing was stored and the child is not locked.`,
})

export const register = (on: On, options?: RegisterOptions): void => {
  const soft = options?.soft === undefined ? CHILD_DEFAULT_SOFT : parseChildSoft(options.soft)
  const usageCache = new Map<string, number>()
  const inflight = new Set<string>()
  const correctedStops = new Set<string>()
  // Actual delivered-nudge provenance, independent of the latest usage.
  // In-memory only: a reload loses it, so the reason falls back to unknown.
  const nudged = new Set<string>()
  // Per-child delivery state, scoped to the current turn only.
  const childTurn = new Map<string, string>()
  // Previously seen turn ids per child (bounded): a step whose turn id was
  // seen before while a different turn is tracked is a late/superseded
  // callback, never a new turn. Without this the entry block below would
  // adopt the stale id, defeating the post-next superseded guard and
  // resurrecting measurements (and clearing fresh correction latches).
  const turnSeen = new Map<string, Set<string>>()
  const handbackOk = new Set<string>()
  // Observed spawn provenance (type + requested model override). In-memory
  // first; mirrored to `spawn:<childId>` so a reload retains it for the
  // eventual ChildRecord. Never the effective result model or usage model.
  const spawnSeen = new Map<string, SpawnProvenance>()
  // Bounded insertion: every spawnSeen write goes through here so hydration
  // paths cannot bypass the 1000-entry cap enforced on initial spawns.
  const rememberSpawn = (id: string, value: SpawnProvenance): void => {
    spawnSeen.set(id, value)
    if (spawnSeen.size > 1000) {
      const oldest = spawnSeen.keys().next()
      if (!oldest.done) spawnSeen.delete(oldest.value)
    }
  }
  // Original-capture failures by origin id (actual store error text). Memory
  // only: after a reload the readback reports unknown capture status.
  const originalErrorSeen = new Map<string, string>()
  // Baseline/start context (first measured per-request total) and last-batch
  // increase (latest minus previous). In-memory only: reload loses them, so
  // handover diagnostics degrade honestly to unknown. Retired by the stop
  // hook and matching turn completion (retireMeasurementCaches) and at
  // session end.
  // Baseline is eligible only for a newly observed launch in this
  // registration: classic.SubagentStart for an id with no prior stored
  // spawn/closed-child metadata and no previously loaded spawn metadata.
  // Reload/mid-child/unobserved starts stay
  // unknown; growth still tracks consecutive measurements. A completed turn
  // retires the baseline, so a resume after completion measures with honest
  // unknown baseline (never fabricated); while a turn is still active,
  // resumes never reset an established baseline; turn.index is never a start
  // signal.
  const baselineSeen = new Map<string, number>()
  const growthSeen = new Map<string, number>()
  const baselineEligible = new Set<string>()
  const spawnObservedHere = new Set<string>()
  // Chains with pre-next protection (successor predecessor reference held
  // before agent.spawn returns, so concurrent writes cannot evict them).
  // Reference-counted: overlapping same-predecessor spawns each hold a
  // reservation, so the first result must not release protection while a
  // second spawn's next is still pending. Released exactly once by the spawn
  // hook's finally block (single cleanup authority, including on rejection).
  const reservedChains = new Map<string, number>()
  const reserveChain = (id: string | undefined): void => {
    if (id === undefined) return
    reservedChains.set(id, (reservedChains.get(id) ?? 0) + 1)
  }
  const releaseChain = (id: string | undefined): void => {
    if (id === undefined) return
    const left = (reservedChains.get(id) ?? 0) - 1
    if (left <= 0) reservedChains.delete(id)
    else reservedChains.set(id, left)
  }
  // Measurement caches retired by stop/turn-complete/session-end pruning. Turn-step
  // callbacks skip retired ids so late results never repopulate them.
  // Handback correction state (handbackOk/correctedStops/childTurn) is never
  // retired here, so pruning cannot regress stop-lock enforcement.
  const retiredCaches = new Set<string>()

  const retireMeasurementCaches = (agentId: string): void => {
    usageCache.delete(agentId)
    baselineSeen.delete(agentId)
    growthSeen.delete(agentId)
    baselineEligible.delete(agentId)
    spawnObservedHere.delete(agentId)
    const seen = spawnSeen.get(agentId)
    if (seen !== undefined) {
      // Rehydratable from the store by the reader; dropping is honest unknown.
      spawnSeen.delete(agentId)
    }
    nudged.delete(agentId)
    retiredCaches.add(agentId)
    // Bounded so long-lived roots cannot leak one entry per handed-over
    // child; evicting the oldest may unblock an ancient late callback, which
    // is harmless (batch/stop re-check the closed lock before acting).
    if (retiredCaches.size > 1000) {
      const oldest = retiredCaches.values().next()
      if (!oldest.done) retiredCaches.delete(oldest.value)
    }
  }

  on("session.start", async ($: Engine, event: unknown, next: (event: unknown) => Promise<unknown>) => {
    await $.tool.register({ name: HANDOVER_TOOL, description: CHILD_HANDOVER_DESCRIPTION, inputSchema: HANDOVER_SCHEMA })
    await $.tool.register({ name: READ_TOOL, description: CHILD_READ_DESCRIPTION, inputSchema: READ_SCHEMA })
    return next(event)
  }).catch(async (_$, event, next) => {
    // Registration failure must not stop the session; next is replay-safe.
    return next(event)
  })

  // Root-only context: classic.SessionStart additionalContext is pre-prompt
  // non-tool-result context. Guard on a truly absent agent_id (not
  // agent_type) so custom-agent roots still receive context while child
  // loops do not. A present id of any shape (string, empty, null, number)
  // is not a root and is skipped; invalid events/results fail open.
  // Startup/resume/clear/compact/fork all reinject; context only, never a
  // compaction, measurement, nudge, handover, or gating change. The native
  // session.start hook above stays registration-only. Advisory fail-open.
  on("classic.SessionStart", async ($: Engine, event: ClassicSessionStartEvent, next: (event: ClassicSessionStartEvent) => Promise<ClassicSessionStartResult>) => {
    const result = await next(event)
    try {
      if (typeof result !== "object" || result === null) return result
      if (typeof event !== "object" || event === null) return result
      if ((event as Record<string, unknown>).agent_id !== undefined) return result
      return { ...result, additionalContext: [...(result.additionalContext ?? []), buildClaudeRootIntro()] }
    } catch {
      return result
    }
  }).catch(async (_$, event, next) => {
    // Advisory only. If next.called, this replays the unchanged chain result.
    return next(event)
  })

  // Observe-only spawn provenance: record the requested subagentType and
  // model override as seen at this hook, keyed by the resolved child id.
  // A handover stored inside next (before the result id returns) closes the
  // child record first; the post-next persistence below still writes the
  // standalone spawn/original metadata (never the handover text) so the
  // reader can merge it back. SubagentStart agent_type (the type of the
  // child actually launched) fills a missing type only and never overwrites
  // a recorded spawn type; the effective result model is never treated as
  // an override. Undefined model means agent default then parent (recorded
  // as no override); fork ignores model (recorded as no override);
  // malformed model stays unknown. Lineage is observe-only: the marker is
  // classified synchronously from the spawn prompt before next (leading
  // marker only; quoted/mid-text is absent, a broken reserved prefix is
  // malformed and never a new origin), then resolved to origin and
  // generation after next returns the child id. The original prompt is
  // captured once per chain for marker-free origin spawns only; successors
  // inherit it by origin reference and never store a duplicate. A capture
  // failure keeps its actual error text in memory for the readback. Denied
  // spawns and missing ids store nothing. Never rewrite spawn/model/prompt;
  // never touch closed child records. Fail-open preserves the spawn result.
  on("agent.spawn", async ($: Engine, event: AgentSpawnInput, next: (event: AgentSpawnInput) => Promise<AgentSpawnResult>) => {
    const raw = event as Record<string, unknown>
    const requestedType = typeof raw?.subagentType === "string" && (raw.subagentType as string).length > 0 ? (raw.subagentType as string) : undefined
    const rawModel = raw?.model
    const requestedOverride: string | null | undefined =
      typeof rawModel === "string" && rawModel.length > 0 ? rawModel : rawModel === undefined ? null : undefined
    const forked = raw?.fork === true
    // Synchronous pre-next capture: classification and prompt are read before
    // next so a handover stored inside next is still recoverable afterwards.
    // Current-chain protection starts here: a valid predecessor id is
    // reserved before next so concurrent reclamation cannot evict its chain.
    const classified = classifySuccessorMarker(raw?.prompt)
    const rawPrompt = raw?.prompt
    const observedPrompt = typeof rawPrompt === "string" && rawPrompt.length > 0 ? rawPrompt : undefined
    if (classified.status === "valid" && classified.predecessor !== undefined) reserveChain(classified.predecessor)
    try {
      const result = await next(event)
      try {
        if (typeof result !== "object" || result === null) {
          return result
        }
        const record = result as Record<string, unknown>
        if (typeof record.deny === "string" && record.deny.length > 0) {
          return result
        }
        const childId = typeof record.agentId === "string" && record.agentId.length > 0 ? (record.agentId as string) : undefined
        if (childId === undefined) {
          return result
        }
        // Launch observed in this registration via the spawn hook. Records a
        // same-launch SubagentStart as newly observed even after this hook
        // persists spawn metadata to the store.
        spawnObservedHere.add(childId)
        const meta: SpawnProvenance = {
          ...(requestedType === undefined ? {} : { agentType: requestedType }),
          modelOverride: forked ? null : requestedOverride,
        }
        if (classified.status === "valid" && classified.predecessor !== undefined) {
          // Successor: link to the predecessor only through its stored
          // handover (or its expiry tombstone, which preserves lineage).
          // A missing stored handover stays honestly unknown:
          // predecessor id is kept, origin/generation are absent, never a
          // reset new origin and never fabricated from the predecessor id or
          // from running-only spawn metadata without a stored handover.
          // An expired tombstone predecessor keeps its preserved origin link
          // but never fabricates a new origin.
          const markerPredecessor = classified.predecessor
          let origin: string | undefined
          let generation: number | undefined
          try {
            const pred = await readRecord($, markerPredecessor).catch(() => undefined)
            if (pred !== undefined && !isChildTombstone(pred)) {
              const predProv = provenanceOf(pred)
              let fallback = spawnSeen.get(markerPredecessor)
              if (fallback === undefined) {
                fallback = await readSpawnMeta($, markerPredecessor).catch(() => undefined)
                if (fallback !== undefined) rememberSpawn(markerPredecessor, fallback)
              }
              const merged = mergeProvenance(predProv, fallback)
              if (merged?.originAgentId !== undefined) origin = merged.originAgentId
              if (merged?.generation !== undefined) generation = merged.generation + 1
            } else if (pred !== undefined) {
              // Expired predecessor: inherit preserved tombstone lineage only.
              if (typeof pred.originAgentId === "string" && pred.originAgentId.length > 0) origin = pred.originAgentId
              if (typeof pred.generation === "number") generation = pred.generation + 1
            }
          } catch {
            // Lineage lookups fail open; predecessor link is still kept.
          }
          Object.assign(meta, { predecessorAgentId: markerPredecessor })
          if (origin !== undefined) Object.assign(meta, { originAgentId: origin })
          if (generation !== undefined) Object.assign(meta, { generation })
        } else if (classified.status === "absent") {
          Object.assign(meta, { originAgentId: childId, generation: 1 })
        } else if (classified.status === "malformed") {
          // Unresolvable lineage: persist an explicit uncertainty signal so the
          // chain is never mistaken for an evictable legacy singleton.
          Object.assign(meta, { lineageUncertain: true })
        }
        if (meta.agentType === undefined && meta.modelOverride === undefined && meta.predecessorAgentId === undefined && meta.originAgentId === undefined && meta.generation === undefined && meta.lineageUncertain !== true) {
          return result
        }
        // Freshness for spawn-only chains: a new spawn sorts by recency even
        // when pin/activity writes below fail; legacy records without a stamp
        // still sort oldest. Never a lineage claim.
        Object.assign(meta, { storedAt: Date.now() })
        rememberSpawn(childId, meta)
        try {
          const prior = await readSpawnMeta($, childId)
          const merged: SpawnProvenance = mergeProvenance(meta, prior) ?? meta
          rememberSpawn(childId, merged)
          // Size-budget reclamation before the metadata write. Current chain
          // (new id plus predecessor/origin reference), inflight chains, and
          // live-listed chains are protected. Quota/partial failures fail open:
          // the native spawn result stands, metadata stays memory-only.
          try {
            const live = await liveChainIds($)
            const protect = new Set<string>([...reservedChains.keys(), ...inflight, ...live])
            if (merged.originAgentId !== undefined) protect.add(merged.originAgentId)
            if (merged.predecessorAgentId !== undefined) protect.add(merged.predecessorAgentId)
            protect.add(childId)
            const scan = await reclaimForWrite($, spawnRecordKey(childId), merged, protect)
            if (!scan.ok) {
              return result
            }
          } catch {
            // Reclamation failures fail open; persistence below still tries.
          }
          // Standalone persistence even when the child record already closed
          // (handover inside next). Writes only spawn:/original: keys, never
          // the handover text. A tombstoned child record is never resurrected:
          // spawn metadata still persists for lineage merging.
          await $.store.set(spawnRecordKey(childId), merged).catch(() => undefined)
          // Active pin and chain activity ride without eviction scans.
          await pinActiveChild($, childId)
          await touchChainActivity($, merged.originAgentId ?? childId)
          if (classified.status === "absent" && observedPrompt !== undefined) {
            // Origin only: store the original prompt once per chain. Never
            // overwrite an existing original; successors never store one.
            // An original write rejection persists its bounded error text in
            // spawn provenance when that small metadata write succeeds, so the
            // cause survives a reload; if every write fails the readback
            // degrades honestly to unknown.
            try {
              const existingOriginal = await $.store.get(originalRecordKey(childId)).catch(() => undefined)
              if (!isOriginalRecord(existingOriginal)) {
                const original: OriginalRecord = { prompt: observedPrompt, originAgentId: childId, storedAt: Date.now() }
                try {
                  try {
                    const live = await liveChainIds($)
                    const protect = new Set<string>([...reservedChains.keys(), ...inflight, ...live, childId])
                    const scan = await reclaimForWrite($, originalRecordKey(childId), original, protect)
                    if (!scan.ok) throw new Error(scan.failure ?? "store budget exceeded")
                  } catch {
                    // Reclamation failure degrades to the capture-error path below.
                    throw new Error("store budget exceeded: no safely evictable space for the original prompt")
                  }
                  await $.store.set(originalRecordKey(childId), original)
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error)
                  const bounded = message.slice(0, 300)
                  originalErrorSeen.set(childId, bounded)
                  if (originalErrorSeen.size > 1000) {
                    const oldest = originalErrorSeen.keys().next()
                    if (!oldest.done) originalErrorSeen.delete(oldest.value)
                  }
                  const withError: SpawnProvenance = mergeProvenance({ originalCaptureError: bounded }, spawnSeen.get(childId)) ?? { originalCaptureError: bounded }
                  rememberSpawn(childId, withError)
                  await $.store.set(spawnRecordKey(childId), withError).catch(() => undefined)
                }
              }
            } catch {
              // In-memory lineage remains; readback reports unknown original.
            }
          }
        } catch {
          // In-memory provenance remains; reload degrades honestly to unknown.
        }
        } catch {
          // Post-next observation failures stay fail-open (never a retry,
          // never a reshaped spawn result): in-memory provenance remains;
          // reload degrades honestly to unknown.
        }
        return result
    } finally {
      // Single cleanup authority for the whole reserved lifetime: every path
      // above returns without releasing, so the reservation survives all
      // post-next awaits and is freed exactly once here, even when next or
      // the post-next work rejects. A rejected next propagates its original
      // failure unchanged (never masked, never rerun here); refcounts keep
      // overlapping same-predecessor spawns protected until each settles.
      releaseChain(classified.predecessor)
    }
  }).catch(async (_$, event, next) => {
    return next(event)
  })

  // Unknown ids still get the introduction: listing visibility at start
  // is not guaranteed. Repeat/resume delivery is host-deduplicated.
  // SubagentStart exposes the launched child type but no model override, so
  // it fills a missing type only when no spawn provenance exists. Never
  // overwrites a closed record, a recorded spawn type, or a recorded
  // override; spawn params stay as observed, not authoritative final.
  on("classic.SubagentStart", async ($: Engine, event: ClassicSubagentStartEvent, next: (event: ClassicSubagentStartEvent) => Promise<ClassicSubagentStartResult>) => {
    const result = await next(event)
    try {
      if (typeof result !== "object" || result === null) return result
      const agentId = asString(event?.agent_id)
      if (agentId === undefined || agentId === "") return result
      let teammate = false
      try {
        const agents = await $.agent.list()
        teammate = Array.isArray(agents) && agents.some((agent) => agent?.id === agentId && agent?.type === "teammate")
      } catch {
        teammate = false
      }
      if (teammate) return result
      // Baseline eligibility: a newly observed launch in this registration
      // only. Never resets an established baseline/eligibility (resumes run
      // this hook again). Store outages stay unknown, never eligible.
      if (!baselineEligible.has(agentId) && !baselineSeen.has(agentId)) {
        try {
          if (spawnObservedHere.has(agentId)) {
            baselineEligible.add(agentId)
          } else if (!spawnSeen.has(agentId)) {
            const closed = await $.store.get(childRecordKey(agentId))
            const stored = closed === undefined ? await $.store.get(spawnRecordKey(agentId)) : undefined
            if (closed === undefined && stored === undefined) baselineEligible.add(agentId)
          }
        } catch {
          // Fail closed: without proof of a new first observation, baseline stays unknown.
        }
      }
      const fallbackType = asString(event?.agent_type)
      if (fallbackType !== undefined && fallbackType !== "") {
        try {
          const closed = await readRecord($, agentId).catch(() => undefined)
          if (!closed?.closed) {
            const seen = spawnSeen.get(agentId)
            if (seen?.agentType === undefined) {
              const stored = await readSpawnMeta($, agentId)
              if (stored?.agentType === undefined) {
                // Fill the missing type only; every other lineage field
                // rides along from memory or stored metadata.
                const merged = mergeProvenance({ agentType: fallbackType }, seen ?? stored)
                if (merged !== undefined) {
                  // Stamp freshness like the spawn hook so the fallback chain
                  // sorts by recency when pin/activity writes fail.
                  const stamped: SpawnProvenance = { ...merged, storedAt: merged.storedAt ?? Date.now() }
                  rememberSpawn(agentId, stamped)
                  // Related metadata write: reclaim first, fail open.
                  try {
                    const live = await liveChainIds($)
                    const protect = new Set<string>([...reservedChains.keys(), ...inflight, ...live, agentId])
                    if (stamped.originAgentId !== undefined) protect.add(stamped.originAgentId)
                    const scan = await reclaimForWrite($, spawnRecordKey(agentId), stamped, protect)
                    if (scan.ok) await $.store.set(spawnRecordKey(agentId), stamped).catch(() => undefined)
                  } catch {
                    await $.store.set(spawnRecordKey(agentId), stamped).catch(() => undefined)
                  }
                }
              } else if (seen === undefined) {
                rememberSpawn(agentId, stored)
              }
            }
          }
        } catch {
          // Fallback only; intro delivery below still runs.
        }
      }
      // Continuation activity refresh (no eviction scan): a start/resume keeps
      // its chain young. Best-effort, advisory only.
      try {
        const rec = await readRecord($, agentId).catch(() => undefined)
        const meta = spawnSeen.get(agentId) ?? await readSpawnMeta($, agentId).catch(() => undefined)
        const origin = rec !== undefined && !isChildTombstone(rec) && typeof rec.originAgentId === "string"
          ? rec.originAgentId
          : isChildTombstone(rec) && typeof rec.originAgentId === "string"
            ? rec.originAgentId
            : meta?.originAgentId ?? agentId
        await touchChainActivity($, origin)
      } catch {
        // Advisory only.
      }
      return { ...result, additionalContext: [...(result.additionalContext ?? []), buildClaudeChildIntro()] }
    } catch {
      return result
    }
  }).catch(async (_$, event, next) => {
    // Advisory only. If next.called, this replays the unchanged chain result.
    return next(event)
  })

  // Observe only: cache the latest usable per-request total per child loop.
  // Root steps (no agentId), invalid/missing usage, and teammate or unknown
  // loops fail open and clear any cached value. Turn identity is tracked at
  // entry (before tools run inside next); usage timing still updates after.
  on("turn.step", async function* (
    $: Engine,
    event: TurnStepEvent,
    next: (
      step: TurnStepEvent,
    ) => AsyncGenerator<{ readonly kind: string }, TurnStepResult, TurnStepResult | undefined>,
  ) {
    try {
      const agentId = asString(event?.agentId)
      const turnId = asString(event?.turnId)
      if (agentId !== undefined && agentId !== "" && turnId !== undefined && turnId !== "") {
        const tracked = childTurn.get(agentId)
        const known = turnSeen.get(agentId)?.has(turnId) ?? false
        if (known && tracked !== turnId) {
          // Late/superseded callback from an older turn: leave the tracked
          // turn, the correction latches, and the measurements alone. The
          // post-next guard below skips the measurement update as well.
        } else {
          if (tracked !== turnId) {
            // New (or resumed) turn: prior handback delivery and the
            // one-correction latch belong to the previous turn only.
            childTurn.set(agentId, turnId)
            handbackOk.delete(agentId)
            correctedStops.delete(agentId)
          }
          let seen = turnSeen.get(agentId)
          if (!seen) {
            seen = new Set<string>()
            turnSeen.set(agentId, seen)
            if (turnSeen.size > 1000) {
              const oldest = turnSeen.keys().next()
              if (!oldest.done) turnSeen.delete(oldest.value)
            }
          }
          seen.add(turnId)
          if (seen.size > 10) {
            const oldest = seen.values().next()
            if (!oldest.done) seen.delete(oldest.value)
          }
          if (tracked !== turnId) {
            // Genuinely new turn: re-enable measurements for open children
            // and pin the active chain BEFORE the first request runs
            // in-flight, so cross-session reclamation cannot evict it mid
            // flight. Closed children stay retired and unpinned (their lock
            // holds; no bodies are reintroduced); a verification outage
            // keeps the retired state instead of re-adopting it. Diagnostics
            // stay honestly unknown after retirement: no fresh baseline is
            // fabricated here. Recheck the tracked turn after each await: a
            // superseding callback may have moved on while suspended.
            let verifiedOpen = false
            try {
              const closed = await readRecord($, agentId)
              if (childTurn.get(agentId) === turnId && !closed?.closed) verifiedOpen = true
            } catch {
              verifiedOpen = false
            }
            if (verifiedOpen) {
              retiredCaches.delete(agentId)
              const knownChild = await isChildLoop($, agentId).catch(() => false)
              if (knownChild && childTurn.get(agentId) === turnId) await pinActiveChild($, agentId)
            }
          }
        }
      }
    } catch {
      // Identity-only; never affects the turn.
    }
    const result: TurnStepResult = yield* next(event)
    try {
      const agentId = asString(event?.agentId)
      if (agentId === undefined || agentId === "") {
        return result
      }
      // Retired caches stay retired: late step callbacks for pruned
      // (handed-over/stopped) children must not repopulate measurement state.
      if (retiredCaches.has(agentId)) return result
      // A late step callback from a superseded turn (turn id differs from the
      // tracked current turn) must not rewrite measurement state either.
      // Steps without turn identity (legacy) still update as before.
      const stepTurnId = asString(event?.turnId)
      if (stepTurnId !== undefined && stepTurnId !== "") {
        const currentTurnId = childTurn.get(agentId)
        if (currentTurnId !== undefined && currentTurnId !== stepTurnId) return result
      }
      const total = sumTurnUsage(result?.usage)
      if (total === undefined) {
        usageCache.delete(agentId)
        growthSeen.delete(agentId)
        return result
      }
      const child = await isChildLoop($, agentId).catch(() => false)
      if (!child) {
        usageCache.delete(agentId)
        growthSeen.delete(agentId)
        return result
      }
      // Baseline is the first measured per-request total after a newly
      // observed launch in this registration; growth is the last batch
      // increase (latest minus previous). Consecutive actual measurements
      // only; invalid steps clear the last value so growth degrades to
      // unknown instead of inventing a delta. Unobserved, mid-child, and
      // reload measurements keep baseline unknown while growth still tracks
      // consecutive totals (including negative compaction deltas).
      const previous = usageCache.get(agentId)
      if (baselineEligible.has(agentId) && !baselineSeen.has(agentId)) baselineSeen.set(agentId, total)
      else if (previous !== undefined) growthSeen.set(agentId, total - previous)
      else growthSeen.delete(agentId)
      usageCache.set(agentId, total)
    } catch {
      // Fail open: measurement or host failures leave the turn untouched.
    }
    return result
  })

  // Turn completion retires per-child correction and measurement state
  // safely. The stop hook never clears the one-correction latch (a resumable
  // blocked stop must keep it); only an actually completed turn does. Entries
  // are dropped only when the completed turn matches the tracked turn (or the
  // event carries no turn identity); a mismatched turn id leaves live
  // newer-turn state alone. A matching completed turn also retires
  // measurement/provenance/nudge state (usage, baseline, growth, eligibility,
  // observed-spawn, nudge flags) with honest-unknown degradation, and drops
  // the active pin so long-lived roots can reclaim the history; a genuinely
  // new open turn re-enables measurements and re-pins on its next turn.step
  // (a subagent run raises no turn.start). Retirement persists (1000-capped,
  // freed at session end) so late step callbacks for a closed child cannot
  // repopulate caches. Advisory, no scan.
  on("turn.complete", async ($: Engine, event: TurnCompleteEvent, next: (event: TurnCompleteEvent) => Promise<unknown>) => {
    const result = await next(event)
    try {
      const raw = event as Record<string, unknown> | null
      const agentId = typeof raw?.agentId === "string" && (raw.agentId as string).length > 0 ? (raw.agentId as string) : undefined
      if (agentId !== undefined) {
        const turnId = typeof raw?.turnId === "string" && (raw.turnId as string).length > 0 ? (raw.turnId as string) : undefined
        const tracked = childTurn.get(agentId)
        if (turnId === undefined || tracked === undefined || tracked === turnId) {
          childTurn.delete(agentId)
          handbackOk.delete(agentId)
          correctedStops.delete(agentId)
          retireMeasurementCaches(agentId)
          await $.store.delete(pinKey(agentId)).catch(() => undefined)
        }
      }
    } catch {
      // Advisory only.
    }
    return result
  }).catch(async (_$, event, next) => {
    return next(event)
  })

  // Runs before the next request: await the chain, then append the staged
  // child nudge without changing any other hook output. "Nudged" means this
  // hook appended the nudge to the batch result (sent); there is no receipt
  // that the child observed it. Suppressed/failed batches and failed context
  // composition never count: the set updates only after composition succeeds.
  on("classic.PostToolBatch", async ($: Engine, event: ClassicBatchEvent, next: (event: ClassicBatchEvent) => Promise<ClassicBatchResult>) => {
    const result = await next(event)
    try {
      if (typeof result !== "object" || result === null) return result
      const agentId = asString(event?.agent_id)
      if (agentId === undefined || agentId === "") return result
      const last = usageCache.get(agentId)
      if (last === undefined) return result
      const child = await isChildLoop($, agentId).catch(() => false)
      if (!child) return result
      let existing: ChildRecord | ChildTombstone | undefined
      try {
        existing = await readRecord($, agentId)
      } catch {
        // Fail open: without the closed-state read, skip the nudge rather
        // than pestering a possibly handed-over child.
        return result
      }
      if (existing?.closed) return result
      const stage = softStage(last, soft)
      if (stage === "ok") return result
      const withNudge = { ...result, additionalContext: [...(result.additionalContext ?? []), buildClaudeChildNudge(stage)] }
      nudged.add(agentId)
      return withNudge
    } catch {
      return result
    }
  }).catch(async (_$, event, next) => {
    // Advisory only. If next.called, this replays the unchanged chain result.
    return next(event)
  })

  on("tool.call", async ($: Engine, event: ToolCallEvent, next: (event: ToolCallEvent) => Promise<ToolCallResult>): Promise<ToolCallResult> => {
    const call = event
    const tool = typeof call?.tool === "string" ? call.tool : ""

    if (tool === HANDOVER_FULL) {
      const agentId = asString(call.agentId)
      if (agentId === undefined || agentId === "") {
        return {
          deny:
            "context_handover is child-only: root sessions must never call it. " +
            "Root work continues under native compaction; no handover action exists for the main loop.",
        }
      }
      let child = false
      try {
        child = await isChildLoop($, agentId)
      } catch {
        return storageDeny("listing agents", `agent:${agentId}`, new Error("agent list unavailable"))
      }
      if (!child) {
        return { deny: `context_handover refused for ${agentId}: unknown, internal, or teammate loop.` }
      }
      if (inflight.has(agentId)) {
        return { result: `Handover already in progress for subagent ${agentId}; duplicate call skipped.` }
      }
      inflight.add(agentId)
      try {
        let existing: ChildRecord | ChildTombstone | undefined
        try {
          existing = await readRecord($, agentId)
        } catch (error) {
          return storageDeny("reading source lock", childRecordKey(agentId), error)
        }
        if (existing?.closed) {
          // Tombstoned closures stay locked with explicit expiry wording.
          if (isChildTombstone(existing)) return { deny: buildExpiredChildDeny(agentId) }
          return { deny: buildLockedChildDeny(agentId, provenanceOf(existing)) }
        }
        const handover = asString(call.handover)
        const summary = asString(call.summary) ?? ""
        if (handover === undefined || handover.trim().length === 0) {
          return { deny: 'auto-context-handover: "handover" must be the full handover text, verbatim and non-empty.' }
        }
        let parentSessionId: string | undefined
        try {
          parentSessionId = await $.session.id()
        } catch {
          parentSessionId = undefined
        }
        // Call-time diagnostics from the latest per-request usage snapshot,
        // never by measuring the handover payload. Reason reflects a nudge
        // appended by this hook ("nudged" = sent, no child receipt), not
        // usage alone: before any appended nudge a known usage is
        // not-nudged, and only an unknown snapshot (reload or invalid usage
        // without prior nudge) is unknown. Stage derives from the last
        // estimate via softStage; unknown only when missing. Baseline is the
        // first measured request; growth is the last batch increase
        // (latest minus previous, consecutive measurements only).
        // Baseline is unknown without a newly observed start; growth needs
        // two consecutive measurements, including after a reload.
        const last = usageCache.get(agentId)
        const wasNudged = nudged.has(agentId)
        const baseline = baselineSeen.get(agentId) ?? "unknown"
        const growth = growthSeen.get(agentId) ?? "unknown"
        const diag: ChildDiag = {
          reason: wasNudged ? "nudged" : last === undefined ? "unknown" : "not-nudged",
          stage: last === undefined ? "unknown" : softStage(last, soft),
          estimate: last === undefined ? "unknown" : last,
          soft,
          baseline,
          growth,
        }
        // Spawn provenance: in-memory first, then the persisted spawn key
        // (reload), else unknown. Observed absent (null) stays distinct from
        // unknown (absent field); never infer from result/usage/root models.
        // Lineage (predecessor/origin/generation) rides along honestly;
        // malformed or missing lineage stays unknown, never a reset origin.
        let provenance: SpawnProvenance | undefined = spawnSeen.get(agentId)
        if (provenance === undefined) {
          provenance = await readSpawnMeta($, agentId)
          if (provenance !== undefined) rememberSpawn(agentId, provenance)
        }
        const stored: ChildRecord = {
          handover,
          summary,
          agentId,
          parentSessionId,
          closed: true,
          storedAt: Date.now(),
          handbackDelivered: false,
          diag,
          ...(childTurn.get(agentId) === undefined ? {} : { handoverTurnId: childTurn.get(agentId) as string }),
          ...(provenance?.agentType === undefined ? {} : { agentType: provenance.agentType }),
          ...(provenance?.modelOverride === undefined ? {} : { modelOverride: provenance.modelOverride }),
          ...(provenance?.predecessorAgentId === undefined ? {} : { predecessorAgentId: provenance.predecessorAgentId }),
          ...(provenance?.originAgentId === undefined ? {} : { originAgentId: provenance.originAgentId }),
          ...(provenance?.generation === undefined ? {} : { generation: provenance.generation }),
        }
        // Size-budget reclamation before the handover write. The writing
        // chain is always protected; inflight and live-listed chains are
        // protected too. Quota/partial failure is an explicit retryable deny:
        // failed persistence never claims success and never locks the child.
        try {
          const live = await liveChainIds($)
          const protect = new Set<string>([...reservedChains.keys(), ...inflight, ...live])
          if (provenance?.originAgentId !== undefined) protect.add(provenance.originAgentId)
          if (provenance?.predecessorAgentId !== undefined) protect.add(provenance.predecessorAgentId)
          protect.add(agentId)
          const scan = await reclaimForWrite($, childRecordKey(agentId), stored, protect)
          if (!scan.ok) return quotaDeny(scan, childRecordKey(agentId))
        } catch {
          // Reclamation lookup failures fail open; the write below still tries.
        }
        try {
          await $.store.set(childRecordKey(agentId), stored)
        } catch (error) {
          return storageDeny("persisting handover", childRecordKey(agentId), error)
        }
        // Chain activity for the write rides without a second scan.
        await touchChainActivity($, provenance?.originAgentId ?? agentId)
        usageCache.delete(agentId)
        baselineSeen.delete(agentId)
        growthSeen.delete(agentId)
        baselineEligible.delete(agentId)
        return { result: buildHandoverStoredInstruction(shortReplyOf(stored, provenance)) }
      } finally {
        inflight.delete(agentId)
      }
    }

    // SubagentHandback exception: the initial turn forwards the stored short
    // reply; a resumed turn (different, missing, or legacy turn identity)
    // forwards the explicit locked reply instead so follow-ups refuse work.
    // Tool, tool_use_id, agentId, and all other fields are preserved so the
    // native delivery path (including any host classifier review) still runs;
    // the adapter only forwards, and success is observed through the tool
    // result, never claimed. The result (including deny and isError) passes
    // through untouched; nothing is synthesized. A storage outage denies
    // instead of forwarding the original untrusted full report. A successful
    // result without deny/isError marks native delivery observed for this
    // turn (not parent receipt) and persists handbackDelivered=true (persist
    // failures never break the native result); the stop hook honors only
    // this-turn delivery, classifier send/withhold internals are not inferred.
    if (tool === SUBAGENT_HANDBACK) {
      const agentId = asString(call.agentId)
      if (agentId !== undefined && agentId !== "") {
        let stored: ChildRecord | ChildTombstone | undefined
        try {
          stored = await readRecord($, agentId)
        } catch (error) {
          return storageDeny("checking handback source lock", childRecordKey(agentId), error)
        }
        if (stored?.closed) {
          // Tombstoned closures forward the locked reply and never resurrect
          // the evicted payload: status persistence is skipped, delivery is
          // still observed in memory for this turn's stop.
          if (isChildTombstone(stored)) {
            const outcome = await next({ ...event, message: buildLockedChildReply(agentId, provenanceOf(stored)) })
            if (
              typeof outcome === "object" &&
              outcome !== null &&
              !("deny" in outcome) &&
              !outcome.isError
            ) {
              handbackOk.add(agentId)
            }
            return outcome
          }
          const currentTurn = childTurn.get(agentId)
          const sameTurn = stored.handoverTurnId !== undefined && currentTurn !== undefined && currentTurn === stored.handoverTurnId
          const forwarded = sameTurn ? shortReplyOf(stored, provenanceOf(stored)) : buildLockedChildReply(agentId, provenanceOf(stored))
          const outcome = await next({ ...event, message: forwarded })
          if (
            typeof outcome === "object" &&
            outcome !== null &&
            !("deny" in outcome) &&
            !outcome.isError
          ) {
            handbackOk.add(agentId)
            try {
              // Never resurrect an evicted payload: re-check the lock before
              // persisting delivery status. A tombstone or missing record
              // keeps delivery memory-only for this turn.
              const current = await readRecord($, agentId).catch(() => undefined)
              if (current !== undefined && !isChildTombstone(current)) {
                await $.store.set(childRecordKey(agentId), { ...current, handbackDelivered: true })
              }
            } catch {
              // Persist outage: in-memory delivery still honors this turn's
              // stop, but the stored status may stay stale (false); read
              // diagnostics reflect the stored value, not memory.
            }
          }
          return outcome
        }
      }
      return next(event)
    }

    // Gate: a handed-over calling child is denied all further work tools and
    // duplicate handovers, with the explicit final-reply instruction. The
    // gate runs before the reader, so a closed child cannot bypass work
    // refusal by reading its own record. Calls without a loop id (root and
    // parent reads) pass through to the reader below.
    const agentId = asString(call.agentId)
    if (agentId !== undefined && agentId !== "") {
      let stored: ChildRecord | ChildTombstone | undefined
      try {
        stored = await readRecord($, agentId)
      } catch (error) {
        // A non-child loop has no record to protect: confirm via the agent
        // list and pass it through untouched. Unknown loops and list
        // outages stay denied rather than guessing.
        const child = await isChildLoop($, agentId).catch(() => true)
        if (!child) return next(event)
        return storageDeny("checking source lock", childRecordKey(agentId), error)
      }
      if (stored?.closed) {
        if (isChildTombstone(stored)) return { deny: buildExpiredChildDeny(agentId) }
        return { deny: buildLockedChildDeny(agentId, provenanceOf(stored)) }
      }
    }

    if (tool === READ_FULL) {
      const target = asString(call.childId)
      if (target === undefined || target === "") {
        return { deny: "auto-context-handover: read_handover needs a non-empty childId." }
      }
      const wantFull = (call as Record<string, unknown>).full === true
      const callerId = asString(call.agentId)
      let stored: ChildRecord | ChildTombstone | undefined
      try {
        stored = await readRecord($, target)
      } catch (error) {
        return storageDeny("reading stored handover", childRecordKey(target), error)
      }
      if (!stored) return { result: `No handover stored for subagent ${target}.` }
      // Compact closure tombstone: the lock holds, the payload is gone.
      // Expired reads are explicit and never fabricate a payload. Refresh
      // chain activity without triggering an eviction scan.
      if (isChildTombstone(stored)) {
        await touchChainActivity($, stored.originAgentId ?? target)
        return { result: buildExpiredReadback(stored.agentId) }
      }
      const header =
        `Handover from subagent ${stored.agentId}` +
        (stored.parentSessionId ? ` (host session ${stored.parentSessionId})` : "") +
        ` stored at ${stored.storedAt}:`
      const diagLine = `${formatDiagLine(stored.diag)}, handback-delivered=${formatHandbackDeliveredValue((stored as ChildRecord).handbackDelivered)}`
      const baselineValue = (stored.diag as ChildDiag | undefined)?.baseline
      const growthValue = (stored.diag as ChildDiag | undefined)?.growth
      const baselineLine = buildBaselineLine(
        typeof baselineValue === "number" ? baselineValue : "unknown",
        typeof growthValue === "number" ? growthValue : "unknown",
      )
      // Reference workflow: generation/chain/next-step count, seed-size
      // diagnostics, then the original task verbatim once and the handover
      // verbatim once, plus successor guidance and the short successor
      // pointer. The parent spawns with only the marker (plus optional
      // redirection); the successor loads the full texts via the reader.
      // Stored text is never rewritten.
      const nextSteps = countNextSteps(stored.handover)
      const recordProvenance = provenanceOf(stored)
      // Merge sanitized missing provenance/lineage from stored spawn
      // metadata and memory. Covers handover-inside-next races where the
      // closed record predates the spawn persistence. Record fields win.
      let spawnProv = spawnSeen.get(target)
      if (spawnProv === undefined) {
        spawnProv = await readSpawnMeta($, target).catch(() => undefined)
        if (spawnProv !== undefined) rememberSpawn(target, spawnProv)
      }
      const provenance = mergeProvenance(recordProvenance, spawnProv)
      const provenanceLine = buildProvenanceReadback(provenance)
      const generationLine = buildGenerationLine(
        {
          agentId: stored.agentId,
          ...(provenance?.predecessorAgentId === undefined ? {} : { predecessorAgentId: provenance.predecessorAgentId }),
          ...(provenance?.originAgentId === undefined ? {} : { originAgentId: provenance.originAgentId }),
          ...(provenance?.generation === undefined ? {} : { generation: provenance.generation }),
        },
        nextSteps,
      )
      let originalPrompt: string | undefined
      let originalNote: string
      const originId = provenance?.originAgentId
      if (originId !== undefined) {
        const original = await readOriginal($, originId)
        if (original !== undefined) {
          originalPrompt = original.prompt
          originalNote = ""
        } else {
          const memoryError = originalErrorSeen.get(originId)
          let storedError: string | undefined
          if (memoryError === undefined) {
            const originSpawn = spawnSeen.get(originId) ?? await readSpawnMeta($, originId).catch(() => undefined)
            if (typeof originSpawn?.originalCaptureError === "string" && originSpawn.originalCaptureError.length > 0) {
              storedError = originSpawn.originalCaptureError
            }
          }
          const captureError = memoryError ?? storedError
          if (captureError !== undefined) {
            originalNote = `unknown: ${formatOriginReadback(originId)} has no stored original (original capture failed: ${captureError})`
          } else {
            originalNote = `unknown: ${formatOriginReadback(originId)} has no stored original (storage outage, write rejection, legacy origin, or missing predecessor)`
          }
        }
      } else {
        originalNote = `unknown: ${formatOriginReadback(undefined)} (legacy record predates lineage; treat as a new origin only if the chain is verified)`
      }
      const successorPointer = buildSuccessorPointer(stored.agentId)
      // The estimate measures the actual successor-facing payload: original,
      // handover, guidance, and pointer. Parent-only header lines excluded.
      const seedEstimate = estimateSeedTokens(buildSuccessorPayloadText({
        originalPrompt,
        originalNote,
        handover: stored.handover,
        successorMarker: successorPointer,
      }))
      const seedSizeLine = buildSeedSizeLine(seedEstimate, soft)
      // Successor identification: a caller is a recorded successor when its
      // merged provenance (closed record plus spawn metadata, memory first)
      // links predecessorAgentId to this target. Exact mechanism: the
      // successor spawned with a leading
      // [auto-context-handover:continue child:<target>] marker, classified
      // synchronously in agent.spawn and persisted as predecessor/origin/
      // generation in spawn:<caller> and child:<caller>. Parent callers (no
      // agentId) and unrelated loops are never successors.
      let isSuccessor = false
      if (callerId !== undefined && callerId !== "" && callerId !== target) {
        try {
          const callerRecord = await readRecord($, callerId).catch(() => undefined)
          let callerSpawn = spawnSeen.get(callerId)
          if (callerSpawn === undefined) {
            callerSpawn = await readSpawnMeta($, callerId).catch(() => undefined)
            if (callerSpawn !== undefined) rememberSpawn(callerId, callerSpawn)
          }
          const callerProvenance = mergeProvenance(provenanceOf(callerRecord), callerSpawn)
          if (callerProvenance?.predecessorAgentId === target) isSuccessor = true
        } catch {
          isSuccessor = false
        }
      }
      if (wantFull || isSuccessor) {
        const accessNote = isSuccessor && !wantFull
          ? `Full-access: caller ${callerId} is the recorded successor via leading [auto-context-handover:continue child:${target}] marker/stored predecessor link; full texts included.`
          : `Full-access: explicit full:true request; full texts included.`
        // Successful reads refresh chain activity (no eviction scan).
        await touchChainActivity($, provenance?.originAgentId ?? target)
        return {
          result: buildReferenceReadback({
            header,
            diagLine,
            baselineLine,
            provenanceLine,
            generationLine,
            seedSizeLine,
            accessNote,
            originalPrompt,
            originalNote,
            handover: stored.handover,
            successorMarker: successorPointer,
          }),
        }
      }
      // Compact parent view (open-reader, no auth): headers plus pending
      // decisions, Prioritized next steps excerpt, and pointer. Full texts
      // only with full:true or recorded-successor auto-full above.
      // Successful reads refresh chain activity (no eviction scan).
      const pendingLine = buildPendingLine(stored.summary)
      const nextStepsExcerpt = extractNextStepsSection(stored.handover)
      await touchChainActivity($, provenance?.originAgentId ?? target)
      return {
        result: buildCompactReadback({
          header,
          diagLine,
          baselineLine,
          provenanceLine,
          generationLine,
          seedSizeLine,
          pendingLine,
          nextStepsExcerpt,
          successorMarker: successorPointer,
          targetId: stored.agentId,
        }),
      }
    }

    return next(event)
  }).catch(async (_$, event, next) => {
    // Never dispatch twice or replace a native/classifier result after next.
    if (next.called) return next(event)
    const agentId = asString(event.agentId)
    if ((agentId !== undefined && agentId !== "") || event.tool === HANDOVER_FULL || event.tool === READ_FULL) {
      // No host calls in the one-second catch budget. Uncertain child closure
      // stays protected; adapter tools must not fall through or claim success.
      // next.error is host-set; guard for test harnesses or future shapes.
      const kind = (next as { error?: { kind?: unknown } })?.error?.kind ?? "unknown"
      return {
        deny:
          `auto-context-handover: tool hook failed before dispatch (${String(kind)}); this call was not run. ` +
          "Retry after recovery; handed-over children must stop and return control to their parent.",
      }
    }
    // Ordinary root work has no child closure to protect.
    return next(event)
  })

  // Bounded stop correction: await the chain first and preserve any block,
  // preventContinuation, or added context from other hooks; then add at most
  // one handback correction per agent per turn. A closed child with no
  // this-turn native delivery is corrected to call SubagentHandback now,
  // even when its final text already matches the short or locked reply:
  // plain-text finals may not reach the parent on the native path. A
  // completed this-turn handback is accepted without shaping so classifier
  // review stands. Advisory shaping, never a retry loop.
  on("classic.SubagentStop", async (
    $: Engine,
    event: ClassicSubagentStopEvent,
    next: (event: ClassicSubagentStopEvent) => Promise<ClassicSubagentStopResult>,
  ) => {
    const base = await next(event)
    try {
      const result = (typeof base === "object" && base !== null ? base : {}) as ClassicSubagentStopResult
      if (result.block || result.preventContinuation) return base
      const stop = event
      const agentId = asString(stop?.agent_id)
      if (agentId === undefined || agentId === "" || correctedStops.has(agentId)) {
        return base
      }
      if (stop?.stop_hook_active === true) return base
      const stored = await readRecord($, agentId).catch(() => undefined)
      if (!stored?.closed) return base
      // Memory retirement for the closed child. The correction latch
      // (correctedStops/handbackOk/childTurn) is never cleared here: a
      // resumable terminal stop that blocks for another turn step must not
      // lose its one-correction state, and late step callbacks stay retired.
      retireMeasurementCaches(agentId)
      if (handbackOk.has(agentId)) return base
      const lockedReply = buildLockedChildReply(agentId, provenanceOf(stored))
      const currentTurn = childTurn.get(agentId)
      // Tombstoned closures have no short reply; the locked reply applies to
      // every turn identity. Live records keep same-turn short-reply routing.
      const sameTurn = !isChildTombstone(stored) &&
        stored.handoverTurnId !== undefined && currentTurn !== undefined && currentTurn === stored.handoverTurnId
      const report = sameTurn ? shortReplyOf(stored, provenanceOf(stored)) : lockedReply
      correctedStops.add(agentId)
      return {
        ...result,
        block:
          `Handover stored but not delivered through SubagentHandback. ` +
          `Call SubagentHandback now with ONLY the following report as your final delivery and then stop; ` +
          `do not emit a plain-text final (it may not reach your parent) and do not call any other tools: ` +
          report,
      }
    } catch {
      return base
    }
  }).catch(async (_$, event, next) => {
    // Advisory correction failure must not prolong a child or retry its stop.
    return next(event)
  })

  // Session end: retire this session's active pins conservatively (payloads
  // stay; other owners' pins are untouched) and prune per-child memory.
  // Correction latches are turn-scoped and end with the session; no eviction
  // scan runs here. Spawn provenance stays (1000-capped, rehydratable).
  on("session.end", async ($: Engine, event: SessionEndEvent, next: (event: SessionEndEvent) => Promise<unknown>) => {
    const result = await next(event)
    try {
      const endingId = typeof event?.sessionId === "string" && (event.sessionId as string).length > 0
        ? (event.sessionId as string)
        : await $.session.id().catch(() => undefined)
      try {
        const keys = await listStoreKeys($)
        if (Array.isArray(keys) && typeof endingId === "string") {
          for (const key of keys) {
            if (typeof key !== "string" || !key.startsWith("pin:")) continue
            try {
              const pin = await $.store.get(key)
              if (isChainPin(pin) && pin.owner === endingId) await $.store.delete(key).catch(() => undefined)
            } catch {
              // Best-effort pin retirement only.
            }
          }
        }
      } catch {
        // Pin retirement is advisory.
      }
      usageCache.clear()
      baselineSeen.clear()
      growthSeen.clear()
      baselineEligible.clear()
      spawnObservedHere.clear()
      reservedChains.clear()
      // Turn-scoped correction state ends with the session; retired ids are
      // released so the set cannot grow forever across sessions.
      childTurn.clear()
      turnSeen.clear()
      handbackOk.clear()
      correctedStops.clear()
      retiredCaches.clear()
      originalErrorSeen.clear()
    } catch {
      // Advisory only.
    }
    return result
  }).catch(async (_$, event, next) => {
    return next(event)
  })
}
