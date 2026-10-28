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
  ToolCallEvent,
  ToolCallResult,
  TurnStepEvent,
  TurnStepResult,
} from "./claude-types.ts"
import {
  buildBaselineLine,
  buildChildShortReply,
  buildClaudeChildIntro,
  buildClaudeChildNudge,
  buildClaudeRootIntro,
  buildCompactReadback,
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
  CHILD_DEFAULT_SOFT,
  CHILD_HANDOVER_DESCRIPTION,
  CHILD_READ_DESCRIPTION,
  childRecordKey,
  classifySuccessorMarker,
  countNextSteps,
  estimateSeedTokens,
  extractNextStepsSection,
  formatHandbackDeliveredValue,
  formatOriginReadback,
  HANDOVER_FULL,
  HANDOVER_TOOL,
  isChildRecord,
  isOriginalRecord,
  isSpawnProvenance,
  mergeProvenance,
  originalRecordKey,
  parseChildSoft,
  READ_FULL,
  READ_TOOL,
  spawnRecordKey,
  softStage,
  sumTurnUsage,
  type ChildDiag,
  type ChildRecord,
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

async function readRecord($: Engine, agentId: string): Promise<ChildRecord | undefined> {
  const value = await $.store.get(childRecordKey(agentId))
  return isChildRecord(value) ? value : undefined
}

async function readSpawnMeta($: Engine, agentId: string): Promise<SpawnProvenance | undefined> {
  try {
    const value = await $.store.get(spawnRecordKey(agentId))
    return isSpawnProvenance(value) ? value : undefined
  } catch {
    return undefined
  }
}

const provenanceOf = (record: ChildRecord | undefined): SpawnProvenance | undefined => {
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

/** True only for a known, non-teammate loop. Unknown/internal ids and teammates are ignored. */
async function isChildLoop($: Engine, agentId: string): Promise<boolean> {
  const agents = await $.agent.list()
  if (!Array.isArray(agents)) return false
  const found = agents.find((agent) => agent?.id === agentId)
  if (!found) return false
  if (found.type === "teammate") return false
  return true
}

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
  const handbackOk = new Set<string>()
  // Observed spawn provenance (type + requested model override). In-memory
  // first; mirrored to `spawn:<childId>` so a reload retains it for the
  // eventual ChildRecord. Never the effective result model or usage model.
  const spawnSeen = new Map<string, SpawnProvenance>()
  // Original-capture failures by origin id (actual store error text). Memory
  // only: after a reload the readback reports unknown capture status.
  const originalErrorSeen = new Map<string, string>()
  // Baseline/start context (first measured per-request total) and last-batch
  // increase (latest minus previous). In-memory only: reload loses them, so
  // handover diagnostics degrade honestly to unknown. No pruning by design;
  // retention matches the existing per-child Maps/Sets (known limitation).
  // Baseline is eligible only for a newly observed launch in this
  // registration: classic.SubagentStart for an id with no prior stored
  // spawn/closed-child metadata and no previously loaded spawn metadata.
  // Reload/mid-child/unobserved starts stay
  // unknown; growth still tracks consecutive measurements. Resumes never
  // reset an established baseline; turn.index is never a start signal.
  const baselineSeen = new Map<string, number>()
  const growthSeen = new Map<string, number>()
  const baselineEligible = new Set<string>()
  const spawnObservedHere = new Set<string>()

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
    const classified = classifySuccessorMarker(raw?.prompt)
    const rawPrompt = raw?.prompt
    const observedPrompt = typeof rawPrompt === "string" && rawPrompt.length > 0 ? rawPrompt : undefined
    const result = await next(event)
    try {
      if (typeof result !== "object" || result === null) return result
      const record = result as Record<string, unknown>
      if (typeof record.deny === "string" && record.deny.length > 0) return result
      const childId = typeof record.agentId === "string" && record.agentId.length > 0 ? (record.agentId as string) : undefined
      if (childId === undefined) return result
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
        // handover. A missing stored handover stays honestly unknown:
        // predecessor id is kept, origin/generation are absent, never a
        // reset new origin and never fabricated from the predecessor id or
        // from running-only spawn metadata without a stored handover.
        const markerPredecessor = classified.predecessor
        let origin: string | undefined
        let generation: number | undefined
        try {
          const pred = await readRecord($, markerPredecessor).catch(() => undefined)
          if (pred !== undefined) {
            const predProv = provenanceOf(pred)
            let fallback = spawnSeen.get(markerPredecessor)
            if (fallback === undefined) {
              fallback = await readSpawnMeta($, markerPredecessor).catch(() => undefined)
              if (fallback !== undefined) spawnSeen.set(markerPredecessor, fallback)
            }
            const merged = mergeProvenance(predProv, fallback)
            if (merged?.originAgentId !== undefined) origin = merged.originAgentId
            if (merged?.generation !== undefined) generation = merged.generation + 1
          }
        } catch {
          // Lineage lookups fail open; predecessor link is still kept.
        }
        Object.assign(meta, { predecessorAgentId: markerPredecessor })
        if (origin !== undefined) Object.assign(meta, { originAgentId: origin })
        if (generation !== undefined) Object.assign(meta, { generation })
      } else if (classified.status === "absent") {
        Object.assign(meta, { originAgentId: childId, generation: 1 })
      }
      if (meta.agentType === undefined && meta.modelOverride === undefined && meta.predecessorAgentId === undefined && meta.originAgentId === undefined && meta.generation === undefined) return result
      spawnSeen.set(childId, meta)
      try {
        const prior = await readSpawnMeta($, childId)
        const merged: SpawnProvenance = mergeProvenance(meta, prior) ?? meta
        spawnSeen.set(childId, merged)
        // Standalone persistence even when the child record already closed
        // (handover inside next). Writes only spawn:/original: keys, never
        // the handover text.
        await $.store.set(spawnRecordKey(childId), merged).catch(() => undefined)
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
                await $.store.set(originalRecordKey(childId), original)
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                const bounded = message.slice(0, 300)
                originalErrorSeen.set(childId, bounded)
                const withError: SpawnProvenance = mergeProvenance({ originalCaptureError: bounded }, spawnSeen.get(childId)) ?? { originalCaptureError: bounded }
                spawnSeen.set(childId, withError)
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
      return result
    } catch {
      return result
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
                  spawnSeen.set(agentId, merged)
                  await $.store.set(spawnRecordKey(agentId), merged).catch(() => undefined)
                }
              } else if (seen === undefined) {
                spawnSeen.set(agentId, stored)
              }
            }
          }
        } catch {
          // Fallback only; intro delivery below still runs.
        }
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
      if (agentId !== undefined && agentId !== "" && turnId !== undefined && turnId !== "" && childTurn.get(agentId) !== turnId) {
        // New (or resumed) turn: prior handback delivery and the
        // one-correction latch belong to the previous turn only.
        childTurn.set(agentId, turnId)
        handbackOk.delete(agentId)
        correctedStops.delete(agentId)
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
      let existing: ChildRecord | undefined
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
        let existing: ChildRecord | undefined
        try {
          existing = await readRecord($, agentId)
        } catch (error) {
          return storageDeny("reading source lock", childRecordKey(agentId), error)
        }
        if (existing?.closed) {
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
          if (provenance !== undefined) spawnSeen.set(agentId, provenance)
        }
        const stored: ChildRecord = {
          handover,
          summary,
          agentId,
          parentSessionId,
          shortReply: buildChildShortReply(summary || "Handover stored.", agentId, provenance),
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
        try {
          await $.store.set(childRecordKey(agentId), stored)
        } catch (error) {
          return storageDeny("persisting handover", childRecordKey(agentId), error)
        }
        usageCache.delete(agentId)
        baselineSeen.delete(agentId)
        growthSeen.delete(agentId)
        baselineEligible.delete(agentId)
        return { result: buildHandoverStoredInstruction(stored.shortReply) }
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
        let stored: ChildRecord | undefined
        try {
          stored = await readRecord($, agentId)
        } catch (error) {
          return storageDeny("checking handback source lock", childRecordKey(agentId), error)
        }
        if (stored?.closed) {
          const currentTurn = childTurn.get(agentId)
          const sameTurn = stored.handoverTurnId !== undefined && currentTurn !== undefined && currentTurn === stored.handoverTurnId
          const forwarded = sameTurn ? stored.shortReply : buildLockedChildReply(agentId, provenanceOf(stored))
          const outcome = await next({ ...event, message: forwarded })
          if (
            typeof outcome === "object" &&
            outcome !== null &&
            !("deny" in outcome) &&
            !outcome.isError
          ) {
            handbackOk.add(agentId)
            try {
              await $.store.set(childRecordKey(agentId), { ...stored, handbackDelivered: true })
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
      let stored: ChildRecord | undefined
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
      let stored: ChildRecord | undefined
      try {
        stored = await readRecord($, target)
      } catch (error) {
        return storageDeny("reading stored handover", childRecordKey(target), error)
      }
      if (!stored) return { result: `No handover stored for subagent ${target}.` }
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
        if (spawnProv !== undefined) spawnSeen.set(target, spawnProv)
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
            if (callerSpawn !== undefined) spawnSeen.set(callerId, callerSpawn)
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
      const pendingLine = buildPendingLine(stored.summary)
      const nextStepsExcerpt = extractNextStepsSection(stored.handover)
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
      usageCache.delete(agentId)
      if (handbackOk.has(agentId)) return base
      const lockedReply = buildLockedChildReply(agentId, provenanceOf(stored))
      const currentTurn = childTurn.get(agentId)
      const sameTurn = stored.handoverTurnId !== undefined && currentTurn !== undefined && currentTurn === stored.handoverTurnId
      const report = sameTurn ? stored.shortReply : lockedReply
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
}
