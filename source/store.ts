// Session-keyed KV records. Storage fallback B: verbatim handover text,
// locks, loop state, and link metadata live in ctx.storage KV, never in
// external files. Cleaned up on session.deleted.

export const HANDOVER_TOOL = "context_handover"
export const READ_TOOL = "read_handover"

const PREFIX = "auto-context-handover"

export const keys = {
  handover: (sessionID: string) => `${PREFIX}:handover:${sessionID}`,
  lock: (sessionID: string) => `${PREFIX}:lock:${sessionID}`,
  state: (sessionID: string) => `${PREFIX}:state:${sessionID}`,
  forward: (sessionID: string) => `${PREFIX}:link:forward:${sessionID}`,
  back: (sessionID: string) => `${PREFIX}:link:back:${sessionID}`,
  softOverride: (sessionID: string) => `${PREFIX}:soft-override:${sessionID}`,
}

export const allKeys = (sessionID: string): string[] => [
  keys.handover(sessionID),
  keys.lock(sessionID),
  keys.state(sessionID),
  keys.forward(sessionID),
  keys.back(sessionID),
  keys.softOverride(sessionID),
]

export interface StoredHandover {
  readonly text: string
  readonly summary: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly storedAt: number
  readonly diag?: StoredDiag
}

export interface StoredDiag {
  readonly reason: string
  readonly stage: string
  readonly estimate: number | "unknown"
  readonly soft: number | "unknown"
}

export interface StoredLock {
  readonly reason: string
  readonly at: number
  /** Initial parent-facing child reply; its presence selects child locked-follow-up guidance. Never the full handover. */
  readonly finalReply?: string
}

export interface StoredState {
  readonly chain: number
  readonly unproductive: number
  readonly seedEstimate: number
  readonly highWater: number
}

export interface StoredLink {
  readonly sessionID: string
  readonly at: number
}

export interface StoredSoftOverride {
  readonly value: unknown
  readonly at: number
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
