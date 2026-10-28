// Integer/percentage threshold parsing shared by the OpenCode adapter and the
// Claude Code child adapter. Node-free; no host imports.
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
