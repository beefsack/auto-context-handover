import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  didStageEscalate,
  evaluateStage,
  isHandoverToolName,
  loadAgyConfig,
  measureTranscriptFile,
  measureTranscriptSteps,
  readSessionState,
  readStoredHandover,
  storeHandover,
} from "./agy-core.ts"

const makeTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "agy-handover-test-"))

test("measureTranscriptSteps anchors on latest usable PLANNER_RESPONSE and adds trailing chars/4", () => {
  const m = measureTranscriptSteps([
    { type: "USER_INPUT", content: "hi" },
    { type: "PLANNER_RESPONSE", input_tokens: 800, cache_read_tokens: 200, output_tokens: 100 },
    { type: "GENERIC", content: "12345678" }, // 8 chars -> 2 tokens
    { type: "PLANNER_RESPONSE", input_tokens: 0, cache_read_tokens: 0, output_tokens: 0 }, // ignored
    { type: "USER_INPUT", content: "abcd" }, // 4 chars -> 1 token
  ])
  assert.ok(m)
  assert.equal(m.anchorIndex, 1)
  assert.equal(m.measuredTokens, 1100)
  assert.equal(m.trailingChars, 12)
  assert.equal(m.estimate, 1103)
})

test("measureTranscriptFile prefers transcript_full.jsonl when present", () => {
  const dir = makeTempDir()
  try {
    const compactPath = path.join(dir, "transcript.jsonl")
    const fullPath = path.join(dir, "transcript_full.jsonl")
    fs.writeFileSync(
      compactPath,
      [
        JSON.stringify({ type: "PLANNER_RESPONSE", input_tokens: 1000, cache_read_tokens: 0, output_tokens: 100 }),
        JSON.stringify({ type: "GENERIC", content: "x", truncated_fields: ["content"] }),
      ].join("\n"),
    )
    fs.writeFileSync(
      fullPath,
      [
        JSON.stringify({ type: "PLANNER_RESPONSE", input_tokens: 1000, cache_read_tokens: 0, output_tokens: 100 }),
        JSON.stringify({ type: "GENERIC", content: "x".repeat(400) }),
      ].join("\n"),
    )
    const m = measureTranscriptFile(compactPath)
    assert.ok(m)
    assert.equal(m.estimate, 1200)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("didStageEscalate only triggers on upward stage transitions", () => {
  assert.equal(didStageEscalate(undefined, "ok"), false)
  assert.equal(didStageEscalate(undefined, "warn1"), true)
  assert.equal(didStageEscalate("warn1", "warn1"), false)
  assert.equal(didStageEscalate("warn1", "warn2"), true)
  assert.equal(didStageEscalate("warn2", "warn1"), false)
  assert.equal(didStageEscalate("warn3", "hard"), true)
})

test("isHandoverToolName matches bare and MCP-prefixed names", () => {
  assert.equal(isHandoverToolName("context_handover"), true)
  assert.equal(isHandoverToolName("mcp_auto-context-handover_context_handover"), true)
  assert.equal(isHandoverToolName("auto-context-handover:context_handover"), true)
  assert.equal(isHandoverToolName("run_command"), false)
})

test("loadAgyConfig merges global, workspace, and env overrides", () => {
  const dir = makeTempDir()
  try {
    const dataDir = path.join(dir, "data")
    const wsDir = path.join(dir, "ws")
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(path.join(wsDir, ".agents"), { recursive: true })
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ soft: 50000 }))
    fs.writeFileSync(path.join(wsDir, ".agents", "auto-context-handover.json"), JSON.stringify({ soft: 20000, hard: 30000 }))

    const cfg = loadAgyConfig(dataDir, [wsDir], {})
    assert.equal(cfg.soft, 20000)
    assert.equal(cfg.hard, 30000)

    const envCfg = loadAgyConfig(dataDir, [wsDir], { AUTO_CONTEXT_HANDOVER_SOFT: "4096" })
    assert.equal(envCfg.soft, 4096)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("storeHandover writes artifact handover.md, locks session, and readStoredHandover retrieves it", () => {
  const dir = makeTempDir()
  try {
    const dataDir = path.join(dir, "data")
    const artifactDir = path.join(dir, "artifacts")
    const stored = storeHandover({
      dataDir,
      sessionId: "conv-123",
      handover: "# Full Handover\nLine 2",
      summary: "Short summary",
      artifactDirectoryPath: artifactDir,
    })

    assert.equal(stored.handoverPath, path.join(artifactDir, "handover.md"))
    assert.equal(fs.readFileSync(stored.handoverPath, "utf8"), "# Full Handover\nLine 2")

    const state = readSessionState(dataDir, "conv-123")
    assert.ok(state?.locked)
    assert.equal(state.locked.handoverPath, stored.handoverPath)

    const read = readStoredHandover({ dataDir, sessionId: "conv-123" })
    assert.equal(read.text, "# Full Handover\nLine 2")
    assert.equal(read.summary, "Short summary")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("evaluateStage respects softOverride", () => {
  const cfg = loadAgyConfig(makeTempDir(), [], {})
  const ev = evaluateStage({ anchorIndex: 0, measuredTokens: 5000, trailingChars: 0, estimate: 5000 }, cfg, "auto", 4096)
  assert.ok(ev)
  assert.equal(ev.stage, "warn3")
})

test("end-to-end hooks + MCP server flow: nudge, hard gate, handover, lock, read_handover", () => {
  const dir = makeTempDir()
  try {
    const dataDir = path.join(dir, "plugin-data")
    const artifactDir = path.join(dir, "artifacts")
    const transcriptPath = path.join(dir, "transcript.jsonl")
    const env = {
      ...process.env,
      PLUGIN_DATA: dataDir,
      AUTO_CONTEXT_HANDOVER_SOFT: "1000",
      AUTO_CONTEXT_HANDOVER_HARD: "2000",
    }

    const runHook = (event: string, payload: Record<string, unknown>) => {
      const res = spawnSync("node", [path.resolve("source/agy-hook.ts"), event], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env,
      })
      assert.equal(res.status, 0, res.stderr)
      return JSON.parse(res.stdout.trim()) as Record<string, unknown>
    }

    // 1. SessionStart
    const startOut = runHook("session-start", {
      conversationId: "conv-e2e",
      artifactDirectoryPath: artifactDir,
      workspacePaths: [dir],
      modelName: "auto",
    })
    assert.deepEqual(startOut, {})

    // 2. Transcript crosses soft (1200 >= 1000) -> PreInvocation injects nudge
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "PLANNER_RESPONSE", input_tokens: 1000, cache_read_tokens: 100, output_tokens: 100 }) + "\n",
    )
    const warnOut = runHook("pre-invocation", {
      conversationId: "conv-e2e",
      transcriptPath,
      artifactDirectoryPath: artifactDir,
      workspacePaths: [dir],
      modelName: "auto",
    })
    assert.ok(Array.isArray(warnOut.injectSteps))
    assert.equal(warnOut.injectSteps.length, 1)

    // Repeat at same stage -> no duplicate injection
    const warnRepeat = runHook("pre-invocation", {
      conversationId: "conv-e2e",
      transcriptPath,
      artifactDirectoryPath: artifactDir,
      workspacePaths: [dir],
      modelName: "auto",
    })
    assert.deepEqual(warnRepeat, {})

    // 3. Cross hard limit (2500 >= 2000) -> PreToolUse denies run_command, allows context_handover with sessionId overwrite
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "PLANNER_RESPONSE", input_tokens: 2000, cache_read_tokens: 400, output_tokens: 100 }) + "\n",
    )
    const denyCmd = runHook("pre-tool-use", {
      conversationId: "conv-e2e",
      transcriptPath,
      artifactDirectoryPath: artifactDir,
      workspacePaths: [dir],
      toolCall: { name: "run_command", args: { CommandLine: "ls" } },
    })
    assert.equal(denyCmd.decision, "deny")

    const allowHandover = runHook("pre-tool-use", {
      conversationId: "conv-e2e",
      transcriptPath,
      artifactDirectoryPath: artifactDir,
      workspacePaths: [dir],
      toolCall: {
        name: "mcp_auto-context-handover_context_handover",
        args: { handover: "full", summary: "short" },
      },
    })
    assert.equal(allowHandover.decision, "allow")
    assert.deepEqual(allowHandover.overwrite, { sessionId: "conv-e2e" })

    // 4. Call MCP server context_handover + read_handover
    const mcpInput = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "context_handover",
          arguments: {
            sessionId: "conv-e2e",
            handover: "Full verbatim handover body",
            summary: "Done step 1, next step 2",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "read_handover",
          arguments: { sessionID: "conv-e2e" },
        },
      }),
    ].join("\n") + "\n"

    const mcpRes = spawnSync("node", [path.resolve("source/agy-mcp.ts")], {
      input: mcpInput,
      encoding: "utf8",
      env,
    })
    assert.equal(mcpRes.status, 0, mcpRes.stderr)
    const responses = mcpRes.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: number; result?: { tools?: unknown[]; content?: Array<{ text: string }> } })

    assert.equal(responses.length, 4)
    assert.equal(responses[1]?.result?.tools?.length, 2)
    const handoverText = responses[2]?.result?.content?.[0]?.text ?? ""
    assert.ok(handoverText.includes(path.join(artifactDir, "handover.md")))
    assert.ok(handoverText.includes("Done step 1, next step 2"))

    const readText = responses[3]?.result?.content?.[0]?.text ?? ""
    assert.ok(readText.includes("Full verbatim handover body"))

    // 5. After handover, PreToolUse denies even context_handover
    const lockedDeny = runHook("pre-tool-use", {
      conversationId: "conv-e2e",
      transcriptPath,
      artifactDirectoryPath: artifactDir,
      workspacePaths: [dir],
      toolCall: { name: "context_handover", args: { handover: "x", summary: "y" } },
    })
    assert.equal(lockedDeny.decision, "deny")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
