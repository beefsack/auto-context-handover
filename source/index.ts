// auto-context-handover: measured soft-limit handover plugin (OpenCode V2 promise API).
// The session's model writes the handover; the plugin measures, warns,
// hard-gates, and rotates. Storage fallback B: everything lives in
// session-keyed KV, never in external files.

import { Plugin } from "@opencode/plugin"
import { Message } from "@opencode/ai"
import { Tool } from "@opencode/schema/tool"
import { Schema } from "effect"
import { parseConfig } from "./config.ts"
import {
  applyToolGate,
  inheritStreak,
  loopLockRequired,
  measureSession,
  narrow,
  nextLoopState,
  parseThreshold,
  resolveModelWindow,
  resolveSoftTokens,
  resolveThresholdTokens,
  seedTooLarge,
  selectThresholdValue,
  stageOf,
  type ThresholdScope,
} from "./measure.ts"
import { allKeys, keys, HANDOVER_TOOL, READ_TOOL, isRecord } from "./store.ts"
import { ROLLOVER_METADATA_KEY } from "./tui-follow.ts"
import type { StoredHandover, StoredLink, StoredLock, StoredSoftOverride, StoredState } from "./store.ts"
import { matchSoftMarker, resolveSoftMarker } from "./soft-marker.ts"
import {
  buildForwardNotice,
  buildHardDirective,
  buildLockedDirective,
  buildLockedFinalReply,
  buildLockModeNotice,
  buildNudge,
  buildSubagentReturn,
  buildSuccessorSeed,
  HANDOVER_DESCRIPTION,
} from "./text.ts"

type Context = Plugin.Context

const readJson = async (ctx: Context, key: string): Promise<Record<string, unknown> | undefined> => {
  const value = await ctx.storage.get(key).catch(() => undefined)
  return isRecord(value as unknown) ? (value as Record<string, unknown>) : undefined
}

// Strict storage read for tool paths. Unlike readJson (hook fail-open), a
// tool must refuse when storage is unavailable: swallowing the error would
// overwrite locked state or create successors during an outage.
const readStrict = async (ctx: Context, key: string, what: string): Promise<Record<string, unknown> | undefined> => {
  let value: unknown
  try {
    value = await ctx.storage.get(key)
  } catch (error) {
    throw new Tool.Error({
      message: `auto-context-handover: storage unavailable while reading ${what} (${key}), refusing to act: ${(error as Error).message}`,
    })
  }
  return isRecord(value) ? (value as Record<string, unknown>) : undefined
}

const asStoredHandover = (value: Record<string, unknown> | undefined): StoredHandover | undefined => {
  if (!value || typeof value.text !== "string" || typeof value.summary !== "string") return undefined
  const model = isRecord(value.model) ? value.model : {}
  return {
    text: value.text,
    summary: value.summary,
    agent: typeof value.agent === "string" ? value.agent : "unknown",
    model: {
      providerID: typeof model.providerID === "string" ? model.providerID : "unknown",
      id: typeof model.id === "string" ? model.id : "unknown",
    },
    storedAt: typeof value.storedAt === "number" ? value.storedAt : 0,
  }
}

const asStoredLock = (value: Record<string, unknown> | undefined): StoredLock | undefined => {
  if (!value || typeof value.reason !== "string") return undefined
  const reply = typeof value.finalReply === "string" ? value.finalReply : undefined
  return { reason: value.reason, at: typeof value.at === "number" ? value.at : 0, ...(reply === undefined ? {} : { finalReply: reply }) }
}

const asStoredState = (value: Record<string, unknown> | undefined): StoredState | undefined => {
  if (!value) return undefined
  const num = (field: string): number => (typeof value[field] === "number" ? (value[field] as number) : 0)
  return { chain: num("chain"), unproductive: num("unproductive"), seedEstimate: num("seedEstimate"), highWater: num("highWater") }
}

const asStoredLink = (value: Record<string, unknown> | undefined): StoredLink | undefined => {
  if (!value || typeof value.sessionID !== "string") return undefined
  return { sessionID: value.sessionID, at: typeof value.at === "number" ? value.at : 0 }
}

const asStoredSoftOverride = (value: Record<string, unknown> | undefined): StoredSoftOverride | undefined => {
  if (!value || !("value" in value)) return undefined
  return { value: value.value, at: typeof value.at === "number" ? value.at : 0 }
}

const HandoverInput = Schema.Struct({
  handover: Schema.String,
  summary: Schema.String,
})

const ReadInput = Schema.Struct({
  sessionID: Schema.String,
})

export default Plugin.define({
  id: "auto-context-handover",
  setup: async (ctx) => {
    // Last observed request identity and pre-call usage per session,
    // scoped to this setup call so parallel plugin instances or config
    // reloads never leak identities or stale snapshots into each other.
    // The handover tool requires hook-observed identity: a real tool call
    // always follows a context hook, and progress must use the pre-call
    // snapshot (the current turn's own handover output must not count).
    const lastRequest = new Map<string, { agent: string; providerID: string; id: string; variant?: string }>()
    const lastUsage = new Map<string, { estimate: number; softTokens: number }>()
    // Duplicate-call guard and same-process pending-successor map.
    // In-memory only: KV has no CAS, and a stale gate must not survive a
    // restart. Keys are always the raw session IDs, unmodified.
    const inflight = new Set<string>()
    const pendingSuccessor = new Map<string, string>()
    const config = parseConfig(ctx.options)
    const description = config.handoverDescription ?? HANDOVER_DESCRIPTION

    await ctx.tool.transform((editor) => {
      // Direct route: the host defaults unmarked tools into Code Mode only
      // (core/tool.ts), where the hard gate below would strip `execute` and
      // leave no handover callable. codemode:false keeps both tools addressable.
      editor.add({
        name: HANDOVER_TOOL,
        options: { codemode: false },
        description,
        input: HandoverInput,
        execute: async (input, toolCtx) => {
          if (toolCtx.signal?.aborted) {
            throw new Tool.Error({ message: "auto-context-handover: handover call aborted" })
          }
          const sessionID = toolCtx.sessionID
          if (inflight.has(sessionID)) {
            return { content: `Handover already in progress for session ${sessionID}; duplicate call skipped.` }
          }
          inflight.add(sessionID)
          try {
            const existingLock = asStoredLock(await readStrict(ctx, keys.lock(sessionID), "source lock"))
            if (existingLock) {
              return { content: `${buildLockedDirective(existingLock.reason, sessionID)} Handover not recorded; this session is already locked.` }
            }
            const info = await ctx.session.get({ sessionID }).catch((error: unknown) => {
              throw new Tool.Error({
                message: `auto-context-handover: cannot read session ${sessionID}, refusing to act: ${(error as Error).message}`,
              })
            })
            if (!info) {
              throw new Tool.Error({ message: `auto-context-handover: session ${sessionID} does not exist, refusing to act` })
            }
            const identity = lastRequest.get(sessionID)
            if (!identity) {
              throw new Tool.Error({
                message: `auto-context-handover: no request observed for session ${sessionID} yet; the context hook must run before the handover tool`,
              })
            }
            const handover = typeof input.handover === "string" ? input.handover : ""
            const summary = typeof input.summary === "string" ? input.summary : ""
            if (handover.trim().length === 0) {
              throw new Tool.Error({ message: "auto-context-handover: \"handover\" must be the full handover text, verbatim and non-empty" })
            }
            const stored: StoredHandover = {
              text: handover,
              summary,
              agent: toolCtx.agent,
              model: { providerID: identity.providerID, id: identity.id },
              storedAt: Date.now(),
            }
            try {
              await ctx.storage.set(keys.handover(sessionID), stored as unknown as Parameters<typeof ctx.storage.set>[1])
            } catch (error) {
              throw new Tool.Error({
                message: `auto-context-handover: failed to persist handover, nothing was rotated: ${(error as Error).message}`,
              })
            }

            if (info.parentID) {
              // Subagents never open root sessions. Persistent stop lock; the
              // next hook strips all tools and replays only the short final
              // reply below. No loop accounting for children, and the full
              // handover text is never included in the return.
              const finalReply = buildSubagentReturn(summary || "Handover stored.", sessionID)
              try {
                await ctx.storage.set(
                  keys.lock(sessionID),
                  { reason: "subagent handover returned to parent", at: Date.now(), finalReply } as unknown as Parameters<typeof ctx.storage.set>[1],
                )
              } catch (error) {
                throw new Tool.Error({
                  message: `auto-context-handover: handover stored for ${sessionID} but the stop lock write failed: ${(error as Error).message}. Retry the handover; no rotation happened.`,
                })
              }
              return { content: finalReply }
            }

            if (config.primary === "lock") {
              try {
                await ctx.storage.set(
                  keys.lock(sessionID),
                  { reason: "handover requested (onHandover.primary=lock)", at: Date.now() } as unknown as Parameters<typeof ctx.storage.set>[1],
                )
              } catch (error) {
                throw new Tool.Error({
                  message: `auto-context-handover: handover stored for ${sessionID} but the lock write failed, source is NOT locked: ${(error as Error).message}. Retry or read back with read_handover.`,
                })
              }
              return { content: buildLockModeNotice(sessionID, "handover requested (onHandover.primary=lock)") }
            }

            // Primary rollover. Progress uses the hook's pre-call snapshot:
            // the current turn already contains this handover output.
            const seed = buildSuccessorSeed(handover, sessionID)
            const fullSeedEstimate = Math.ceil(seed.length / 4)
            const recorded = lastUsage.get(sessionID)
            const back = asStoredLink(await readStrict(ctx, keys.back(sessionID), "predecessor link"))
            const previous = asStoredState(await readStrict(ctx, keys.state(sessionID), "loop state"))
            let updated: StoredState
            if (!back) {
              updated = {
                chain: 0,
                unproductive: 0,
                seedEstimate: fullSeedEstimate,
                highWater: recorded?.estimate ?? previous?.highWater ?? 0,
              }
            } else if (recorded) {
              const baseline = Math.max(recorded.estimate, previous?.highWater ?? 0)
              const added = Math.max(0, baseline - (previous?.seedEstimate ?? fullSeedEstimate))
              updated = nextLoopState(previous, {
                addedTokens: added,
                softTokens: recorded.softTokens,
                isRoot: false,
                seedEstimate: fullSeedEstimate,
                highWater: Math.max(previous?.highWater ?? 0, recorded.estimate),
              })
            } else {
              updated = previous
                ? { ...previous, seedEstimate: fullSeedEstimate }
                : { chain: 0, unproductive: 0, seedEstimate: fullSeedEstimate, highWater: 0 }
            }
            // The source state is NOT written here: failed attempts must not
            // advance the source streak or replace its seed baseline, so
            // retries recompute the same update. Only the successor inherits
            // the updated streak, and the source is persisted after locking.
            if (back && loopLockRequired(updated)) {
              const reason = "loop guard: 3 consecutive unproductive handovers"
              try {
                await ctx.storage.set(
                  keys.lock(sessionID),
                  { reason, at: Date.now() } as unknown as Parameters<typeof ctx.storage.set>[1],
                )
              } catch (error) {
                throw new Tool.Error({
                  message: `auto-context-handover: loop guard tripped for ${sessionID} but the lock write failed, source is NOT locked: ${(error as Error).message}. Retry the handover; no new root was created.`,
                })
              }
              const stateWritten = await ctx.storage
                .set(keys.state(sessionID), updated as unknown as Parameters<typeof ctx.storage.set>[1])
                .then(() => true)
                .catch(() => false)
              return {
                content:
                  `Handover stored for session ${sessionID}, but the loop guard locked this primary session: ` +
                  `3 consecutive successions added little beyond their seeds, so no new root was created. ` +
                  `Use read_handover for ${sessionID} to continue manually.` +
                  (stateWritten ? "" : ` Warning: the final loop-state write failed after locking.`),
              }
            }
            const seedWarning =
              recorded && seedTooLarge(fullSeedEstimate, recorded.softTokens)
                ? ` Warning: the full successor seed alone is over 50% of the soft threshold; the successor starts close to the limit.`
                : ""

            // Reuse a successor left behind by a failed attempt; never mint a
            // second root for one handover. A forward-link write can fail
            // after creation, so a same-process pending map (keyed by the raw
            // source ID) covers retries the stored link cannot. Residual
            // gap: a process crash between creation and durable link writes
            // can still orphan the successor (see README limitations).
            const forward = asStoredLink(await readStrict(ctx, keys.forward(sessionID), "forward link"))
            let createdID = forward?.sessionID ?? pendingSuccessor.get(sessionID)
            if (!createdID) {
              const directory =
                info.location && typeof info.location.directory === "string" ? info.location.directory : undefined
              let created: { id: string }
              try {
                created = await ctx.session.create({
                  agent: toolCtx.agent,
                  model: {
                    providerID: identity.providerID,
                    id: identity.id,
                    ...(identity.variant === undefined ? {} : { variant: identity.variant }),
                  },
                  ...(directory ? { location: { directory } } : {}),
                  title: summary ? summary.slice(0, 80) : "Continued session",
                })
              } catch (error) {
                throw new Tool.Error({
                  message:
                    `auto-context-handover: successor creation failed and the source session ${sessionID} is NOT locked; ` +
                    `the handover text stays stored. Action: retry the handover or read it back with read_handover. Cause: ${(error as Error).message}`,
                })
              }
              createdID = created.id
              pendingSuccessor.set(sessionID, createdID)
            }
            // Shared verify/repair path for fresh and reused successors: fill
            // in any missing link/state writes, prove the successor reads
            // back, and lock the source, all before the prompt. Every retry
            // passes through here, so a reused successor is never prompted
            // unreadable, unlinked, or unlocked.
            try {
              if (!forward || forward.sessionID !== createdID) {
                await ctx.storage.set(keys.forward(sessionID), { sessionID: createdID, at: Date.now() } as unknown as Parameters<typeof ctx.storage.set>[1])
              }
              const childBack = asStoredLink(await readStrict(ctx, keys.back(createdID), "successor back-link"))
              if (!childBack) {
                await ctx.storage.set(keys.back(createdID), { sessionID, at: Date.now() } as unknown as Parameters<typeof ctx.storage.set>[1])
              }
              const childState = asStoredState(await readStrict(ctx, keys.state(createdID), "successor loop state"))
              if (!childState) {
                await ctx.storage.set(
                  keys.state(createdID),
                  inheritStreak(updated, fullSeedEstimate) as unknown as Parameters<typeof ctx.storage.set>[1],
                )
              }
              pendingSuccessor.delete(sessionID)
            } catch (error) {
              throw new Tool.Error({
                message:
                  `auto-context-handover: successor ${createdID} was created but link/state writes failed and the source is NOT locked. ` +
                  `Action: retry the handover (it reuses ${createdID}, no duplicate root). ` +
                  `Cause: ${(error as Error).message}`,
              })
            }
            const evidence = await ctx.session.get({ sessionID: createdID }).catch(() => undefined)
            if (!evidence) {
              throw new Tool.Error({
                message:
                  `auto-context-handover: successor ${createdID} was created and linked but cannot be read back; ` +
                  `the source session ${sessionID} is NOT locked. Action: retry the handover (it reuses ${createdID}, no duplicate root) ` +
                  `or read it back with read_handover.`,
              })
            }
            try {
              await ctx.storage.set(
                keys.lock(sessionID),
                { reason: `continued in session ${createdID}`, at: Date.now() } as unknown as Parameters<typeof ctx.storage.set>[1],
              )
            } catch (error) {
              throw new Tool.Error({
                message:
                  `auto-context-handover: successor ${createdID} is ready but the source lock write failed, so the source is NOT locked. ` +
                  `Action: retry the handover (it reuses ${createdID}, no duplicate root) or read back with read_handover. Cause: ${(error as Error).message}`,
              })
            }
            // First durable advance of the source streak. The source is
            // already locked, so no retry can double-count it; a write failure
            // here only loses bookkeeping on a locked session (the successor
            // already carries the streak), so report success with a warning.
            const sourceStateWritten = await ctx.storage
              .set(keys.state(sessionID), updated as unknown as Parameters<typeof ctx.storage.set>[1])
              .then(() => true)
              .catch(() => false)
            try {
              await ctx.session.prompt({ sessionID: createdID, text: seed })
            } catch (error) {
              throw new Tool.Error({
                message:
                  `auto-context-handover: successor ${createdID} exists and the source ${sessionID} is locked (further handover calls for the source will refuse), ` +
                  `but the successor prompt admission failed or is uncertain: ${(error as Error).message}. ` +
                  `Action: the user opens ${createdID} and pastes the handover (read_handover for ${sessionID}).`,
              })
            }
            const forwardWritten = await ctx.session
              .synthetic({ sessionID, text: buildForwardNotice(createdID), resume: false })
              .then(() => true)
              .catch(() => false)
            return {
              content:
                `Handover complete: successor session ${createdID} started from session ${sessionID} and the source is locked. ` +
                `Summary: ${summary || "(no summary)"}${seedWarning}` +
                (sourceStateWritten ? "" : ` Warning: the source loop-state write failed after locking; the successor already carries the correct streak.`) +
                (forwardWritten ? "" : ` Warning: the visible forward link on ${sessionID} could not be written; the link is stored with read_handover metadata.`) +
                ` Continue in ${createdID}.`,
              // The tool-success event already identifies the source session.
              metadata: { [ROLLOVER_METADATA_KEY]: { successorID: createdID } },
            }
          } finally {
            inflight.delete(sessionID)
          }
        },
      })
      editor.add({
        name: READ_TOOL,
        options: { codemode: false },
        description:
          "Read the full stored handover text for a session (a parent agent can read a child's handover, and any live session can read a locked one's). " +
          "Takes sessionID. Returns the verbatim handover plus header lines with agent and forward/back links. Fails when the session does not exist or no handover was stored.",
        input: ReadInput,
        execute: async (input) => {
          const target = typeof input.sessionID === "string" ? input.sessionID : ""
          if (!target) throw new Tool.Error({ message: "auto-context-handover: read_handover needs a non-empty sessionID" })
          const info = await ctx.session.get({ sessionID: target }).catch((error: unknown) => {
            throw new Tool.Error({
              message: `auto-context-handover: cannot read session ${target}, refusing to act: ${(error as Error).message}`,
            })
          })
          if (!info) throw new Tool.Error({ message: `auto-context-handover: session ${target} does not exist` })
          const stored = asStoredHandover(await readStrict(ctx, keys.handover(target), "stored handover"))
          if (!stored) return { content: `No handover stored for session ${target}.` }
          const forward = asStoredLink(await readStrict(ctx, keys.forward(target), "forward link"))
          const back = asStoredLink(await readStrict(ctx, keys.back(target), "predecessor link"))
          const links = [
            back ? `continued from ${back.sessionID}` : "",
            forward ? `continued in ${forward.sessionID}` : "",
          ].filter((part) => part.length > 0)
          const header =
            `Handover from session ${target} (agent ${stored.agent})` +
            (links.length > 0 ? ` [${links.join("; ")}]` : "") +
            ":"
          // Direct route plus pre-set bypass: the host otherwise truncates
          // long tool output and spills it to a file (core/tool-output.ts).
          // A full read can consume large context; the soft-limit estimator
          // sees the result after its anchor, so this is expected behavior.
          return { content: `${header}\n\n${stored.text}`, metadata: { truncated: false } }
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      // Clear first: an unmeasurable new request must not reuse the previous
      // request's snapshot as its progress baseline.
      lastUsage.delete(event.sessionID)
      lastRequest.set(event.sessionID, {
        agent: event.agent,
        providerID: event.model.providerID,
        id: event.model.id,
        ...(typeof event.model.variant === "string" ? { variant: event.model.variant } : {}),
      })
      try {
        const locked = asStoredLock(await readJson(ctx, keys.lock(event.sessionID)))
        if (locked) {
          for (const name of Object.keys(event.tools)) delete event.tools[name]
          event.messages.push(
            Message.system(locked.finalReply ? buildLockedFinalReply(locked.reason, locked.finalReply) : buildLockedDirective(locked.reason, event.sessionID)),
          )
          return
        }
        const scope: ThresholdScope = { agent: event.agent, providerID: event.model.providerID, modelID: event.model.id }
        // A stored child soft marker outranks agent/model/global config. The
        // value was validated before persisting; a corrupt entry falls back
        // to config instead of failing the request. Hard limits are unaffected.
        const storedSoft = asStoredSoftOverride(await readJson(ctx, keys.softOverride(event.sessionID)))
        let spec: unknown = selectThresholdValue(config, scope)
        if (storedSoft) {
          try {
            parseThreshold(storedSoft.value)
            spec = storedSoft.value
          } catch {
            // Corrupt entry: keep the configured spec (fail open).
          }
        }
        const models = await ctx.model.list().catch(() => undefined)
        const window = resolveModelWindow(
          models?.data?.map((model) => ({ providerID: model.providerID, id: model.id, limit: model.limit })),
          scope.providerID,
          scope.modelID,
        )
        const softTokens = resolveSoftTokens(parseThreshold(spec), window)
        if (softTokens === undefined) return
        // Hard limits keep the existing resolution: no 70% cap, and an
        // unknown window fails open (no gate).
        const hardTokens = config.hard === undefined || window === undefined ? undefined : resolveThresholdTokens(parseThreshold(config.hard), window)
        const history = await ctx.session.context({ sessionID: event.sessionID }).catch(() => undefined)
        if (!history) return
        const measured = measureSession(history.map(narrow))
        if (!measured) return
        lastUsage.set(event.sessionID, { estimate: measured.estimate, softTokens })
        const state = asStoredState(await readJson(ctx, keys.state(event.sessionID)).catch(() => undefined))
        if (state && measured.estimate > state.highWater) {
          await ctx.storage
            .set(keys.state(event.sessionID), { ...state, highWater: measured.estimate } as unknown as Parameters<typeof ctx.storage.set>[1])
            .catch(() => undefined)
        }
        const stage = stageOf(measured.estimate, softTokens, hardTokens, config.stages)
        if (stage === "ok") return
        if (stage === "hard") {
          applyToolGate(event.tools as Record<string, unknown>, [HANDOVER_TOOL])
          event.messages.push(Message.system(buildHardDirective(hardTokens)))
          return
        }
        event.messages.push(Message.system(buildNudge(stage)))
      } catch {
        // Fail open: any measurement or host failure leaves the request untouched.
      }
    })

    // Subagent soft marker: parse only the initial prompt of a real child
    // session, allowing OpenCode's standard subagent banner. Scope and host
    // reads fail open (text untouched). With empty history no prompt was
    // admitted yet, so a retry parses, persists (replacing any unadmitted
    // value), and strips again. A scoped marker with unknown, duplicate, or
    // invalid keys rejects the prompt, and a failed override write blocks
    // admission with the marker intact so a retry parses again.
    await ctx.session.hook("prompt", async (event) => {
      const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
      const text = typeof event.prompt?.text === "string" ? event.prompt.text : undefined
      if (sessionID === undefined || text === undefined) return
      // Prefix-only: quoted text, tool results, and mid-text brackets never match.
      const matched = matchSoftMarker(text)
      if (!matched) return
      const info = await ctx.session.get({ sessionID }).catch(() => undefined)
      if (!info || !info.parentID) return
      const history = await ctx.session.context({ sessionID }).catch(() => undefined)
      if (!Array.isArray(history) || history.length > 0) return
      const parsed = resolveSoftMarker(matched)
      try {
        await ctx.storage.set(
          keys.softOverride(sessionID),
          { value: parsed.value, at: Date.now() } as unknown as Parameters<typeof ctx.storage.set>[1],
        )
      } catch (error) {
        throw new Error(
          `auto-context-handover: failed to persist subagent soft override for ${sessionID}, prompt NOT admitted: ${(error as Error).message}`,
        )
      }
      event.prompt.text = parsed.text
    })

    // Shared event stream. SubscribeOptions carries an optional AbortSignal
    // (node_modules/@opencode/client/dist/promise/client.d.ts event.subscribe
    // via shared-events.d.ts SubscribeOptions); the returned cleanup aborts
    // it so config reloads do not leak subscriptions. The host adapter also
    // finalizes tracked streams on plugin unload
    // (node_modules/@opencode/plugin/dist/promise/adapter.js makeStreams),
    // so this is belt and braces, not a speculative protocol.
    const controller = new AbortController()
    const events = ctx.event.subscribe({ signal: controller.signal })
    void (async () => {
      try {
        for await (const item of events) {
          try {
            if (item.type === "session.deleted") {
              const sessionID = (item.data as { sessionID?: unknown }).sessionID
              if (typeof sessionID !== "string") continue
              for (const key of allKeys(sessionID)) {
                await ctx.storage.remove(key).catch(() => undefined)
              }
              lastRequest.delete(sessionID)
              lastUsage.delete(sessionID)
              inflight.delete(sessionID)
              pendingSuccessor.delete(sessionID)
            }
          } catch {
            // Best-effort cleanup only.
          }
        }
      } catch {
        // Subscription ended; nothing to clean up.
      }
    })()
    return () => {
      controller.abort()
    }
  },
})

export { narrow }
