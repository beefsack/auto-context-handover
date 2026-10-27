// Pure measurement, threshold, stage, gate, and loop-guard logic.
// No host imports; unit-testable without a session.
// Usage contract (core/src/session/usage.ts:11-18): stored tokens are already
// normalized to input=nonCachedInputTokens, output=visibleOutputTokens
// (reasoning excluded), reasoning, cache.read, cache.write. Always sum the
// five normalized fields once; native metadata is never a usage source.

export type ThresholdSpec = { readonly kind: "percent"; readonly ratio: number } | { readonly kind: "tokens"; readonly tokens: number }

export class ThresholdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ThresholdError"
  }
}

/** A "70%" string or a positive absolute integer. Ratios are rejected. */
export function parseThreshold(value: unknown): ThresholdSpec {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ThresholdError(`threshold must be a "70%" string or a positive absolute integer of tokens, got ${String(value)}`)
    }
    return { kind: "tokens", tokens: value }
  }
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)%$/)
    if (!match) {
      throw new ThresholdError(`threshold must be a "70%" string or a positive absolute integer of tokens, got ${JSON.stringify(value)}`)
    }
    const ratio = Number(match[1]) / 100
    if (!(ratio > 0) || ratio > 1) {
      throw new ThresholdError(`threshold percent must be within (0%, 100%], got ${JSON.stringify(value)}`)
    }
    return { kind: "percent", ratio }
  }
  throw new ThresholdError(`threshold must be a "70%" string or a positive absolute integer of tokens, got ${String(value)}`)
}

export function resolveThresholdTokens(spec: ThresholdSpec, windowTokens: number): number {
  if (spec.kind === "tokens") return spec.tokens
  return Math.floor(spec.ratio * windowTokens)
}

export interface ModelWindow {
  readonly providerID: string
  readonly id: string
  readonly limit: { readonly context: number; readonly input?: number }
}

/** Match providerID+id; prefer the positive input limit, else the context limit. Undefined means fail open. */
export function resolveModelWindow(
  models: ReadonlyArray<ModelWindow> | undefined,
  providerID: string,
  modelID: string,
): number | undefined {
  const found = models?.find((model) => model.providerID === providerID && model.id === modelID)
  if (!found) return undefined
  if (found.limit.input !== undefined && Number.isFinite(found.limit.input) && found.limit.input > 0) {
    return found.limit.input
  }
  if (Number.isFinite(found.limit.context) && found.limit.context > 0) return found.limit.context
  return undefined
}

export interface ThresholdScope {
  readonly agent: string
  readonly providerID: string
  readonly modelID: string
}

/** Precedence: agent override > "providerID/modelID" > bare "modelID" > soft. */
export function selectThresholdValue(
  input: {
    readonly soft: unknown
    readonly modelOverrides?: Readonly<Record<string, unknown>>
    readonly agentOverrides?: Readonly<Record<string, unknown>>
  },
  scope: ThresholdScope,
): unknown {
  const agent = input.agentOverrides?.[scope.agent]
  if (agent !== undefined) return agent
  const scoped = input.modelOverrides?.[`${scope.providerID}/${scope.modelID}`]
  if (scoped !== undefined) return scoped
  const bare = input.modelOverrides?.[scope.modelID]
  if (bare !== undefined) return bare
  return input.soft
}

export interface TokenUsageInput {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export interface NarrowMessage {
  readonly kind: string
  readonly tokens?: TokenUsageInput
  /** Text/call-arg chars covered by no usage counter yet. */
  readonly ownChars: number
  /** Settled tool-output text chars. */
  readonly resultChars: number
}

const textLength = (value: unknown): number => (typeof value === "string" ? value.length : 0)

const jsonLength = (value: unknown): number => {
  try {
    const rendered = typeof value === "string" ? value : JSON.stringify(value)
    return typeof rendered === "string" ? rendered.length : 0
  } catch {
    return 0
  }
}

/** Map a persisted session message to cheap char counts. No host types; structural only. */
export function narrow(message: {
  readonly type: string
  readonly text?: unknown
  readonly tokens?: TokenUsageInput
  readonly content?: ReadonlyArray<{
    readonly type: string
    readonly text?: unknown
    readonly state?: unknown
  }>
}): NarrowMessage {
  if (message.type !== "assistant") {
    return { kind: message.type, ownChars: textLength(message.text), resultChars: 0 }
  }
  let ownChars = 0
  let resultChars = 0
  for (const part of message.content ?? []) {
    if (part.type === "text" || part.type === "reasoning") {
      ownChars += textLength(part.text)
    } else if (part.type === "tool" && typeof part.state === "object" && part.state !== null) {
      const state = part.state as { status?: unknown; input?: unknown; content?: unknown }
      ownChars += jsonLength(state.input)
      if ((state.status === "completed" || state.status === "error") && Array.isArray(state.content)) {
        for (const item of state.content) {
          if (typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text") {
            resultChars += textLength((item as { text?: unknown }).text)
          }
        }
      }
    }
  }
  return { kind: "assistant", tokens: message.tokens, ownChars, resultChars }
}

export interface Measurement {
  readonly anchorIndex: number
  readonly measuredTokens: number
  readonly trailingChars: number
  readonly estimate: number
}

/**
 * Latest assistant message with usable actual provider usage is the anchor.
 * Core records zeros when usage is absent, so all-zero counts as unknown and
 * scanning continues older. Trailing content the anchor never saw (its settled
 * tool results plus every later message) is added as chars/4. Undefined means
 * fail open. Totals/cost are never used.
 */
export function measureSession(messages: ReadonlyArray<NarrowMessage>): Measurement | undefined {
  let anchorIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const tokens = message?.kind === "assistant" ? message.tokens : undefined
    if (
      tokens &&
      [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write].every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      ) &&
      tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write > 0
    ) {
      anchorIndex = index
      break
    }
  }
  if (anchorIndex < 0) return undefined
  const anchor = messages[anchorIndex]
  const tokens = anchor?.tokens
  if (!anchor || !tokens) return undefined
  const measuredTokens = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  let trailingChars = anchor.resultChars
  for (let index = anchorIndex + 1; index < messages.length; index++) {
    const message = messages[index]
    if (message) trailingChars += message.ownChars + message.resultChars
  }
  return {
    anchorIndex,
    measuredTokens,
    trailingChars,
    estimate: measuredTokens + Math.ceil(trailingChars / 4),
  }
}

export type Stage = "ok" | "warn1" | "warn2" | "warn3" | "hard"

/** Boundaries relative to soft: warn at soft, then soft*(1+offset). First offset must be 0. */
export function stageOf(
  estimate: number,
  softTokens: number,
  hardTokens?: number,
  offsets: readonly [number, number, number] = [0, 0.1, 0.2],
): Stage {
  if (hardTokens !== undefined && estimate >= hardTokens) return "hard"
  if (estimate >= softTokens * (1 + offsets[2])) return "warn3"
  if (estimate >= softTokens * (1 + offsets[1])) return "warn2"
  if (estimate >= softTokens * (1 + offsets[0])) return "warn1"
  return "ok"
}

/** Remove every tool except kept from the record. keep=null strips all. Returns removed names. */
export function applyToolGate(tools: Record<string, unknown>, keep: ReadonlyArray<string> | null): string[] {
  const removed: string[] = []
  for (const name of Object.keys(tools)) {
    if (keep !== null && keep.includes(name)) continue
    delete tools[name]
    removed.push(name)
  }
  return removed
}

export interface LoopState {
  readonly chain: number
  readonly unproductive: number
  readonly seedEstimate: number
  readonly highWater: number
}

/** A successor is productive when it added at least 25% of soft beyond its seed. */
export function productiveHandover(addedTokens: number, softTokens: number): boolean {
  return addedTokens >= softTokens * 0.25
}

/** Next state for a handover. isRoot (no predecessor link) never counts. */
export function nextLoopState(
  previous: LoopState | undefined,
  observation: { readonly addedTokens: number; readonly softTokens: number; readonly isRoot: boolean; readonly seedEstimate: number; readonly highWater: number },
): LoopState {
  if (observation.isRoot) {
    return { chain: 0, unproductive: 0, seedEstimate: observation.seedEstimate, highWater: observation.highWater }
  }
  return {
    chain: (previous?.chain ?? 0) + 1,
    unproductive: productiveHandover(observation.addedTokens, observation.softTokens)
      ? 0
      : (previous?.unproductive ?? 0) + 1,
    seedEstimate: observation.seedEstimate,
    highWater: observation.highWater,
  }
}

/** A successor inherits the UPDATED streak so the count survives rotation. */
export function inheritStreak(parent: LoopState, seedEstimate: number): LoopState {
  return { chain: parent.chain, unproductive: parent.unproductive, seedEstimate, highWater: 0 }
}

/** Pause the primary for draft review after 3 consecutive unproductive successions. */
export function loopDraftRequired(state: LoopState): boolean {
  return state.unproductive >= 3
}

/** Warn when the full seed alone exceeds 50% of soft; never blocks. */
export function seedTooLarge(seedEstimate: number, softTokens: number): boolean {
  return seedEstimate > softTokens * 0.5
}
