// Option parsing. Invalid values throw a plain Error at setup time.

import { parseThreshold } from "./measure.ts"

export interface HandoverConfig {
  readonly soft: unknown
  readonly hard: unknown
  readonly modelOverrides: Record<string, unknown>
  readonly agentOverrides: Record<string, unknown>
  readonly stages: readonly [number, number, number]
  readonly primary: "new-session" | "lock"
  readonly subagent: "return"
  readonly handoverDescription: string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const checkMap = (value: unknown, name: "modelOverrides" | "agentOverrides"): Record<string, unknown> => {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new Error(`auto-context-handover: "${name}" must be an object keyed by ${name === "modelOverrides" ? '"provider/model" or "model"' : "agent ID"}`)
  }
  for (const [key, entry] of Object.entries(value)) {
    try {
      parseThreshold(entry)
    } catch (error) {
      throw new Error(`auto-context-handover: invalid threshold in "${name}" for ${JSON.stringify(key)}: ${(error as Error).message}`)
    }
  }
  return { ...value }
}

export function parseConfig(options: unknown): HandoverConfig {
  const input = isRecord(options) ? options : {}
  const soft = input.soft ?? 200000
  try {
    parseThreshold(soft)
  } catch (error) {
    throw new Error(`auto-context-handover: invalid "soft" threshold: ${(error as Error).message}`)
  }
  const hard = input.hard
  if (hard !== undefined) {
    try {
      parseThreshold(hard)
    } catch (error) {
      throw new Error(`auto-context-handover: invalid "hard" threshold: ${(error as Error).message}`)
    }
  }
  const modelOverrides = checkMap(input.modelOverrides, "modelOverrides")
  const agentOverrides = checkMap(input.agentOverrides, "agentOverrides")
  let stages: readonly [number, number, number] = [0, 0.1, 0.2]
  if (input.stages !== undefined) {
    const valid =
      Array.isArray(input.stages) &&
      input.stages.length === 3 &&
      input.stages.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    const [first, second, third] = (input.stages ?? []) as Array<number>
    if (!valid || first !== 0 || !(first <= second && second <= third)) {
      throw new Error('auto-context-handover: "stages" must be 3 ascending relative offsets starting at 0, e.g. [0, 0.1, 0.2]')
    }
    stages = [first, second, third]
  }
  const action = input.onHandover ?? {}
  if (!isRecord(action)) {
    throw new Error('auto-context-handover: unsupported "onHandover"; use nested { "primary": "new-session" | "lock", "subagent": "return" }')
  }
  const primary = action.primary ?? "new-session"
  if (primary !== "new-session" && primary !== "lock") {
    throw new Error(`auto-context-handover: unsupported onHandover.primary ${JSON.stringify(primary)}; use "new-session" or "lock"`)
  }
  const subagent = action.subagent ?? "return"
  if (subagent !== "return") {
    throw new Error(`auto-context-handover: unsupported onHandover.subagent ${JSON.stringify(subagent)}; use "return"`)
  }
  const handoverDescription = input.handoverDescription
  if (handoverDescription !== undefined && typeof handoverDescription !== "string") {
    throw new Error('auto-context-handover: "handoverDescription" must be a string template')
  }
  return {
    soft,
    hard,
    modelOverrides,
    agentOverrides,
    stages,
    primary,
    subagent,
    handoverDescription: handoverDescription as string | undefined,
  }
}
