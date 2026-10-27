// Subagent soft-limit marker parsing. Pure; unit-testable without a host.
// A real child session may open with `[auto-context-handover-test soft=4096]`
// (after OpenCode's standard subagent banner) to override its own soft
// threshold. The marker is prefix-only: quoted text, tool results, and later
// history are never scanned. Unknown, duplicate, or invalid keys throw
// instead of being silently ignored.

import { parseThreshold } from "./measure.ts"

// Verbatim from the host subagent tool (core/src/tool/plugin/subagent.ts):
// a fresh child prompt is admitted as [banner, input.prompt].join("\n").
export const SUBAGENT_BANNER = "You are a subagent spawned by another session."
export const SOFT_MARKER_TAG = "auto-context-handover-test"

export class SoftMarkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SoftMarkerError"
  }
}

export interface SoftMarkerMatch {
  /** Banner line plus its newline when present, else "". Preserved on strip. */
  readonly prefix: string
  /** Raw text between the tag and the closing bracket. */
  readonly inner: string
  /** Text after the closing bracket. */
  readonly rest: string
  /** True when the namespaced tag opened but no closing bracket follows. */
  readonly unclosed: boolean
}

export interface ParsedSoftMarker {
  /** Validated soft threshold in configured formats ("70%" or positive integer). */
  readonly value: unknown
  /** Admitted prompt text with the marker removed (banner preserved). */
  readonly text: string
}

/** Banner-aware prefix match with no validation. Guides scope checks before strict parsing. */
export function matchSoftMarker(text: string): SoftMarkerMatch | undefined {
  let prefix = ""
  let body = text
  if (body.startsWith(`${SUBAGENT_BANNER}\n`)) {
    prefix = `${SUBAGENT_BANNER}\n`
    body = body.slice(prefix.length)
  }
  const match = /^\[auto-context-handover-test((?:\s[^\]]*)?)\]/.exec(body)
  if (!match) {
    // A scoped tag attempt without its closing bracket is malformed, not
    // absent. Glued or other namespaces ([...-tests], [...-foo]) stay untouched.
    if (/^\[auto-context-handover-test(?:\s|$)/.test(body)) {
      return { prefix, inner: body.slice("[auto-context-handover-test".length), rest: "", unclosed: true }
    }
    return undefined
  }
  return { prefix, inner: match[1] ?? "", rest: body.slice(match[0].length), unclosed: false }
}

const coerceThresholdValue = (raw: string): unknown => (/^\d+$/.test(raw) ? Number(raw) : raw)

/** Strict parse of a matched marker. Throws SoftMarkerError on unclosed, empty, malformed, unknown, duplicate, or invalid input. */
export function resolveSoftMarker(match: SoftMarkerMatch): ParsedSoftMarker {
  const { prefix, inner, rest } = match
  if (match.unclosed) {
    throw new SoftMarkerError(
      `auto-context-handover: unclosed subagent soft marker ${JSON.stringify(`[${SOFT_MARKER_TAG}${inner}`)}; add the closing "]", e.g. [${SOFT_MARKER_TAG} soft=4096]`,
    )
  }
  const tokens = inner.trim().split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length === 0) {
    throw new SoftMarkerError(
      `auto-context-handover: empty subagent soft marker; pass at least one key=value pair, e.g. [${SOFT_MARKER_TAG} soft=4096]`,
    )
  }
  let seenSoft = false
  let value: unknown
  for (const token of tokens) {
    const eq = token.indexOf("=")
    if (eq <= 0) {
      throw new SoftMarkerError(
        `auto-context-handover: malformed pair ${JSON.stringify(token)} in subagent soft marker; use key=value, e.g. [${SOFT_MARKER_TAG} soft=4096]`,
      )
    }
    const key = token.slice(0, eq)
    const raw = token.slice(eq + 1)
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || raw.length === 0) {
      throw new SoftMarkerError(
        `auto-context-handover: malformed pair ${JSON.stringify(token)} in subagent soft marker; use key=value, e.g. [${SOFT_MARKER_TAG} soft=4096]`,
      )
    }
    if (key !== "soft") {
      throw new SoftMarkerError(
        `auto-context-handover: unknown key ${JSON.stringify(key)} in subagent soft marker; only "soft" is supported`,
      )
    }
    if (seenSoft) {
      throw new SoftMarkerError(`auto-context-handover: duplicate key "soft" in subagent soft marker`)
    }
    seenSoft = true
    const coerced = coerceThresholdValue(raw)
    try {
      parseThreshold(coerced)
    } catch (error) {
      throw new SoftMarkerError(
        `auto-context-handover: invalid soft value ${JSON.stringify(raw)} in subagent soft marker; ${(error as Error).message}`,
      )
    }
    value = coerced
  }
  // Drop the marker line break (plus stray spaces) so the admitted prompt starts at the real task.
  return { value, text: prefix + rest.replace(/^[ \t]*\r?\n?/, "") }
}

/** Combined detect-and-parse for tests and single-shot callers. Undefined when no marker prefix is present. */
export function parseSoftMarker(text: string): ParsedSoftMarker | undefined {
  const match = matchSoftMarker(text)
  if (!match) return undefined
  return resolveSoftMarker(match)
}
