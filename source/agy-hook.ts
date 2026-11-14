import fs from "node:fs"
import {
  didStageEscalate,
  evaluateStage,
  extractSoftOverride,
  isHandoverToolName,
  loadAgyConfig,
  measureTranscriptFile,
  readSessionState,
  recordActiveSession,
  resolveDataDir,
  writeSessionState,
  type AgyHookInput,
  type AgySessionState,
} from "./agy-core.ts"
import { buildHardDirective, buildLockedDirective, buildNudge } from "./text.ts"

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function upsertSessionMetadata(dataDir: string, input: AgyHookInput): AgySessionState | undefined {
  const id = input.conversationId
  if (!id) return undefined
  recordActiveSession(dataDir, id)
  const existing = readSessionState(dataDir, id)
  const updated: AgySessionState = {
    ...existing,
    conversationId: id,
    artifactDirectoryPath: input.artifactDirectoryPath ?? existing?.artifactDirectoryPath,
    workspacePaths: input.workspacePaths ?? existing?.workspacePaths,
    modelName: input.modelName ?? existing?.modelName,
  }
  writeSessionState(dataDir, updated)
  return updated
}

function handleSessionStart(dataDir: string, input: AgyHookInput): Record<string, unknown> {
  upsertSessionMetadata(dataDir, input)
  return {}
}

function handlePreInvocation(dataDir: string, input: AgyHookInput): Record<string, unknown> {
  const id = input.conversationId
  if (!id) return {}

  let state = upsertSessionMetadata(dataDir, input)
  if (!state) return {}

  if (state.softOverride === undefined && input.lastUserInput) {
    try {
      const override = extractSoftOverride(input.lastUserInput)
      if (override !== undefined) {
        state = { ...state, softOverride: override }
        writeSessionState(dataDir, state)
      }
    } catch (error) {
      return {
        injectSteps: [
          {
            errorMessage: {
              userMessage: `auto-context-handover: ${(error as Error).message}`,
            },
          },
        ],
        terminationBehavior: "terminate",
      }
    }
  }

  if (state.locked) {
    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              `${buildLockedDirective(state.locked.reason, id)} ` +
              `Handover file: ${state.locked.handoverPath}`,
          },
        },
      ],
    }
  }

  let config
  try {
    config = loadAgyConfig(dataDir, input.workspacePaths)
  } catch (error) {
    return {
      injectSteps: [
        {
          errorMessage: {
            userMessage: `auto-context-handover config error: ${(error as Error).message}`,
          },
        },
      ],
      terminationBehavior: "terminate",
    }
  }

  const measurement = measureTranscriptFile(input.transcriptPath)
  const evaluation = evaluateStage(measurement, config, input.modelName, state.softOverride)
  if (!evaluation || !didStageEscalate(state.lastStage, evaluation.stage)) {
    return {}
  }

  writeSessionState(dataDir, { ...state, lastStage: evaluation.stage })

  const message =
    evaluation.stage === "hard"
      ? buildHardDirective(evaluation.hardTokens)
      : buildNudge(evaluation.stage)

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: message,
        },
      },
    ],
  }
}

function handlePreToolUse(dataDir: string, input: AgyHookInput): Record<string, unknown> {
  const id = input.conversationId
  if (!id) return {}

  const state = upsertSessionMetadata(dataDir, input)
  if (!state) return {}

  const toolName = input.toolCall?.name
  const isHandover = isHandoverToolName(toolName)

  if (state.locked) {
    return {
      decision: "deny",
      reason:
        `Session ${id} is handed over and locked. ` +
        `Full handover is at ${state.locked.handoverPath}. ` +
        `Continue in a new session using that file or read_handover(${JSON.stringify(id)}).`,
    }
  }

  let config
  try {
    config = loadAgyConfig(dataDir, input.workspacePaths)
  } catch {
    return {}
  }

  const measurement = measureTranscriptFile(input.transcriptPath)
  const evaluation = evaluateStage(measurement, config, input.modelName, state.softOverride)

  if (evaluation?.stage === "hard" && !isHandover) {
    return {
      decision: "deny",
      reason: buildHardDirective(evaluation.hardTokens),
    }
  }

  if (isHandover) {
    const existingArgs = input.toolCall?.args ?? {}
    if (typeof existingArgs.sessionId !== "string" || !existingArgs.sessionId.trim()) {
      return {
        decision: "allow",
        overwrite: {
          sessionId: id,
        },
      }
    }
    return { decision: "allow" }
  }

  return {}
}

function main(): void {
  const event = process.argv[2]
  const raw = readStdin().trim()
  let input: AgyHookInput = {}
  if (raw) {
    try {
      input = JSON.parse(raw) as AgyHookInput
    } catch {
      input = {}
    }
  }

  const dataDir = resolveDataDir()
  let output: Record<string, unknown> = {}

  if (event === "session-start") {
    output = handleSessionStart(dataDir, input)
  } else if (event === "pre-invocation") {
    output = handlePreInvocation(dataDir, input)
  } else if (event === "pre-tool-use") {
    output = handlePreToolUse(dataDir, input)
  }

  process.stdout.write(JSON.stringify(output) + "\n")
}

main()
