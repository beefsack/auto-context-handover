import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SEED_FRAMING } from "../source/shared/handover-text.ts";
import type { ExportedSession, SessionReader } from "./session.ts";
import { createServer, executeTool, listTools, metaSessionId } from "./server.ts";
import { GooseStore } from "./store.ts";
import { HANDOVER_INPUT_SCHEMA, READ_INPUT_SCHEMA, TOOL_NAMES } from "./text.ts";

const PINNED = "root-1";
const META = { "agent-session-id": PINNED };

function freshStore(): GooseStore {
  return new GooseStore(fs.mkdtempSync(path.join(os.tmpdir(), "goose-server-")));
}

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write;
  let out = "";
  process.stderr.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

function rootExport(overrides: Partial<Record<string, unknown>> = {}): ExportedSession {
  return {
    id: PINNED,
    session_type: "user",
    parent_session_id: null,
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    provider_name: null,
    model_config: null,
    ...overrides,
  } as unknown as ExportedSession;
}

function readerFor(exported: ExportedSession): SessionReader {
  return (id: string) => {
    assert.equal(id, PINNED);
    return exported;
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return String(first.text);
}

function isError(result: { isError?: boolean }): boolean {
  return result.isError === true;
}

describe("tools/list", () => {
  it("advertises handover+summary and sessionID schemas", () => {
    const tools = listTools();
    assert.equal(tools.length, 2);
    const handover = tools.find((tool) => tool.name === "context_handover");
    const read = tools.find((tool) => tool.name === "read_handover");
    assert.ok(handover && read);
    assert.deepEqual(
      (handover.inputSchema as { required: string[] }).required,
      [...HANDOVER_INPUT_SCHEMA.required],
    );
    assert.deepEqual((read.inputSchema as { required: string[] }).required, [...READ_INPUT_SCHEMA.required]);
    assert.ok(handover.description && handover.description.includes("Original instructions"));
    assert.ok(read.description && read.description.includes("sessionID"));
  });

  it("lists tools and round-trips _meta identity over a real SDK transport", async () => {
    const store = freshStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(store, readerFor(rootExport()), PINNED, {});
    await server.connect(serverTransport);
    try {
      const client = new Client({ name: "probe", version: "0.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        ["context_handover", "read_handover"],
      );
      const stored = await client.callTool({
        name: "context_handover",
        arguments: { handover: "h", summary: "s" },
        _meta: { "agent-session-id": PINNED },
      });
      assert.match(String((stored.content as Array<{ text?: string }>)[0]?.text), /stored for session/);
      const back = await client.callTool({
        name: "read_handover",
        arguments: { sessionID: PINNED },
        _meta: { "agent-session-id": PINNED },
      });
      const text = String((back.content as Array<{ text?: string }>)[0]?.text);
      assert.ok(text.includes("\nh\n\n") && text.includes(SEED_FRAMING));
    } finally {
      await server.close();
    }
  });
});

describe("host identity", () => {
  it("reads the per-call _meta id case-insensitively and rejects spoofed args", async () => {
    assert.equal(metaSessionId({ "agent-session-id": "a" }), "a");
    assert.equal(metaSessionId({ "Agent-Session-Id": "b" }), "b");
    assert.equal(metaSessionId({}), undefined);
    assert.equal(metaSessionId(undefined), undefined);
    assert.equal(metaSessionId({ "agent-session-id": 42 }), undefined);
    const store = freshStore();
    // Model args cannot carry identity: unknown fields are rejected and the
    // writer binds the transport id only.
    const out = await executeTool(
      "context_handover",
      { handover: "h", summary: "s", sessionID: "forged", capability: "x" },
      META,
      store,
      readerFor(rootExport()),
      PINNED,
      {},
    );
    assert.ok(isError(out));
    assert.match(textOf(out), /unknown field/);
    assert.equal(store.getHandover(PINNED), undefined);
  });

  it("refuses calls with missing identity, mismatched identity, or no pin", async () => {
    const store = freshStore();
    const reader = readerFor(rootExport());
    for (const meta of [undefined, {}, { "agent-session-id": "other" }]) {
      const out = await executeTool("read_handover", { sessionID: PINNED }, meta, store, reader, PINNED, {});
      assert.ok(isError(out), JSON.stringify(meta));
      assert.match(textOf(out), /identity|mismatch/);
    }
    const unpinned = await executeTool("read_handover", { sessionID: PINNED }, META, store, reader, "", {});
    assert.ok(isError(unpinned));
    assert.match(textOf(unpinned), /not pinned/);
  });

  it("rejects unknown tools", async () => {
    const store = freshStore();
    const out = await executeTool("nope", {}, META, store, readerFor(rootExport()), PINNED, {});
    assert.ok(isError(out));
    assert.match(textOf(out), /unknown tool/);
  });
});

describe("writer", () => {
  it("stores the first handover verbatim with source-bound model and receipt", async () => {
    const store = freshStore();
    const out = await executeTool(
      TOOL_NAMES.handover,
      { handover: "full\ntext", summary: "done" },
      META,
      store,
      readerFor(rootExport({ model_config: { model_name: "m1" } })),
      PINNED,
      {},
    );
    assert.equal(isError(out), false);
    assert.match(textOf(out), new RegExp(`stored for session ${JSON.stringify(PINNED)}`));
    assert.match(textOf(out), /Manual continuation default/);
    assert.doesNotMatch(textOf(out), /cannot do more work/);
    const record = store.getHandover(PINNED);
    assert.equal(record?.handover, "full\ntext");
    assert.equal(record?.model, "m1");
    assert.equal(record?.diagnostics.reason, "unknown");
    // Prefixed host form is accepted defensively.
    const dup = await executeTool(
      "context_handover",
      { handover: "second", summary: "s" },
      META,
      store,
      readerFor(rootExport()),
      PINNED,
      {},
    );
    assert.ok(isError(dup));
    assert.match(textOf(dup), /immutable/);
    assert.equal(store.getHandover(PINNED)?.handover, "full\ntext");
  });

  it("refuses writes for children, mismatched exports, and unavailable checks", async () => {
    const child: SessionReader = () => rootExport({ session_type: "sub_agent", parent_session_id: "p0" });
    const outChild = await executeTool("context_handover", { handover: "h", summary: "s" }, META, freshStore(), child, PINNED, {});
    assert.ok(isError(outChild));
    assert.match(textOf(outChild), /only root user sessions/);

    const mismatched: SessionReader = () => rootExport({ id: "someone-else" });
    const outMismatch = await executeTool("context_handover", { handover: "h", summary: "s" }, META, freshStore(), mismatched, PINNED, {});
    assert.ok(isError(outMismatch));
    assert.match(textOf(outMismatch), /owner id/);

    const failing: SessionReader = () => {
      throw new Error("boom");
    };
    const outDown = await executeTool("context_handover", { handover: "h", summary: "s" }, META, freshStore(), failing, PINNED, {});
    assert.ok(isError(outDown));
    assert.match(textOf(outDown), /root check unavailable, write refused/);
  });

  it("validates writer args strictly", async () => {
    const store = freshStore();
    const reader = readerFor(rootExport());
    for (const args of [
      null,
      { handover: "", summary: "s" },
      { handover: "h", summary: 42 },
      { handover: "h" },
    ]) {
      const out = await executeTool("context_handover", args, META, store, reader, PINNED, {});
      assert.ok(isError(out), JSON.stringify(args));
    }
    assert.equal(store.getHandover(PINNED), undefined);
  });

  it("stores without soft/stage diagnostics on invalid soft, keeping the estimate", async () => {
    const store = freshStore();
    const logged = await captureStderr(async () => {
      const out = await executeTool(
        "context_handover",
        { handover: "h", summary: "s" },
        META,
        store,
        readerFor(rootExport()),
        PINNED,
        { AUTO_CONTEXT_HANDOVER_SOFT: "70%" },
      );
      assert.equal(isError(out), false);
    });
    assert.match(logged, /AUTO_CONTEXT_HANDOVER_SOFT must be a positive integer/);
    assert.deepEqual(store.getHandover(PINNED)?.diagnostics, { reason: "unknown", estimatedTokens: 150 });
  });
});

describe("reader", () => {
  it("reads any retained id verbatim with provenance, then reloads", async () => {
    const base = (() => {
      return fs.mkdtempSync(path.join(os.tmpdir(), "goose-read-"));
    })();
    const writer = new GooseStore(base);
    const stored = await executeTool("context_handover", { handover: "keep me", summary: "s" }, META, writer, readerFor(rootExport()), PINNED, {});
    assert.equal(isError(stored), false);
    const reloaded = new GooseStore(base);
    const out = await executeTool("read_handover", { sessionID: PINNED }, META, reloaded, readerFor(rootExport()), PINNED, {});
    assert.equal(isError(out), false);
    const text = textOf(out);
    assert.ok(text.includes("keep me") && text.includes("Provenance") && text.includes(SEED_FRAMING));
  });

  it("reports missing ids and corrupt records explicitly", async () => {
    const store = freshStore();
    const missing = await executeTool("read_handover", { sessionID: "ghost" }, META, store, readerFor(rootExport()), PINNED, {});
    assert.equal(isError(missing), false);
    assert.match(textOf(missing), /No stored handover for session/);

    const base = store.baseDir;
    const { GooseStore: Reload } = await import("./store.ts");
    const writer = new Reload(base);
    writer.saveHandover({
      sessionId: "bad",
      model: "unknown",
      handover: "h",
      summary: "s",
      diagnostics: { reason: "unknown", soft: 150000 },
    });
    const dir = path.join(base, "handovers");
    const file = fs.readdirSync(dir).find((name) => name.endsWith(".json"));
    assert.ok(file);
    fs.writeFileSync(path.join(dir, file as string), "corrupt");
    const out = await executeTool("read_handover", { sessionID: "bad" }, META, new Reload(base), readerFor(rootExport()), PINNED, {});
    assert.ok(isError(out));
    assert.match(textOf(out), /corrupt/);
  });

  it("adds an advisory seed warning only past half the soft limit", async () => {
    const store = freshStore();
    const big = "x".repeat(300001);
    const stored = await executeTool("context_handover", { handover: big, summary: "s" }, META, store, readerFor(rootExport()), PINNED, {});
    assert.equal(isError(stored), false);
    const out = await executeTool("read_handover", { sessionID: PINNED }, META, store, readerFor(rootExport()), PINNED, {});
    assert.match(textOf(out), /advisory only/);

    const smallStore = freshStore();
    smallStore.saveHandover({
      sessionId: "tiny",
      model: "unknown",
      handover: "tiny",
      summary: "s",
      diagnostics: { reason: "unknown", soft: 150000 },
    });
    const quiet = await executeTool("read_handover", { sessionID: "tiny" }, META, smallStore, readerFor(rootExport()), PINNED, {});
    assert.equal(isError(quiet), false);
    assert.doesNotMatch(textOf(quiet), /advisory only/);
  });
});
