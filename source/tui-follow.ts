// Keep host imports type-only so tests and the server's metadata producer
// do not load the TUI runtime (including host-provided solid-js).
import type { Plugin } from "@opencode/plugin/tui"

export const ROLLOVER_METADATA_KEY = "auto-context-handover"

export interface Rollover {
  readonly sourceID: string
  readonly successorID: string
}

// Total parser: never throws, returns undefined for unrelated or malformed
// events. The source is the event's own sessionID; only a non-empty
// namespaced successorID different from the source counts.
export const extractRollover = (event: unknown): Rollover | undefined => {
  if (typeof event !== "object" || event === null) return undefined
  const data = (event as { data?: unknown }).data
  if (typeof data !== "object" || data === null) return undefined
  const record = data as Record<string, unknown>
  const sourceID = record.sessionID
  if (typeof sourceID !== "string" || sourceID.length === 0) return undefined
  const metadata = record.metadata
  if (typeof metadata !== "object" || metadata === null) return undefined
  const namespaced = (metadata as Record<string, unknown>)[ROLLOVER_METADATA_KEY]
  if (typeof namespaced !== "object" || namespaced === null) return undefined
  const successorID = (namespaced as Record<string, unknown>).successorID
  if (typeof successorID !== "string" || successorID.length === 0) return undefined
  if (successorID === sourceID) return undefined
  return { sourceID, successorID }
}

const pendingKey = (rollover: Rollover): string => `${rollover.sourceID}>${rollover.successorID}`

// Subscribes to live tool.success events only: no backfill, no setup scans,
// no reactivity. The caller owns the returned cleanup; it unsubscribes and
// prevents late navigation after an in-flight lookup resolves.
export const setupFollow = (ctx: Plugin.Context): (() => void) => {
  let disposed = false
  const pending = new Set<string>()
  const currentSource = (): string | undefined => {
    try {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    } catch {
      return undefined
    }
  }
  const unsubscribe = ctx.data.on("session.tool.success", (event) => {
    const rollover = extractRollover(event)
    if (!rollover) return
    if (currentSource() !== rollover.sourceID) return
    const key = pendingKey(rollover)
    if (pending.has(key)) return
    pending.add(key)
    void (async () => {
      try {
        const info = await ctx.client.session.get({ sessionID: rollover.successorID }).catch(() => undefined)
        if (!info || info.id !== rollover.successorID) return
        if (disposed) return
        if (currentSource() !== rollover.sourceID) return
        ctx.ui.router.navigate({ type: "session", sessionID: rollover.successorID })
      } catch {
        // Silent: a follow failure must never break the TUI.
      } finally {
        pending.delete(key)
      }
    })()
  })
  return () => {
    disposed = true
    pending.clear()
    unsubscribe()
  }
}
