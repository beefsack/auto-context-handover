import readline from "node:readline"
import {
  loadAgyConfig,
  readActiveSessionId,
  readSessionState,
  readStoredHandover,
  resolveDataDir,
  storeHandover,
} from "./agy-core.ts"
import { HANDOVER_TOOL, READ_TOOL } from "./store.ts"
import { HANDOVER_DESCRIPTION } from "./text.ts"

interface JsonRpcRequest {
  readonly jsonrpc?: string
  readonly id?: unknown
  readonly method: string
  readonly params?: Record<string, unknown>
}

const PROTOCOL_VERSION = "2024-11-05"

function writeMessage(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + "\n")
}

function sendResult(id: unknown, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result })
}

function sendError(id: unknown, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } })
}

function getToolDefinitions(dataDir: string) {
  let description = HANDOVER_DESCRIPTION
  try {
    const config = loadAgyConfig(dataDir, [process.cwd()])
    if (config.handoverDescription) {
      description = config.handoverDescription
    }
  } catch {
    // fall back to built-in description
  }

  return [
    {
      name: HANDOVER_TOOL,
      description,
      inputSchema: {
        type: "object",
        properties: {
          handover: {
            type: "string",
            description: "Full verbatim handover text for the successor session.",
          },
          summary: {
            type: "string",
            description: "Short status, outcome, and next-step summary for the parent agent or user.",
          },
          sessionId: {
            type: "string",
            description: "Optional conversation ID (automatically populated by plugin hook when omitted).",
          },
        },
        required: ["handover", "summary"],
      },
    },
    {
      name: READ_TOOL,
      description:
        "Read the full verbatim stored handover text for a previous session by sessionID.",
      inputSchema: {
        type: "object",
        properties: {
          sessionID: {
            type: "string",
            description: "The conversation/session ID whose handover should be read.",
          },
        },
        required: ["sessionID"],
      },
    },
  ]
}

function handleToolCall(
  dataDir: string,
  name: string,
  args: Record<string, unknown>,
): { readonly content: Array<{ readonly type: "text"; readonly text: string }>; readonly isError?: boolean } {
  if (name === HANDOVER_TOOL) {
    const handover = typeof args.handover === "string" ? args.handover : ""
    const summary = typeof args.summary === "string" ? args.summary : ""
    if (!handover.trim() || !summary.trim()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Both 'handover' and 'summary' must be non-empty strings.",
          },
        ],
      }
    }

    const explicitId = typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : undefined
    const sessionId = explicitId ?? readActiveSessionId(dataDir) ?? `agy-${Date.now()}`
    const state = readSessionState(dataDir, sessionId)

    if (state?.locked) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Session ${sessionId} is already handed over and locked. ` +
              `Handover file: ${state.locked.handoverPath}`,
          },
        ],
      }
    }

    const stored = storeHandover({
      dataDir,
      sessionId,
      handover,
      summary,
      artifactDirectoryPath: state?.artifactDirectoryPath,
    })

    return {
      content: [
        {
          type: "text",
          text:
            `Handover stored and session ${stored.sessionId} locked.\n` +
            `Full handover file: ${stored.handoverPath}\n` +
            `Summary: ${stored.summary}\n\n` +
            `To resume in a new session, read ${stored.handoverPath} or call ${READ_TOOL} with sessionID ${JSON.stringify(stored.sessionId)}.`,
        },
      ],
    }
  }

  if (name === READ_TOOL) {
    const sessionID = typeof args.sessionID === "string" ? args.sessionID.trim() : ""
    if (!sessionID) {
      return {
        isError: true,
        content: [{ type: "text", text: "'sessionID' must be a non-empty string." }],
      }
    }
    try {
      const stored = readStoredHandover({ dataDir, sessionId: sessionID })
      return {
        content: [
          {
            type: "text",
            text:
              `Handover for session ${stored.sessionId} (${stored.handoverPath}):\n\n` +
              `${stored.text}`,
          },
        ],
      }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: (error as Error).message }],
      }
    }
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  }
}

function main(): void {
  const dataDir = resolveDataDir()
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  rl.on("line", (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    let req: JsonRpcRequest
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      return
    }

    // Notifications (no id) do not receive a response.
    if (req.id === undefined || req.id === null) {
      return
    }

    if (req.method === "initialize") {
      sendResult(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "auto-context-handover",
          version: "0.1.0",
        },
      })
      return
    }

    if (req.method === "ping") {
      sendResult(req.id, {})
      return
    }

    if (req.method === "tools/list") {
      sendResult(req.id, {
        tools: getToolDefinitions(dataDir),
      })
      return
    }

    if (req.method === "tools/call") {
      const params = req.params ?? {}
      const name = typeof params.name === "string" ? params.name : ""
      const args =
        typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}
      const result = handleToolCall(dataDir, name, args)
      sendResult(req.id, result)
      return
    }

    sendError(req.id, -32601, `Method not found: ${req.method}`)
  })
}

main()
