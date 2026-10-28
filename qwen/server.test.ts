import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SEED_FRAMING } from "../source/shared/handover-text.ts";
import { CodexStore as QwenStore } from "../codex/store.ts";
import { handleHook } from "./hook.ts";
import { createServer, executeTool, listTools } from "./server.ts";
import { readInvocation, shortReply, successorPrompt, TOOL_NAMES } from "./text.ts";

function freshStore(): QwenStore {
  return new QwenStore(fs.mkdtempSync(path.join(os.tmpdir(), "qwen-server-")));
}

function freshProject(sessionId = "ses-parent", agentId = "agent-1a"): {
  transcriptPath: string;
  sessionId: string;
  agentId: string;
  key: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-srvproj-"));
  const transcriptPath = path.join(dir, "chats", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, "");
  return { transcriptPath, sessionId, agentId, key: `${sessionId}:${agentId}` };
}

function mint(
  store: QwenStore,
  proj: { transcriptPath: string; sessionId: string; agentId?: string },
  tool: string,
  toolInput: unknown,
): string {
  const out = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: proj.sessionId,
      transcript_path: proj.transcriptPath,
      ...(proj.agentId ? { agent_id: proj.agentId } : {}),
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id: "u",
    },
    store,
    {},
  );
  const specific = out.hookSpecificOutput as {
    permissionDecision: string;
    updatedInput: { capability: string };
  };
  assert.equal(specific.permissionDecision, "allow");
  return specific.updatedInput.capability;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return String(first.text);
}

describe("tools/list", () => {
  it("advertises handover+summary and childId+optional-full schemas with optional capability", () => {
    const tools = listTools();
    assert.equal(tools.length, 2);
    assert.equal(tools[0]?.name, "context_handover");
    assert.equal(tools[1]?.name, "read_handover");
    assert.deepEqual(tools[0]?.inputSchema.required, ["handover", "summary"]);
    assert.deepEqual(tools[1]?.inputSchema.required, ["childId"]);
    assert.ok("capability" in (tools[0]?.inputSchema.properties as object));
    assert.ok("capability" in (tools[1]?.inputSchema.properties as object));
  });

  it("serves over an in-memory MCP transport", async () => {
    const store = freshStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([createServer(store).connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 2);
    await client.close();
  });
});

describe("writer", () => {
  it("refuses unbound handover calls even with valid text", async () => {
    const store = freshStore();
    const result = await executeTool(
      TOOL_NAMES.handover,
      { handover: "full text", summary: "short" },
      store,
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /host-bound PreToolUse capability/);
    assert.match(textOf(result), /unbound calls are refused/);
  });

  it("stores a bound handover once and returns the exact short receipt", async () => {
    const store = freshStore();
    const proj = freshProject();
    const cap = mint(store, proj, TOOL_NAMES.handover, { handover: "body text", summary: "did things" });
    const result = await executeTool(TOOL_NAMES.handover, { capability: cap }, store);
    assert.equal(result.isError, undefined);
    const stored = store.getHandover(proj.key);
    assert.ok(stored);
    assert.equal(textOf(result), shortReply(stored));
    assert.equal(stored.parentSessionId, proj.sessionId);
    assert.equal(stored.handover, "body text");
    // Replay of the same capability fails; the first handover is immutable.
    const replay = await executeTool(TOOL_NAMES.handover, { capability: cap }, store);
    assert.equal(replay.isError, true);
    const againOut = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: proj.sessionId,
        transcript_path: proj.transcriptPath,
        agent_id: proj.agentId,
        tool_name: TOOL_NAMES.handover,
        tool_input: { handover: "other", summary: "other" },
        tool_use_id: "u2",
      },
      store,
      {},
    );
    assert.equal(
      (againOut.hookSpecificOutput as { permissionDecision: string }).permissionDecision,
      "deny",
    );
  });

  it("refuses root-bound handover calls", async () => {
    const store = freshStore();
    const proj = freshProject();
    const cap = mint(store, { transcriptPath: proj.transcriptPath, sessionId: proj.sessionId }, TOOL_NAMES.handover, {
      handover: "h",
      summary: "s",
    });
    const result = await executeTool(TOOL_NAMES.handover, { capability: cap }, store);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /root sessions cannot store/);
  });

  it("rejects cross-tool capabilities and unknown tools", async () => {
    const store = freshStore();
    const proj = freshProject();
    const readCap = mint(store, proj, TOOL_NAMES.read, { childId: proj.key, full: true });
    const crossed = await executeTool(TOOL_NAMES.handover, { capability: readCap }, store);
    assert.equal(crossed.isError, true);
    assert.match(textOf(crossed), /bound to "read_handover"/);
    assert.equal((await executeTool("nope", {}, store)).isError, true);
  });

  it("accepts the fully namespaced tool name", async () => {
    const store = freshStore();
    const proj = freshProject("ses-ns", "agent-ns");
    const cap = mint(store, proj, TOOL_NAMES.handover, { handover: "body", summary: "sum" });
    const result = await executeTool("mcp__auto_context_handover__context_handover", { capability: cap }, store);
    assert.equal(result.isError, undefined);
    assert.ok(store.getHandover(proj.key));
  });

  it("uses stored args, never model-supplied extras, on the capability path", async () => {
    const store = freshStore();
    const proj = freshProject("ses-x", "agent-x");
    const cap = mint(store, proj, TOOL_NAMES.handover, { handover: "stored body", summary: "stored sum" });
    const result = await executeTool(
      TOOL_NAMES.handover,
      { capability: cap, handover: "spoof", summary: "spoof" },
      store,
    );
    assert.equal(result.isError, undefined);
    assert.equal(store.getHandover(proj.key)?.handover, "stored body");
  });
});

describe("reader", () => {
  async function stored(store: QwenStore, key: string) {
    const proj = { sessionId: key.split(":")[0] ?? "s", agentId: key.split(":")[1] ?? "a" };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-readproj-"));
    const transcriptPath = path.join(dir, "chats", `${proj.sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "");
    const cap = mint(
      store,
      { transcriptPath, sessionId: proj.sessionId, agentId: proj.agentId },
      TOOL_NAMES.handover,
      {
        handover: "# Title\n\n## Prioritized next steps\n\n- do the thing\n",
        summary: "did things",
      },
    );
    const result = await executeTool(TOOL_NAMES.handover, { capability: cap }, store);
    assert.equal(result.isError, undefined);
    return { cap, transcriptPath, ...proj };
  }

  function readCap(
    store: QwenStore,
    proj: { transcriptPath: string; sessionId: string; agentId?: string },
    toolInput: unknown,
  ): string {
    return mint(store, proj, TOOL_NAMES.read, toolInput);
  }

  it("reads compact and full views through a bound capability", async () => {
    const store = freshStore();
    const { transcriptPath, sessionId } = await stored(store, "ses-r:agent-r");
    const root = { transcriptPath, sessionId };
    const compactCap = readCap(store, root, { childId: "ses-r:agent-r" });
    const compact = await executeTool(TOOL_NAMES.read, { capability: compactCap }, store);
    assert.equal(compact.isError, undefined);
    const text = textOf(compact);
    assert.match(text, /Handover summary for child "ses-r:agent-r"/);
    assert.match(text, /do the thing/);
    assert.match(text, new RegExp(successorPrompt("ses-r:agent-r").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40)));
    const fullCap = readCap(store, root, { childId: "ses-r:agent-r", full: true });
    const full = await executeTool(TOOL_NAMES.read, { capability: fullCap }, store);
    assert.equal(full.isError, undefined);
    assert.ok(textOf(full).includes("# Title"));
    assert.ok(textOf(full).includes(SEED_FRAMING));
  });

  it("refuses unbound reader calls, including direct childId reads", async () => {
    const store = freshStore();
    await stored(store, "ses-r:agent-r");
    for (const args of [{ childId: "ses-r:agent-r" }, { childId: "ses-r:agent-r", full: true }]) {
      const result = await executeTool(TOOL_NAMES.read, args, store);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /host-bound PreToolUse capability/);
    }
    // Empty capability and unknown fields are also refused before any lookup.
    assert.equal((await executeTool(TOOL_NAMES.read, { capability: "" }, store)).isError, true);
    assert.equal((await executeTool(TOOL_NAMES.read, { capability: "not-hex" }, store)).isError, true);
  });

  it("denies bound reads from locked callers and refuses unbound reads", async () => {
    const store = freshStore();
    const { transcriptPath, sessionId, agentId } = await stored(store, "ses-r:agent-r");
    // The stored handover locks its own child: the hook denies even reader binding.
    const deniedHook = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: transcriptPath,
        agent_id: agentId,
        tool_name: TOOL_NAMES.read,
        tool_input: { childId: "ses-r:agent-r" },
        tool_use_id: "u",
      },
      store,
      {},
    );
    assert.equal(
      (deniedHook.hookSpecificOutput as { permissionDecision: string }).permissionDecision,
      "deny",
    );
    // Unbound direct reads are refused, not served openly.
    const direct = await executeTool(TOOL_NAMES.read, { childId: "ses-r:agent-r" }, store);
    assert.equal(direct.isError, true);
    assert.match(textOf(direct), /host-bound PreToolUse capability/);
  });

  it("reports missing handovers over a bound capability and rejects bad input", async () => {
    const store = freshStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-missproj-"));
    const transcriptPath = path.join(dir, "chats", "ses-m.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "");
    const proj = { transcriptPath, sessionId: "ses-m", agentId: "agent-m" };
    const missingCap = readCap(store, proj, { childId: "nope" });
    const missing = await executeTool(TOOL_NAMES.read, { capability: missingCap }, store);
    assert.equal(missing.isError, undefined);
    assert.match(textOf(missing), /No stored handover for child "nope"/);
    assert.match(textOf(missing), /reason=unknown/);
    // Model-supplied fields beside the capability are ignored; stored args govern.
    // Bad stored args fail: empty childId and wrong full type.
    const badChild = readCap(store, proj, { childId: "" });
    assert.equal((await executeTool(TOOL_NAMES.read, { capability: badChild }, store)).isError, true);
    const badFull = readCap(store, proj, { childId: "x", full: "yes" });
    assert.equal((await executeTool(TOOL_NAMES.read, { capability: badFull }, store)).isError, true);
    const badExtra = readCap(store, proj, { childId: "x", extra: 1 });
    assert.equal((await executeTool(TOOL_NAMES.read, { capability: badExtra }, store)).isError, true);
  });

  it("reads via the fully namespaced tool name with a bound capability", async () => {
    const store = freshStore();
    const { transcriptPath, sessionId } = await stored(store, "ses-r:agent-r");
    const cap = readCap(store, { transcriptPath, sessionId }, { childId: "ses-r:agent-r" });
    const result = await executeTool("mcp__auto_context_handover__read_handover", { capability: cap }, store);
    assert.equal(result.isError, undefined);
    assert.ok(textOf(result).includes(readInvocation("ses-r:agent-r", true).slice(0, 20)));
  });

  it("reports unknown soft headers for invalid-config handovers, never a default", async () => {
    const store = freshStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-softproj-"));
    const transcriptPath = path.join(dir, "chats", "ses-i.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "");
    const child = { transcriptPath, sessionId: "ses-i", agentId: "agent-i" };
    const root = { transcriptPath, sessionId: "ses-i" };
    const hookOut = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: child.sessionId,
        transcript_path: child.transcriptPath,
        agent_id: child.agentId,
        tool_name: TOOL_NAMES.handover,
        tool_input: { handover: "body text", summary: "did things" },
        tool_use_id: "u9",
      },
      store,
      { AUTO_CONTEXT_HANDOVER_SOFT: "bogus" },
    );
    const wcap = (hookOut.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    const stored2 = await executeTool(TOOL_NAMES.handover, { capability: wcap }, store);
    assert.equal(stored2.isError, undefined);
    const rcap = readCap(store, root, { childId: "ses-i:agent-i" });
    const compact = await executeTool(TOOL_NAMES.read, { capability: rcap }, store);
    assert.equal(compact.isError, undefined);
    const text = textOf(compact);
    assert.match(text, /soft-limit=unknown/);
    assert.ok(!text.includes("against soft limit 150000"), "must not invent the default soft");
    const fcap = readCap(store, root, { childId: "ses-i:agent-i", full: true });
    const full = await executeTool(TOOL_NAMES.read, { capability: fcap }, store);
    assert.equal(full.isError, undefined);
    assert.match(textOf(full), /soft-limit=unknown/);
  });
});
