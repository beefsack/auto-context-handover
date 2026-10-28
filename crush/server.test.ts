import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HANDOVER_SECTIONS, SEED_FRAMING } from "../source/shared/handover-text.ts";
import type { CrushApi } from "./client.ts";
import { handleHook } from "./hook.ts";
import { createServer, executeTool, listTools } from "./server.ts";
import { CrushStore } from "./store.ts";
import { readInvocation, TOOL_NAMES } from "./text.ts";

function freshBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crush-server-"));
}

function freshStore(): CrushStore {
  return new CrushStore(freshBase());
}

interface FakeApi extends CrushApi {
  readonly created: Array<{ workspaceId: string; title: string }>;
  readonly admitted: Array<{ workspaceId: string; sessionId: string; prompt: string }>;
  failCreate?: string;
  failAdmit?: string;
  nextId: string;
}

function fakeApi(store: CrushStore, sourceId: string): FakeApi {
  return {
    created: [],
    admitted: [],
    nextId: "ses-new-1",
    failCreate: undefined,
    failAdmit: undefined,
    getVersion: async () => ({ version: "v0.98.2" }),
    listWorkspaces: async () => [{ id: "ws-1", path: "unused" }],
    getSession: async () => ({ id: sourceId, parent_session_id: "", prompt_tokens: 10, completion_tokens: 5 }),
    getAgent: async () => ({ model: { id: "m", context_window: 200000 }, model_cfg: { provider: "p", model: "m" } }),
    createSession: async function (workspaceId: string, title: string) {
      if (this.failCreate) throw new Error(this.failCreate);
      this.created.push({ workspaceId, title });
      return { id: this.nextId };
    },
    sendAgentPrompt: async function (workspaceId: string, sessionId: string, prompt: string) {
      const status = store.getStatus(sourceId);
      assert.equal(status?.successorId, sessionId, "successor id persisted before admission");
      if (this.failAdmit) throw new Error(this.failAdmit);
      this.admitted.push({ workspaceId, sessionId, prompt });
    },
  };
}

function hookApi(dir: string): CrushApi {
  return {
    getVersion: async () => ({ version: "v0.98.2" }),
    listWorkspaces: async () => [{ id: "ws-1", path: dir }],
    getSession: async () => ({ id: "ses-1", parent_session_id: "", prompt_tokens: 10, completion_tokens: 5 }),
    getAgent: async () => ({ model: { id: "m", context_window: 200000 }, model_cfg: { provider: "p", model: "m" } }),
    createSession: async () => {
      throw new Error("mint path must never create sessions");
    },
    sendAgentPrompt: async () => {
      throw new Error("mint path must never admit prompts");
    },
  };
}

async function mint(store: CrushStore, tool: string, toolInput: unknown, sessionId = "ses-1"): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crush-ws-"));
  const out = await handleHook(
    { event: "PreToolUse", session_id: sessionId, cwd: dir, tool_name: tool, tool_input: toolInput },
    store,
    hookApi(dir),
    {},
  );
  const specific = out as { updated_input?: { capability: string }; updatedInput?: unknown };
  assert.equal(specific.updatedInput, undefined, "Crush envelope uses snake_case updated_input");
  assert.ok(specific.updated_input, `expected a capability for ${tool}`);
  return specific.updated_input.capability;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return String(first.text);
}

describe("tools/list", () => {
  it("advertises handover+summary and sessionID schemas", () => {
    const tools = listTools();
    assert.equal(tools.length, 2);
    const handover = tools.find((tool) => tool.name === "context_handover");
    const read = tools.find((tool) => tool.name === "read_handover");
    assert.ok(handover && read);
    assert.deepEqual((handover.inputSchema as { required: string[] }).required, ["handover", "summary"]);
    assert.deepEqual((read.inputSchema as { required: string[] }).required, ["sessionID"]);
    assert.ok(handover.description && handover.description.includes("VERBATIM"));
    assert.ok(handover.description && handover.description.includes(HANDOVER_SECTIONS), "shared six-section text verbatim");
    assert.ok(handover.description && handover.description.includes("source root session, workspace, and effective model only"), "Crush-root provenance scope");
    assert.ok(handover.description && handover.description.includes("do not invent them"), "no invented provenance");
    assert.ok(handover.description && handover.description.includes("no parent workflow"), "no parent workflow");
    assert.ok(read.description && read.description.includes("sessionID"));
  });

  it("lists tools over an SDK transport without a model", async () => {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(store, api);
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
    const store = new CrushStore(base);
    const api = fakeApi(store, "ses-1");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(store, api);
    await server.connect(serverTransport);
    try {
      const client = new Client({ name: "probe", version: "0.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        const cases: unknown[] = [{}, { capability: "a".repeat(64) }, { capability: "short" }, { capability: "a".repeat(64), handover: "x" }];
        for (const args of cases) {
          const result = await client.callTool({ name: "context_handover", arguments: args as Record<string, unknown> });
          assert.equal(result.isError, true);
          assert.match(textOf(result as never), /crush server/);
        }
        const read = await client.callTool({ name: "read_handover", arguments: { capability: "b".repeat(64) } });
        assert.equal(read.isError, true);
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
    assert.deepEqual(fs.readdirSync(base), []);
    assert.deepEqual(api.created, []);
    assert.deepEqual(api.admitted, []);
  });
});

describe("handover storage and rollover", () => {
  it("runs the normal sequence in the same workspace with the seed exactly once", async () => {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    const capability = await mint(store, TOOL_NAMES.handover, { handover: "body text", summary: "Did the first thing" });
    const result = await executeTool("context_handover", { capability, handover: "ignored", summary: "ignored" }, store, api);
    assert.equal(result.isError, undefined);
    const text = textOf(result as never);
    assert.ok(text.includes("ses-new-1"), text);
    assert.ok(text.includes("closed"), text);
    const stored = store.getHandover("ses-1");
    assert.ok(stored);
    assert.equal(stored.handover, "body text");
    assert.equal(stored.summary, "Did the first thing");
    assert.equal(stored.workspaceId, "ws-1");
    assert.equal(stored.model, "p/m");
    assert.equal(stored.closed, true);
    assert.deepEqual(api.created, [{ workspaceId: "ws-1", title: "Did the first thing" }]);
    assert.equal(api.admitted.length, 1);
    const seed = api.admitted[0]!;
    assert.equal(seed.workspaceId, "ws-1");
    assert.equal(seed.sessionId, "ses-new-1");
    assert.equal(seed.prompt.split("body text").length - 1, 1, "full handover submitted once");
    assert.equal(seed.prompt.split(SEED_FRAMING).length - 1, 1, "reference framing present once");
    assert.ok(seed.prompt.includes(readInvocation("ses-1")), "source backlink");
    assert.ok(seed.prompt.includes("Did the first thing"), "title-based");
    assert.deepEqual(store.getStatus("ses-1"), { successorId: "ses-new-1", admitted: true });
  });

  it("accepts the fully namespaced tool name", async () => {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    const capability = await mint(store, TOOL_NAMES.handover, { handover: "h", summary: "s" });
    const result = await executeTool(TOOL_NAMES.handover, { capability }, store, api);
    assert.equal(result.isError, undefined);
    assert.equal(store.getHandover("ses-1")?.handover, "h");
  });

  it("rejects model caller and capability injection in stored args", async () => {
    const badInputs: unknown[] = [
      { handover: "h", summary: "s", capability: "evil" },
      { handover: "h", summary: "s", caller: { sessionId: "spoof" } },
      { handover: "h", summary: "s", sessionID: "spoof" },
      { handover: "h", summary: "s", model: "other" },
    ];
    for (const toolInput of badInputs) {
      const store = freshStore();
      const api = fakeApi(store, "ses-1");
      const token = store.createPending({
        tool: "context_handover",
        caller: { sessionId: "ses-1", workspaceId: "ws-1" },
        args: toolInput,
        diagnostics: { reason: "not-nudged", soft: 150000 },
      });
      const result = await executeTool("context_handover", { capability: token }, store, api);
      assert.equal(result.isError, true, JSON.stringify(toolInput));
      assert.match(textOf(result as never), /unknown field/);
      assert.equal(store.getHandover("ses-1"), undefined);
      assert.deepEqual(api.created, []);
    }
  });

  it("rejects handover bindings without a workspace", async () => {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    const token = store.createPending({
      tool: "context_handover",
      caller: { sessionId: "ses-1" },
      args: { handover: "h", summary: "s" },
      diagnostics: { reason: "not-nudged", soft: 150000 },
    });
    const result = await executeTool("context_handover", { capability: token }, store, api);
    assert.equal(result.isError, true);
    assert.match(textOf(result as never), /workspace/);
    assert.equal(store.getHandover("ses-1"), undefined);
  });

  it("denies closed callers with the successor named and storage untouched", async () => {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    const first = await mint(store, TOOL_NAMES.handover, { handover: "h", summary: "s" });
    assert.equal((await executeTool("context_handover", { capability: first }, store, api)).isError, undefined);
    const before = fs.readdirSync(path.join(store.baseDir, "handovers"));

    const again = store.createPending({
      tool: "context_handover",
      caller: { sessionId: "ses-1", workspaceId: "ws-1" },
      args: { handover: "second", summary: "s2" },
      diagnostics: { reason: "unknown", soft: 150000 },
    });
    const second = await executeTool("context_handover", { capability: again }, store, api);
    assert.equal(second.isError, true);
    assert.match(textOf(second as never), /locked after a context handover/);
    assert.ok(textOf(second as never).includes("ses-new-1"), "successor named");
    assert.ok(textOf(second as never).includes("fresh live root"), "locked hint");
    assert.equal(store.getHandover("ses-1")?.handover, "h");
    assert.deepEqual(fs.readdirSync(path.join(store.baseDir, "handovers")), before);
    assert.equal(api.created.length, 1, "no second rollover attempt");

    const reader = store.createPending({
      tool: "read_handover",
      caller: { sessionId: "ses-1", workspaceId: "ws-1" },
      args: { sessionID: "ses-1" },
      diagnostics: { reason: "unknown", soft: 150000 },
    });
    const denied = await executeTool("read_handover", { capability: reader }, store, api);
    assert.equal(denied.isError, true);
    assert.match(textOf(denied as never), /locked after a context handover/);
  });

  it("rejects cross-tool reuse and replays", async () => {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    const handoverCap = await mint(store, TOOL_NAMES.handover, { handover: "h", summary: "s" });
    assert.match(textOf((await executeTool("read_handover", { capability: handoverCap }, store, api)) as never), /cannot invoke/);

    const storeB = freshStore();
    const apiB = fakeApi(storeB, "ses-1");
    const readCap = await mint(storeB, TOOL_NAMES.read, { sessionID: "ses-1" });
    assert.equal((await executeTool("context_handover", { capability: readCap }, storeB, apiB)).isError, true);
    assert.equal(storeB.getHandover("ses-1"), undefined);

    const replay = await executeTool("context_handover", { capability: handoverCap }, store, api);
    assert.equal(replay.isError, true);
    assert.match(textOf(replay as never), /not found or already consumed/);
  });

  it("rejects malformed runtime and stored args without claiming storage", async () => {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    const badRuntime: unknown[] = [{}, { capability: "short" }, "nope", 42];
    for (const args of badRuntime) {
      assert.equal((await executeTool("context_handover", args, store, api)).isError, true);
    }
    assert.equal((await executeTool("nope", { capability: "a".repeat(64) }, store, api)).isError, true);
    assert.equal(fs.existsSync(path.join(store.baseDir, "handovers")), false);

    const badStored: unknown[] = [{ handover: "", summary: "s" }, { handover: "h" }, { handover: 42, summary: "s" }, null];
    for (const toolInput of badStored) {
      const local = freshStore();
      const localApi = fakeApi(local, "s");
      const token = local.createPending({
        tool: "context_handover",
        caller: { sessionId: "s", workspaceId: "ws-1" },
        args: toolInput,
        diagnostics: { reason: "not-nudged", soft: 1 },
      });
      const result = await executeTool("context_handover", { capability: token }, local, localApi);
      assert.equal(result.isError, true, JSON.stringify(toolInput));
      assert.equal(local.getHandover("s"), undefined);
      assert.deepEqual(localApi.created, []);
    }
  });

  it("accepts unknown soft and skips the seed warning, and reports persistence errors without claiming handover", async () => {
    const store = freshStore();
    const api = fakeApi(store, "k");
    const big = "x".repeat(5000);
    const noSoft = store.createPending({
      tool: "context_handover",
      caller: { sessionId: "k", workspaceId: "ws-1" },
      args: { handover: big, summary: "s" },
      diagnostics: { reason: "unknown" },
    });
    const softResult = await executeTool("context_handover", { capability: noSoft }, store, api);
    assert.equal(softResult.isError, undefined);
    assert.equal(textOf(softResult as never).includes("advisory only"), false, "no seed warning without a soft limit");
    assert.equal(store.getHandover("k")?.handover, big);
    assert.equal(store.getHandover("k")?.diagnostics.soft, undefined);

    const readStore = freshStore();
    const readApi = fakeApi(readStore, "big-unknown");
    const created = readStore.createPending({
      tool: "context_handover",
      caller: { sessionId: "big-unknown", workspaceId: "ws-1" },
      args: { handover: big, summary: "s" },
      diagnostics: { reason: "unknown" },
    });
    assert.equal((await executeTool("context_handover", { capability: created }, readStore, readApi)).isError, undefined);
    const reader = await mint(readStore, TOOL_NAMES.read, { sessionID: "big-unknown" }, "other-live");
    const read = await executeTool("read_handover", { capability: reader }, readStore, readApi);
    assert.equal(read.isError, undefined);
    assert.ok(textOf(read as never).includes("soft-limit=unknown"));
    assert.equal(textOf(read as never).includes("advisory only"), false, "read skips the seed warning without a soft limit");

    for (const badSoft of [0, -5, "x", NaN]) {
      const badStore = freshStore();
      const badApi = fakeApi(badStore, "bad-soft");
      const bad = badStore.createPending({
        tool: "context_handover",
        caller: { sessionId: "bad-soft", workspaceId: "ws-1" },
        args: { handover: "h", summary: "s" },
        diagnostics: { reason: "unknown", soft: badSoft as never },
      });
      const badResult = await executeTool("context_handover", { capability: bad }, badStore, badApi);
      assert.equal(badResult.isError, true, JSON.stringify(badSoft));
      assert.match(textOf(badResult as never), /soft limit/);
      assert.equal(badStore.getHandover("bad-soft"), undefined);
    }

    const brokenBase = freshBase();
    // Read-only base dir: the lock check reads fine (ENOENT) but the
    // exclusive write fails, exercising the save-failure branch. (A
    // read-only handovers dir would not work: ensureDir self-heals to 0700.)
    const broken = new CrushStore(brokenBase);
    const brokenApi = fakeApi(broken, "s");
    const token = broken.createPending({
      tool: "context_handover",
      caller: { sessionId: "s", workspaceId: "ws-1" },
      args: { handover: "h", summary: "s" },
      diagnostics: { reason: "not-nudged", soft: 1 },
    });
    fs.chmodSync(brokenBase, 0o555);
    const result = await executeTool("context_handover", { capability: token }, broken, brokenApi);
    fs.chmodSync(brokenBase, 0o700);
    assert.equal(result.isError, true);
    assert.match(textOf(result as never), /nothing was stored/);
    assert.equal(textOf(result as never).includes("Successor root session"), false);
  });

  it("keeps stored handover and closed source on create failure with no retry and explicit recovery", async () => {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    api.failCreate = "socket reset";
    const capability = await mint(store, TOOL_NAMES.handover, { handover: "h", summary: "s" });
    const result = await executeTool("context_handover", { capability }, store, api);
    assert.equal(result.isError, true);
    const text = textOf(result as never);
    assert.ok(text.includes("handover stored"), text);
    assert.ok(text.includes("closed"), text);
    assert.ok(text.includes("Manual recovery"), text);
    assert.ok(text.includes("Inspect the server"), text);
    assert.ok(text.includes("never resubmit blindly"), text);
    assert.ok(text.includes("uncertain"), text);
    assert.ok(text.includes(readInvocation("ses-1")), text);
    assert.equal(api.created.length, 0);
    assert.equal(api.admitted.length, 0);
    assert.equal(store.getHandover("ses-1")?.handover, "h");
    const status = store.getStatus("ses-1");
    assert.ok(status?.error?.includes("socket reset"), "uncertain error persisted");
    assert.equal(status?.successorId, undefined, "no false successor");
    assert.equal(status?.admitted, undefined, "no false admitted flag");
  });

  it("names the successor on admission failure with no retry and explicit recovery", async () => {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    api.failAdmit = "connection lost";
    const capability = await mint(store, TOOL_NAMES.handover, { handover: "h", summary: "s" });
    const result = await executeTool("context_handover", { capability }, store, api);
    assert.equal(result.isError, true);
    const text = textOf(result as never);
    assert.ok(text.includes("ses-new-1"), text);
    assert.ok(text.includes("Manual recovery"), text);
    assert.ok(text.includes("uncertain"), text);
    assert.ok(text.includes("Inspect the successor"), text);
    assert.ok(text.includes("never resubmit blindly"), text);
    assert.ok(text.includes(readInvocation("ses-1")), text);
    assert.equal(api.created.length, 1, "single create attempt");
    assert.equal(api.admitted.length, 0);
    assert.deepEqual(store.getStatus("ses-1")?.successorId, "ses-new-1");
    assert.equal(store.getStatus("ses-1")?.admitted, undefined, "no false admitted:false on uncertain timeout");
    assert.ok(store.getStatus("ses-1")?.error?.includes("connection lost"));
  });

  it("refuses a successor id equal to the source", async () => {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    api.nextId = "ses-1";
    const capability = await mint(store, TOOL_NAMES.handover, { handover: "h", summary: "s" });
    const result = await executeTool("context_handover", { capability }, store, api);
    assert.equal(result.isError, true);
    assert.match(textOf(result as never), /equals the source/);
    assert.equal(api.admitted.length, 0, "no admission on self-loop");
  });

  it("warns advisory-only when the actual successor prompt exceeds 50% of soft", async () => {
    const tokenStore = freshStore();
    const api = fakeApi(tokenStore, "ses-1");
    const big = "x".repeat(5000);
    const token = tokenStore.createPending({
      tool: "context_handover",
      caller: { sessionId: "ses-1", workspaceId: "ws-1" },
      args: { handover: big, summary: "s" },
      diagnostics: { reason: "unknown", soft: 100 },
    });
    const result = await executeTool("context_handover", { capability: token }, tokenStore, api);
    assert.equal(result.isError, undefined);
    assert.ok(textOf(result as never).includes("advisory only"), "seed warning advisory");
  });

  it("never admits before the successor id is persisted", async () => {
    const base = freshBase();
    fs.writeFileSync(path.join(base, "status"), "blocker");
    const store = new CrushStore(base);
    const api = fakeApi(store, "ses-1");
    const capability = await mint(store, TOOL_NAMES.handover, { handover: "h", summary: "s" });
    const result = await executeTool("context_handover", { capability }, store, api);
    assert.equal(result.isError, true);
    assert.match(textOf(result as never), /bookkeeping failed/);
    assert.deepEqual(api.admitted, [], "no admission without persisted successor");
    assert.equal(store.getHandover("ses-1")?.handover, "h");
  });
});

describe("read_handover", () => {
  async function withHandover(): Promise<{ store: CrushStore; api: FakeApi }> {
    const store = freshStore();
    const api = fakeApi(store, "ses-1");
    const capability = await mint(store, TOOL_NAMES.handover, {
      handover: "Original task pointer.\n\nPrioritized next steps:\n- do the second thing",
      summary: "Did the first thing",
    });
    const result = await executeTool("context_handover", { capability }, store, api);
    assert.equal(result.isError, undefined);
    return { store, api };
  }

  it("lets any live host-bound root read any session id with the full verbatim text", async () => {
    const { store, api } = await withHandover();
    // The source is closed, so the read binds from a different live session.
    const token = await mint(store, TOOL_NAMES.read, { sessionID: "ses-1" }, "other-live");
    const result = await executeTool("read_handover", { capability: token }, store, api);
    assert.equal(result.isError, undefined);
    const text = textOf(result as never);
    const record = store.getHandover("ses-1");
    assert.ok(record);
    assert.ok(text.includes(JSON.stringify("ses-1")));
    assert.ok(text.includes("Diagnostics: reason="));
    assert.ok(text.includes("Provenance: source session"));
    assert.ok(text.includes("lag one model response"), "lag labeling");
    assert.ok(text.includes("Successor root session"), "persisted status sidecar");
    assert.ok(text.includes("Admission: admitted"), "admission sidecar");
    assert.equal(text.split(record.handover).length - 1, 1, "verbatim handover exactly once");
    assert.equal(text.split(SEED_FRAMING).length - 1, 1);
  });

  it("lets a workspace-less root-bound caller read", async () => {
    const { store, api } = await withHandover();
    const token = store.createPending({
      tool: "read_handover",
      caller: { sessionId: "other-live" },
      args: { sessionID: "ses-1" },
      diagnostics: { reason: "not-nudged", soft: 1 },
    });
    const result = await executeTool("read_handover", { capability: token }, store, api);
    assert.equal(result.isError, undefined);
    assert.ok(textOf(result as never).includes("Original task pointer"));
  });

  it("returns missing diagnostics with unknowns and no successor default", async () => {
    const store = freshStore();
    const api = fakeApi(store, "live");
    const token = await mint(store, TOOL_NAMES.read, { sessionID: "ghost" });
    const result = await executeTool("read_handover", { capability: token }, store, api);
    assert.equal(result.isError, undefined);
    const text = textOf(result as never);
    assert.ok(text.includes("No stored handover"));
    assert.ok(text.includes("reason=unknown"));
    assert.ok(text.includes("Provenance: unknown"));
    assert.equal(text.includes("Successor root session"), false);
  });

  it("rejects strict violations in read args", async () => {
    const badInputs: unknown[] = [{}, { sessionID: "" }, { sessionID: "k", full: true }, { sessionID: "k", caller: "x" }, { childId: "k" }];
    for (const toolInput of badInputs) {
      const store = freshStore();
      const api = fakeApi(store, "live");
      const token = store.createPending({
        tool: "read_handover",
        caller: { sessionId: "live", workspaceId: "ws-1" },
        args: toolInput,
        diagnostics: { reason: "not-nudged", soft: 1 },
      });
      const result = await executeTool("read_handover", { capability: token }, store, api);
      assert.equal(result.isError, true, JSON.stringify(toolInput));
    }
  });

  it("denies a locked caller with a fresh-live-root hint", async () => {
    const { store, api } = await withHandover();
    const token = store.createPending({
      tool: "read_handover",
      caller: { sessionId: "ses-1", workspaceId: "ws-1" },
      args: { sessionID: "ses-1" },
      diagnostics: { reason: "unknown", soft: 1 },
    });
    const result = await executeTool("read_handover", { capability: token }, store, api);
    assert.equal(result.isError, true);
    assert.match(textOf(result as never), /locked after a context handover/);
    assert.ok(textOf(result as never).includes("fresh live root"));
  });

  it("surfaces a large seed warning in read output advisory-only", async () => {
    const store = freshStore();
    const api = fakeApi(store, "big-src");
    const big = "y".repeat(5000);
    const created = store.createPending({
      tool: "context_handover",
      caller: { sessionId: "big-src", workspaceId: "ws-1" },
      args: { handover: big, summary: "s" },
      diagnostics: { reason: "unknown", soft: 100 },
    });
    const hand = await executeTool("context_handover", { capability: created }, store, api);
    assert.equal(hand.isError, undefined);
    const token = await mint(store, TOOL_NAMES.read, { sessionID: "big-src" }, "other-live");
    const read = await executeTool("read_handover", { capability: token }, store, api);
    assert.equal(read.isError, undefined);
    assert.ok(textOf(read as never).includes("advisory only"));
    assert.equal(textOf(read as never).split(big).length - 1, 1, "body not rewritten");
  });

  it("runs through a symlinked path with spaces (missing env fails, not silent exit 0)", async () => {
    const realServer = fileURLToPath(new URL("./server.ts", import.meta.url));
    const spaced = fs.mkdtempSync(path.join(os.tmpdir(), "crush server with spaces-"));
    const linkDir = path.join(spaced, "linked root");
    fs.mkdirSync(linkDir, { recursive: true });
    const linkServer = path.join(linkDir, "server.ts");
    try {
      fs.symlinkSync(realServer, linkServer);
    } catch {
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crush-home-"));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, ".local/share"), XDG_CONFIG_HOME: path.join(home, ".config") };
    for (const key of ["AUTO_CONTEXT_HANDOVER_DATA", "AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET"]) {
      delete env[key];
    }
    const result = spawnSync(process.execPath, [linkServer], { encoding: "utf8", env });
    assert.notEqual(result.status, 0, `symlinked server must not exit 0 silently; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.ok(String(result.stderr).length > 0, "missing env must produce stderr");
  });
});
