import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SEED_FRAMING } from "../source/shared/handover-text.ts";
import { handleHook } from "./hook.ts";
import { createServer, executeTool, listTools } from "./server.ts";
import { CodexStore } from "./store.ts";
import { readInvocation, shortReply, successorPrompt, TOOL_NAMES } from "./text.ts";

function freshBase(): string {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  return fs.mkdtempSync(path.join("/tmp/opencode", "codex-server-"));
}

function freshStore(): CodexStore {
  return new CodexStore(freshBase());
}

function mint(
  store: CodexStore,
  tool: string,
  childId: string,
  toolInput: unknown,
): string {
  const out = handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "ses-parent",
      turn_id: "t",
      agent_id: childId,
      agent_type: "explore",
      model: "openai/gpt-5",
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
  it("advertises handover+summary and childId+optional-full schemas", () => {
    const tools = listTools();
    assert.equal(tools.length, 2);
    const handover = tools.find((tool) => tool.name === "context_handover");
    const read = tools.find((tool) => tool.name === "read_handover");
    assert.ok(handover && read);
    assert.deepEqual(
      (handover.inputSchema as { required: string[] }).required,
      ["handover", "summary"],
    );
    assert.deepEqual((read.inputSchema as { required: string[] }).required, ["childId"]);
    assert.ok(handover.description && handover.description.includes("Original instructions"));
    assert.ok(read.description && read.description.includes("childId"));
  });

  it("lists tools over an SDK transport without a model", async () => {
    const store = freshStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(store);
    await server.connect(serverTransport);
    try {
      const client = new Client({ name: "probe", version: "0.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        const listed = await client.listTools();
        assert.equal(listed.tools.length, 2);
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
  });

  it("rejects unbound calls over an SDK transport with no storage access", async () => {
    const base = freshBase();
    const store = new CodexStore(base);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(store);
    await server.connect(serverTransport);
    try {
      const client = new Client({ name: "probe", version: "0.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        for (const args of [{}, { capability: "a".repeat(64) }, { capability: "short" }]) {
          const result = await client.callTool({ name: "context_handover", arguments: args });
          assert.equal(result.isError, true);
          assert.match(textOf(result as never), /codex server/);
        }
        const read = await client.callTool({
          name: "read_handover",
          arguments: { capability: "b".repeat(64) },
        });
        assert.equal(read.isError, true);
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
    assert.deepEqual(fs.readdirSync(base), []);
  });
});

describe("handover storage", () => {
  it("stores from caller host ids and returns the exact short reply", async () => {
    const store = freshStore();
    const capability = mint(store, TOOL_NAMES.handover, "kid", { handover: "body text", summary: "did things" });
    const result = await executeTool("context_handover", { capability }, store);
    assert.equal(result.isError, undefined);
    const stored = store.getHandover("kid");
    assert.ok(stored);
    assert.equal(stored.parentSessionId, "ses-parent");
    assert.equal(stored.agentType, "explore");
    assert.equal(stored.model, "openai/gpt-5");
    assert.equal(stored.handover, "body text");
    assert.equal(stored.closed, true);
    assert.equal(textOf(result as never), shortReply(stored));
  });

  it("accepts the fully namespaced tool name", async () => {
    const store = freshStore();
    const capability = mint(store, TOOL_NAMES.handover, "kid", { handover: "h", summary: "s" });
    const result = await executeTool(TOOL_NAMES.handover, { capability }, store);
    assert.equal(result.isError, undefined);
    assert.equal(store.getHandover("kid")?.handover, "h");
  });

  it("rejects model caller and capability injection in original args", async () => {
    for (const toolInput of [
      { handover: "h", summary: "s", capability: "evil" },
      { handover: "h", summary: "s", caller: { childId: "spoof" } },
      { handover: "h", summary: "s", childId: "spoof" },
      { handover: "h", summary: "s", model: "other" },
    ]) {
      const store = freshStore();
      const token = store.createPending({
        tool: "context_handover",
        caller: { sessionId: "ses-parent", childId: "kid" },
        args: toolInput,
        diagnostics: { reason: "not-nudged", soft: 150000 },
      });
      const result = await executeTool("context_handover", { capability: token }, store);
      assert.equal(result.isError, true, JSON.stringify(toolInput));
      assert.match(textOf(result as never), /unknown field/);
      assert.equal(store.getHandover("kid"), undefined);
    }
  });

  it("rejects root handover callers with nothing stored", async () => {
    const store = freshStore();
    const token = store.createPending({
      tool: "context_handover",
      caller: { sessionId: "ses-parent" },
      args: { handover: "h", summary: "s" },
      diagnostics: { reason: "not-nudged", soft: 150000 },
    });
    const result = await executeTool("context_handover", { capability: token }, store);
    assert.equal(result.isError, true);
    assert.match(textOf(result as never), /root sessions cannot store/);
    assert.equal(fs.existsSync(path.join(store.baseDir, "handovers")), false);
  });

  it("denies closed callers without touching storage", async () => {
    const store = freshStore();
    const first = mint(store, TOOL_NAMES.handover, "kid", { handover: "h", summary: "s" });
    assert.equal((await executeTool("context_handover", { capability: first }, store)).isError, undefined);
    const before = fs.readdirSync(path.join(store.baseDir, "handovers"));

    const again = store.createPending({
      tool: "context_handover",
      caller: { sessionId: "ses-parent", childId: "kid" },
      args: { handover: "second", summary: "s2" },
      diagnostics: { reason: "not-nudged", soft: 150000 },
    });
    const second = await executeTool("context_handover", { capability: again }, store);
    assert.equal(second.isError, true);
    assert.match(textOf(second as never), /locked after a context handover/);
    assert.ok(textOf(second as never).includes(readInvocation("kid", true)));
    assert.equal(store.getHandover("kid")?.handover, "h");
    assert.deepEqual(fs.readdirSync(path.join(store.baseDir, "handovers")), before);

    const reader = store.createPending({
      tool: "read_handover",
      caller: { sessionId: "ses-parent", childId: "kid" },
      args: { childId: "kid" },
      diagnostics: { reason: "not-nudged", soft: 150000 },
    });
    const denied = await executeTool("read_handover", { capability: reader }, store);
    assert.equal(denied.isError, true);
    assert.match(textOf(denied as never), /locked after a context handover/);
  });

  it("rejects cross-tool capability reuse", async () => {
    const store = freshStore();
    const handoverCap = mint(store, TOOL_NAMES.handover, "kid", { handover: "h", summary: "s" });
    const crossRead = await executeTool("read_handover", { capability: handoverCap }, store);
    assert.equal(crossRead.isError, true);
    assert.match(textOf(crossRead as never), /cannot invoke/);

    const storeB = freshStore();
    const readCap = mint(storeB, TOOL_NAMES.read, "kid", { childId: "kid" });
    const crossWrite = await executeTool("context_handover", { capability: readCap }, storeB);
    assert.equal(crossWrite.isError, true);
    assert.equal(storeB.getHandover("kid"), undefined);
  });

  it("rejects replayed capabilities", async () => {
    const store = freshStore();
    const capability = mint(store, TOOL_NAMES.handover, "kid", { handover: "h", summary: "s" });
    assert.equal((await executeTool("context_handover", { capability }, store)).isError, undefined);
    const replay = await executeTool("context_handover", { capability }, store);
    assert.equal(replay.isError, true);
    assert.match(textOf(replay as never), /not found or already consumed/);
  });

  it("rejects malformed runtime and original args without claiming storage", async () => {
    const store = freshStore();
    for (const args of [{}, { capability: "short" }, { capability: "a".repeat(64), extra: 1 }, "nope", 42]) {
      const result = await executeTool("context_handover", args, store);
      assert.equal(result.isError, true);
    }
    const unknown = await executeTool("nope", { capability: "a".repeat(64) }, store);
    assert.equal(unknown.isError, true);
    assert.equal(fs.existsSync(path.join(store.baseDir, "handovers")), false);

    for (const toolInput of [{ handover: "", summary: "s" }, { handover: "h" }, { handover: 42, summary: "s" }]) {
      const local = freshStore();
      const token = local.createPending({
        tool: "context_handover",
        caller: { sessionId: "s", childId: "k" },
        args: toolInput,
        diagnostics: { reason: "not-nudged", soft: 1 },
      });
      const result = await executeTool("context_handover", { capability: token }, local);
      assert.equal(result.isError, true, JSON.stringify(toolInput));
      assert.equal(local.getHandover("k"), undefined);
    }
  });

  it("requires soft in diagnostics and reports persistence errors without claiming handover", async () => {
    const store = freshStore();
    const noSoft = store.createPending({
      tool: "context_handover",
      caller: { sessionId: "s", childId: "k" },
      args: { handover: "h", summary: "s" },
      diagnostics: { reason: "nudged" },
    });
    const softResult = await executeTool("context_handover", { capability: noSoft }, store);
    assert.equal(softResult.isError, true);
    assert.match(textOf(softResult as never), /soft limit/);
    assert.equal(store.getHandover("k"), undefined);

    const brokenBase = freshBase();
    fs.writeFileSync(path.join(brokenBase, "handovers"), "blocker");
    const broken = new CodexStore(brokenBase);
    const token = broken.createPending({
      tool: "context_handover",
      caller: { sessionId: "s", childId: "k" },
      args: { handover: "h", summary: "s" },
      diagnostics: { reason: "not-nudged", soft: 1 },
    });
    const result = await executeTool("context_handover", { capability: token }, broken);
    assert.equal(result.isError, true);
    assert.equal(textOf(result as never).includes("Context handover (incomplete):"), false);
  });
});

describe("read_handover", () => {
  async function withHandover(): Promise<{ store: CodexStore; childId: string }> {
    const store = freshStore();
    const capability = mint(store, TOOL_NAMES.handover, "kid", {
      handover: "Original task pointer.\n\nPrioritized next steps:\n- do the second thing\n- then the third",
      summary: "Did the first thing\nmore detail",
    });
    const result = await executeTool("context_handover", { capability }, store);
    assert.equal(result.isError, undefined);
    return { store, childId: "kid" };
  }

  it("lets any live bound caller read any child id in compact and full modes", async () => {
    const { store, childId } = await withHandover();
    for (const full of [undefined, false]) {
      const token = mint(store, TOOL_NAMES.read, "other", { childId, ...(full === undefined ? {} : { full }) });
      const result = await executeTool("read_handover", { capability: token }, store);
      assert.equal(result.isError, undefined);
      const text = textOf(result as never);
      assert.ok(text.includes(JSON.stringify(childId)));
      assert.ok(text.includes("Diagnostics: reason="));
      assert.ok(text.includes("Pending user decisions: unknown"));
      assert.ok(text.includes("Next steps excerpt:"));
      assert.ok(text.includes(successorPrompt(childId)));
      assert.ok(text.includes("second thing"));
    }
    const fullToken = mint(store, TOOL_NAMES.read, "other", { childId, full: true });
    const full = await executeTool("read_handover", { capability: fullToken }, store);
    assert.equal(full.isError, undefined);
    const fullText = textOf(full as never);
    const record = store.getHandover(childId);
    assert.ok(record);
    assert.ok(fullText.includes(record.handover));
    assert.equal(fullText.split(record.handover).length - 1, 1);
    assert.equal(fullText.split(SEED_FRAMING).length - 1, 1);
    assert.ok(fullText.includes("Provenance: parent session"));
    assert.ok(fullText.includes("Diagnostics: reason="));
  });

  it("lets a root-bound caller read with a compact parent default", async () => {
    const { store, childId } = await withHandover();
    const out = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "ses-parent",
        turn_id: "t",
        tool_name: TOOL_NAMES.read,
        tool_input: { childId },
        tool_use_id: "u",
      },
      store,
      {},
    );
    const token = (out.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    const pending = store.consumePending(token);
    assert.deepEqual(pending.caller, { sessionId: "ses-parent" });
    const again = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "ses-parent",
        turn_id: "t",
        tool_name: TOOL_NAMES.read,
        tool_input: { childId },
        tool_use_id: "u2",
      },
      store,
      {},
    );
    const cap = (again.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    const result = await executeTool("read_handover", { capability: cap }, store);
    assert.equal(result.isError, undefined);
    assert.ok(textOf(result as never).includes(successorPrompt(childId)));
  });

  it("refuses root handover storage for a hook-minted root capability", async () => {
    const store = freshStore();
    const out = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "ses-parent",
        turn_id: "t",
        tool_name: TOOL_NAMES.handover,
        tool_input: { handover: "h", summary: "s" },
        tool_use_id: "u",
      },
      store,
      {},
    );
    const token = (out.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    const result = await executeTool("context_handover", { capability: token }, store);
    assert.equal(result.isError, true);
    assert.match(textOf(result as never), /root sessions cannot store/);
    assert.equal(fs.existsSync(path.join(store.baseDir, "handovers")), false);
  });

  it("returns missing diagnostics and unknowns with no successor default", async () => {
    const store = freshStore();
    const token = mint(store, TOOL_NAMES.read, "live", { childId: "ghost" });
    const result = await executeTool("read_handover", { capability: token }, store);
    assert.equal(result.isError, undefined);
    const text = textOf(result as never);
    assert.ok(text.includes("No stored handover"));
    assert.ok(text.includes("reason=unknown"));
    assert.ok(text.includes("Provenance: unknown"));
    assert.equal(text.includes("Successor default"), false);
  });

  it("treats arbitrary mentions as unknown with a full-read hint", async () => {
    for (const handover of [
      "Intro line\nSee Prioritized next steps below for details\nMore text",
      "Prioritized next steps were already reviewed.\n- foo",
    ]) {
      const store = freshStore();
      const cap = mint(store, TOOL_NAMES.handover, "kid", { handover, summary: "s" });
      assert.equal((await executeTool("context_handover", { capability: cap }, store)).isError, undefined);
      const token = mint(store, TOOL_NAMES.read, "other", { childId: "kid" });
      const result = await executeTool("read_handover", { capability: token }, store);
      assert.equal(result.isError, undefined);
      const text = textOf(result as never);
      assert.ok(text.includes("Next steps excerpt: unknown"), handover);
      assert.ok(text.includes(readInvocation("kid", true)), handover);
    }
  });

  it("matches an ATX-numbered title and stops at the next heading", async () => {
    const store = freshStore();
    const handover = "Intro\n\n## 7. Prioritized next steps\n- do A\n- do B\n\n## Next section\nshould not appear";
    const cap = mint(store, TOOL_NAMES.handover, "kid", { handover, summary: "s" });
    assert.equal((await executeTool("context_handover", { capability: cap }, store)).isError, undefined);
    const token = mint(store, TOOL_NAMES.read, "other", { childId: "kid" });
    const text = textOf((await executeTool("read_handover", { capability: token }, store)) as never);
    assert.ok(text.includes("do A"));
    assert.ok(text.includes("do B"));
    assert.equal(text.includes("should not appear"), false);
  });

  it("matches a bold title", async () => {
    const store = freshStore();
    const handover = "**Prioritized next steps:**\n- bold step";
    const cap = mint(store, TOOL_NAMES.handover, "kid", { handover, summary: "s" });
    assert.equal((await executeTool("context_handover", { capability: cap }, store)).isError, undefined);
    const token = mint(store, TOOL_NAMES.read, "other", { childId: "kid" });
    const text = textOf((await executeTool("read_handover", { capability: token }, store)) as never);
    assert.ok(text.includes("bold step"));
  });

  it("truncates excerpts over 600 chars but preserves the full body", async () => {
    const store = freshStore();
    const long = "x".repeat(700);
    const handover = `Intro\n\nPrioritized next steps:\n${long}`;
    const cap = mint(store, TOOL_NAMES.handover, "kid", { handover, summary: "s" });
    assert.equal((await executeTool("context_handover", { capability: cap }, store)).isError, undefined);
    const token = mint(store, TOOL_NAMES.read, "other", { childId: "kid" });
    const compact = textOf((await executeTool("read_handover", { capability: token }, store)) as never);
    const excerptLine = compact.split("\n").find((line) => line.startsWith("Next steps excerpt:"));
    assert.ok(excerptLine);
    const excerpt = excerptLine.slice("Next steps excerpt:".length).trim();
    assert.ok(excerpt.endsWith("..."));
    assert.ok(excerpt.length <= 603);
    assert.equal(compact.includes(long), false);
    const fullToken = mint(store, TOOL_NAMES.read, "other", { childId: "kid", full: true });
    const full = textOf((await executeTool("read_handover", { capability: fullToken }, store)) as never);
    assert.ok(full.includes(long));
  });

  it("warns only above 50% of soft using the verbatim payload estimate", async () => {
    const body = "seed boundary body text";
    const payloadChars = `${body}\n\n${SEED_FRAMING}`.length;
    const estimate = Math.ceil(payloadChars / 4);
    async function compactForSoft(soft: number): Promise<string> {
      const store = freshStore();
      const cap = store.createPending({
        tool: "context_handover",
        caller: { sessionId: "s", childId: "kid" },
        args: { handover: body, summary: "s" },
        diagnostics: { reason: "not-nudged", soft },
      });
      assert.equal((await executeTool("context_handover", { capability: cap }, store)).isError, undefined);
      const token = store.createPending({
        tool: "read_handover",
        caller: { sessionId: "s", childId: "other" },
        args: { childId: "kid" },
        diagnostics: { reason: "not-nudged", soft },
      });
      const result = await executeTool("read_handover", { capability: token }, store);
      assert.equal(result.isError, undefined);
      return textOf(result as never);
    }
    const atHalf = await compactForSoft(estimate * 2);
    assert.ok(atHalf.includes(`about ${estimate} tokens`), "at 50% reports estimate");
    assert.equal(atHalf.includes("Seed size warning"), false);
    const overHalf = await compactForSoft(estimate * 2 - 1);
    assert.ok(overHalf.includes("Seed size warning"));
    assert.ok(overHalf.includes(`about ${estimate} tokens`));
    assert.ok(overHalf.includes("compress carried finished notes at the next handover"));

    const generous = freshStore();
    const sixHundred = "y".repeat(600);
    const cap = generous.createPending({
      tool: "context_handover",
      caller: { sessionId: "s", childId: "kid" },
      args: { handover: sixHundred, summary: "s" },
      diagnostics: { reason: "not-nudged", soft: 150000 },
    });
    assert.equal((await executeTool("context_handover", { capability: cap }, generous)).isError, undefined);
    const token = generous.createPending({
      tool: "read_handover",
      caller: { sessionId: "s", childId: "other" },
      args: { childId: "kid" },
      diagnostics: { reason: "not-nudged", soft: 150000 },
    });
    const text = textOf((await executeTool("read_handover", { capability: token }, generous)) as never);
    assert.equal(text.includes("Seed size warning"), false);
    const expectedPayload = `${sixHundred}\n\n${SEED_FRAMING}`.length;
    const expectedEstimate = Math.ceil(expectedPayload / 4);
    assert.ok(text.includes(`about ${expectedEstimate} tokens`));
  });

  it("rejects strict violations in read args", async () => {
    for (const toolInput of [{}, { childId: "" }, { childId: "k", full: "yes" }, { childId: "k", caller: "x" }]) {
      const store = freshStore();
      const token = store.createPending({
        tool: "read_handover",
        caller: { sessionId: "s", childId: "live" },
        args: toolInput,
        diagnostics: { reason: "not-nudged", soft: 1 },
      });
      const result = await executeTool("read_handover", { capability: token }, store);
      assert.equal(result.isError, true, JSON.stringify(toolInput));
    }
  });
});
