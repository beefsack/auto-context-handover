import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseConfig, type HandoverConfig } from "./config.ts"
import {
  parseThreshold,
  resolveSoftTokens,
  selectThresholdValue,
  stageOf,
  type Measurement,
  type Stage,
} from "./measure.ts"
import { matchSoftMarker, resolveSoftMarker } from "./soft-marker.ts"

export interface AgyHookInput {
  readonly conversationId?: string
  readonly workspacePaths?: string[]
  readonly transcriptPath?: string
  readonly artifactDirectoryPath?: string
  readonly modelName?: string
  readonly lastUserInput?: string
  readonly invocationNum?: number
  readonly toolCall?: {
    readonly name?: string
    readonly args?: Record<string, unknown>
  }
}

export interface AgySessionState {
  readonly conversationId: string
  readonly artifactDirectoryPath?: string
  readonly workspacePaths?: string[]
  readonly modelName?: string
  readonly lastStage?: Stage
  readonly softOverride?: unknown
  readonly locked?: {
    readonly reason: string
    readonly at: number
    readonly summary: string
    readonly handoverPath: string
  }
}

export interface AgyIndexEntry {
  readonly handoverPath: string
  readonly summary: string
  readonly storedAt: number
}

export interface AgyTranscriptStep {
  readonly type?: unknown
  readonly content?: unknown
  readonly tool_calls?: unknown
  readonly input_tokens?: unknown
  readonly cache_read_tokens?: unknown
  readonly output_tokens?: unknown
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PLUGIN_DATA?.trim()
  if (fromEnv) return fromEnv
  return path.join(os.homedir(), ".gemini", "antigravity-plugin-data", "auto-context-handover")
}

const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9._-]/g, "_")

const readJsonFile = (filePath: string): Record<string, unknown> | undefined => {
  try {
    const raw = fs.readFileSync(filePath, "utf8")
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const writeJsonFile = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8")
}

export function readSessionState(dataDir: string, conversationId: string): AgySessionState | undefined {
  const filePath = path.join(dataDir, "sessions", `${safeId(conversationId)}.json`)
  const data = readJsonFile(filePath)
  if (!data || typeof data.conversationId !== "string") return undefined
  return data as unknown as AgySessionState
}

export function writeSessionState(dataDir: string, state: AgySessionState): void {
  const filePath = path.join(dataDir, "sessions", `${safeId(state.conversationId)}.json`)
  writeJsonFile(filePath, state)
}

export function recordActiveSession(dataDir: string, conversationId: string): void {
  writeJsonFile(path.join(dataDir, "active-session.json"), {
    conversationId,
    updatedAt: Date.now(),
  })
}

export function readActiveSessionId(dataDir: string): string | undefined {
  const data = readJsonFile(path.join(dataDir, "active-session.json"))
  return typeof data?.conversationId === "string" ? data.conversationId : undefined
}

export function readIndex(dataDir: string): Record<string, AgyIndexEntry> {
  const data = readJsonFile(path.join(dataDir, "index.json"))
  if (!data) return {}
  const out: Record<string, AgyIndexEntry> = {}
  for (const [key, val] of Object.entries(data)) {
    if (
      typeof val === "object" &&
      val !== null &&
      typeof (val as { handoverPath?: unknown }).handoverPath === "string"
    ) {
      const entry = val as { handoverPath: string; summary?: unknown; storedAt?: unknown }
      out[key] = {
        handoverPath: entry.handoverPath,
        summary: typeof entry.summary === "string" ? entry.summary : "",
        storedAt: typeof entry.storedAt === "number" ? entry.storedAt : 0,
      }
    }
  }
  return out
}

export function writeIndexEntry(dataDir: string, sessionId: string, entry: AgyIndexEntry): void {
  const index = readIndex(dataDir)
  index[sessionId] = entry
  writeJsonFile(path.join(dataDir, "index.json"), index)
}

const parseEnvThreshold = (value: string | undefined): unknown => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed
}

export function loadAgyConfig(
  dataDir: string,
  workspacePaths?: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): HandoverConfig {
  let raw: Record<string, unknown> = {}
  const globalConfig = readJsonFile(path.join(dataDir, "config.json"))
  if (globalConfig) raw = { ...raw, ...globalConfig }

  const primaryWorkspace = workspacePaths?.[0]
  if (primaryWorkspace) {
    const workspaceConfig = readJsonFile(path.join(primaryWorkspace, ".agents", "auto-context-handover.json"))
    if (workspaceConfig) raw = { ...raw, ...workspaceConfig }
  }

  const envSoft = parseEnvThreshold(env.AUTO_CONTEXT_HANDOVER_SOFT)
  if (envSoft !== undefined) raw.soft = envSoft
  const envHard = parseEnvThreshold(env.AUTO_CONTEXT_HANDOVER_HARD)
  if (envHard !== undefined) raw.hard = envHard

  return parseConfig(raw)
}

export function extractSoftOverride(lastUserInput: string | undefined): unknown {
  if (!lastUserInput) return undefined
  const match = matchSoftMarker(lastUserInput)
  if (!match) return undefined
  return resolveSoftMarker(match)
}

export function measureTranscriptSteps(steps: ReadonlyArray<AgyTranscriptStep>): Measurement | undefined {
  let anchorIndex = -1
  let measuredTokens = 0

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step?.type !== "PLANNER_RESPONSE") continue
    const input = step.input_tokens
    const cacheRead = step.cache_read_tokens
    const output = step.output_tokens
    if (
      typeof input === "number" &&
      Number.isFinite(input) &&
      input >= 0 &&
      typeof cacheRead === "number" &&
      Number.isFinite(cacheRead) &&
      cacheRead >= 0 &&
      typeof output === "number" &&
      Number.isFinite(output) &&
      output >= 0
    ) {
      const total = input + cacheRead + output
      if (total > 0) {
        anchorIndex = i
        measuredTokens = total
        break
      }
    }
  }

  if (anchorIndex < 0) return undefined

  let trailingChars = 0
  for (let i = anchorIndex + 1; i < steps.length; i++) {
    const step = steps[i]
    if (!step) continue
    if (typeof step.content === "string") {
      trailingChars += step.content.length
    }
    if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      try {
        trailingChars += JSON.stringify(step.tool_calls).length
      } catch {
        // ignore unserializable tool_calls
      }
    }
  }

  return {
    anchorIndex,
    measuredTokens,
    trailingChars,
    estimate: measuredTokens + Math.ceil(trailingChars / 4),
  }
}

export function measureTranscriptFile(transcriptPath: string | undefined): Measurement | undefined {
  if (!transcriptPath) return undefined
  const fullPath = path.join(path.dirname(transcriptPath), "transcript_full.jsonl")
  const targetPath = fs.existsSync(fullPath) ? fullPath : transcriptPath
  let raw: string
  try {
    raw = fs.readFileSync(targetPath, "utf8")
  } catch {
    return undefined
  }
  const steps: AgyTranscriptStep[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === "object" && parsed !== null) {
        steps.push(parsed as AgyTranscriptStep)
      }
    } catch {
      // skip partial or malformed trailing line
    }
  }
  return measureTranscriptSteps(steps)
}

export interface StageEvaluation {
  readonly stage: Stage
  readonly estimate: number
  readonly softTokens: number
  readonly hardTokens?: number
}

export function evaluateStage(
  measurement: Measurement | undefined,
  config: HandoverConfig,
  modelName: string | undefined,
  softOverride?: unknown,
): StageEvaluation | undefined {
  if (!measurement) return undefined
  const selectedSoft =
    softOverride !== undefined
      ? softOverride
      : selectThresholdValue(config, {
          agent: "antigravity",
          providerID: "antigravity",
          modelID: modelName ?? "unknown",
        })
  const softTokens = resolveSoftTokens(parseThreshold(selectedSoft), undefined)
  if (softTokens === undefined) return undefined

  let hardTokens: number | undefined
  if (config.hard !== undefined) {
    const hardSpec = parseThreshold(config.hard)
    if (hardSpec.kind === "tokens") {
      hardTokens = hardSpec.tokens
    }
  }

  const stage = stageOf(measurement.estimate, softTokens, hardTokens, config.stages)
  return { stage, estimate: measurement.estimate, softTokens, hardTokens }
}

const STAGE_ORDER: Record<Stage, number> = {
  ok: 0,
  warn1: 1,
  warn2: 2,
  warn3: 3,
  hard: 4,
}

export function didStageEscalate(previous: Stage | undefined, current: Stage): boolean {
  if (current === "ok") return false
  const prevRank = previous ? STAGE_ORDER[previous] : 0
  return STAGE_ORDER[current] > prevRank
}

export function isHandoverToolName(toolName: string | undefined): boolean {
  if (!toolName) return false
  return (
    toolName === "context_handover" ||
    toolName.endsWith("_context_handover") ||
    toolName.endsWith(":context_handover")
  )
}

export function storeHandover(params: {
  readonly dataDir: string
  readonly sessionId: string
  readonly handover: string
  readonly summary: string
  readonly artifactDirectoryPath?: string
}): { readonly sessionId: string; readonly handoverPath: string; readonly summary: string } {
  const { dataDir, sessionId, handover, summary, artifactDirectoryPath } = params
  const handoverPath = artifactDirectoryPath
    ? path.join(artifactDirectoryPath, "handover.md")
    : path.join(dataDir, "handovers", `${safeId(sessionId)}.md`)

  fs.mkdirSync(path.dirname(handoverPath), { recursive: true })
  fs.writeFileSync(handoverPath, handover, "utf8")

  writeIndexEntry(dataDir, sessionId, {
    handoverPath,
    summary,
    storedAt: Date.now(),
  })

  const existing = readSessionState(dataDir, sessionId)
  writeSessionState(dataDir, {
    ...(existing ?? { conversationId: sessionId }),
    conversationId: sessionId,
    locked: {
      reason: "handover complete",
      at: Date.now(),
      summary,
      handoverPath,
    },
  })

  return { sessionId, handoverPath, summary }
}

export function readStoredHandover(params: {
  readonly dataDir: string
  readonly sessionId: string
}): { readonly sessionId: string; readonly handoverPath: string; readonly text: string; readonly summary: string } {
  const { dataDir, sessionId } = params
  const index = readIndex(dataDir)
  const entry = index[sessionId]
  const fallbackPath = path.join(dataDir, "handovers", `${safeId(sessionId)}.md`)
  const handoverPath = entry?.handoverPath ?? fallbackPath

  if (!fs.existsSync(handoverPath)) {
    throw new Error(`No stored handover found for session ${sessionId}`)
  }
  const text = fs.readFileSync(handoverPath, "utf8")
  return {
    sessionId,
    handoverPath,
    text,
    summary: entry?.summary ?? "",
  }
}
