import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CodexStore,
  DuplicateHandoverError,
  PendingError,
  baseDirFromEnv,
  type CallerContext,
  type HandoverRecord,
  type Observation,
  type PendingRequest,
} from "./store.ts";

function freshBase(): string {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  return fs.mkdtempSync(path.join("/tmp/opencode", "codex-store-"));
}

function record(childId: string, overrides: Partial<HandoverRecord> = {}): HandoverRecord {
  return {
    childId,
    parentSessionId: "ses-parent-1",
    agentType: "explore",
    model: "openai/gpt-5",
    handover: "body",
    summary: "summary",
    closed: true,
    diagnostics: { reason: "nudged", stage: "warn1", soft: 150000 },
    ...overrides,
  };
}

function pendingRequest(overrides: Partial<PendingRequest> = {}): PendingRequest {
  const caller: CallerContext = { sessionId: "ses-live-1", childId: "child-1", agentType: "explore", model: "openai/gpt-5" };
  return { tool: "context_handover", caller, args: { childId: "child-1" }, diagnostics: { reason: "n/a" }, ...overrides };
}

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe("handover records", () => {
  it("missing record returns undefined", () => {
    assert.equal(new CodexStore(freshBase()).getHandover("nope"), undefined);
  });

  it("garbage and wrong-shape files throw", () => {
    const base = freshBase();
    const store = new CodexStore(base);
    store.saveHandover(record("good"));
    const dir = path.join(base, "handovers");
    const entries = fs.readdirSync(dir);
    assert.equal(entries.length, 1);
    fs.writeFileSync(path.join(dir, entries[0]!), "not json{{{");
    assert.throws(() => store.getHandover("good"), /corrupt/);
    fs.writeFileSync(path.join(dir, entries[0]!), JSON.stringify({ ...record("good"), closed: false }));
    assert.throws(() => store.getHandover("good"), /corrupt/);
  });

  it("verbatim unicode payload round-trips", () => {
    const store = new CodexStore(freshBase());
    const handover = "emoji \u{1F680} CJK \u6F22\u5B57 combining e\u0301\nnewline\ttab \"quotes\" \\ slash \u0000 nul?";
    const summary = "r\u00E9sum\u00E9 \u{1F525}\nline2";
    store.saveHandover(record("uni", { handover, summary }));
    const loaded = store.getHandover("uni");
    assert.equal(loaded?.handover, handover);
    assert.equal(loaded?.summary, summary);
    assert.deepEqual(loaded, record("uni", { handover, summary }));
  });

  it("traversal ids stay inside the store", () => {
    const base = freshBase();
    const store = new CodexStore(base);
    const ids = ["../../evil", "/abs", "a/b", "..\\..\\win", "child:1"];
    for (const id of ids) store.saveHandover(record(id));
    for (const id of ids) assert.equal(store.getHandover(id)?.childId, id);
    const files = fs.readdirSync(path.join(base, "handovers"));
    assert.equal(files.length, ids.length);
    for (const file of files) assert.match(file, /^[0-9a-f]{64}\.json$/);
    assert.equal(fs.existsSync(path.join(base, "evil")), false);
  });

  it("io failure throws and stores nothing partial", () => {
    const base = freshBase();
    fs.writeFileSync(path.join(base, "handovers"), "blocker");
    const store = new CodexStore(base);
    assert.throws(() => store.saveHandover(record("x")));
    assert.throws(() => store.getHandover("x"));
  });

  it("duplicate write refuses and first record wins", () => {
    const base = freshBase();
    const store = new CodexStore(base);
    store.saveHandover(record("dup", { handover: "first" }));
    assert.throws(() => store.saveHandover(record("dup", { handover: "second" })), DuplicateHandoverError);
    assert.equal(store.getHandover("dup")?.handover, "first");
    const leftovers = fs.readdirSync(path.join(base, "handovers")).filter((f) => f.startsWith(".tmp-"));
    assert.equal(leftovers.length, 0);
  });

  it("concurrent duplicate writes leave exactly one winner", async () => {
    const store = new CodexStore(freshBase());
    const first = record("race", { handover: "a" });
    const second = record("race", { handover: "b" });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => store.saveHandover(first)),
      Promise.resolve().then(() => store.saveHandover(second)),
    ]);
    const won = results.filter((r) => r.status === "fulfilled").length;
    const lost = results.filter((r) => r.status === "rejected" && r.reason instanceof DuplicateHandoverError).length;
    assert.equal(won, 1);
    assert.equal(lost, 1);
    assert.match(store.getHandover("race")?.handover ?? "", /^(a|b)$/);
  });

  it("private modes on dirs and files", () => {
    const base = freshBase();
    const store = new CodexStore(base);
    store.saveHandover(record("m"));
    assert.equal(modeOf(base), 0o700 & ~process.umask());
    assert.equal(modeOf(path.join(base, "handovers")), 0o700);
    const files = fs.readdirSync(path.join(base, "handovers"));
    assert.equal(modeOf(path.join(base, "handovers", files[0]!)), 0o600);
  });
});

describe("observations", () => {
  it("set/get/reset round-trips and resets to undefined", () => {
    const store = new CodexStore(freshBase());
    assert.equal(store.getObservation("c1"), undefined);
    const obs: Observation = { soft: 150000, estimatedTokens: 42, nudged: true };
    store.setObservation("c1", obs);
    assert.deepEqual(store.getObservation("c1"), obs);
    store.setObservation("c1", { soft: 9000 });
    assert.deepEqual(store.getObservation("c1"), { soft: 9000 });
    store.resetObservation("c1");
    assert.equal(store.getObservation("c1"), undefined);
    store.resetObservation("c1");
  });

  it("malformed sidecar throws", () => {
    const base = freshBase();
    const store = new CodexStore(base);
    store.setObservation("c2", { soft: 10 });
    const dir = path.join(base, "observations");
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    fs.writeFileSync(file, "{bad");
    assert.throws(() => store.getObservation("c2"), /corrupt/);
    fs.writeFileSync(file, JSON.stringify({ soft: "lots" }));
    assert.throws(() => store.getObservation("c2"), /corrupt/);
  });

  it("observation file is private", () => {
    const base = freshBase();
    const store = new CodexStore(base);
    store.setObservation("c3", { soft: 1 });
    const dir = path.join(base, "observations");
    assert.equal(modeOf(dir), 0o700);
    assert.equal(modeOf(path.join(dir, fs.readdirSync(dir)[0]!)), 0o600);
  });
});

describe("pending capability binding", () => {
  it("create/consume round-trips verbatim args", () => {
    const store = new CodexStore(freshBase());
    const request = pendingRequest({ args: { childId: "k+m\u00E9 \u{1F680}", n: 1 }, diagnostics: { soft: 7 } });
    const token = store.createPending(request);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.deepEqual(store.consumePending(token), request);
  });

  it("invalid tokens are rejected", () => {
    const store = new CodexStore(freshBase());
    for (const bad of ["", "zz", "ABCDEF", "../evil", "a".repeat(63), "a".repeat(65), "g".repeat(64), 42, undefined]) {
      assert.throws(() => store.consumePending(bad as unknown as string), PendingError);
    }
  });

  it("direct unknown token and replay fail", () => {
    const store = new CodexStore(freshBase());
    assert.throws(() => store.consumePending("a".repeat(64)), PendingError);
    const token = store.createPending(pendingRequest());
    store.consumePending(token);
    assert.throws(() => store.consumePending(token), PendingError);
  });

  it("parallel consume has exactly one winner", async () => {
    const store = new CodexStore(freshBase());
    const token = store.createPending(pendingRequest({ tool: "read_handover" }));
    const results = await Promise.allSettled([
      Promise.resolve().then(() => store.consumePending(token)),
      Promise.resolve().then(() => store.consumePending(token)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  });

  it("corrupt pending is deleted after the failed read", () => {
    const base = freshBase();
    const store = new CodexStore(base);
    const token = store.createPending(pendingRequest());
    fs.writeFileSync(path.join(base, "pending", `${token}.json`), "garbage{{{");
    assert.throws(() => store.consumePending(token), PendingError);
    assert.deepEqual(fs.readdirSync(path.join(base, "pending")), []);
  });

  it("caller identity rejects paths and non-strings", () => {
    const store = new CodexStore(freshBase());
    assert.throws(() => store.createPending(pendingRequest({ caller: {} as CallerContext })), PendingError);
    assert.throws(() => store.createPending(pendingRequest({ caller: { sessionId: 42 } as unknown as CallerContext })), PendingError);
    assert.throws(() => store.createPending(pendingRequest({ tool: "other" as unknown as "context_handover" })), PendingError);
  });

  it("pending request file is private", () => {
    const base = freshBase();
    const store = new CodexStore(base);
    const token = store.createPending(pendingRequest());
    assert.equal(modeOf(path.join(base, "pending")), 0o700);
    assert.equal(modeOf(path.join(base, "pending", `${token}.json`)), 0o600);
  });
});

describe("base dir", () => {
  it("requires PLUGIN_DATA with no fallback", () => {
    assert.throws(() => baseDirFromEnv({}), /PLUGIN_DATA/);
    assert.throws(() => baseDirFromEnv({ PLUGIN_DATA: "" }), /PLUGIN_DATA/);
    assert.equal(baseDirFromEnv({ PLUGIN_DATA: "/tmp/opencode/x" }), "/tmp/opencode/x");
    assert.throws(() => new CodexStore(""), /baseDir/);
  });

  it("works under an isolated tmp fixture dir", () => {
    const store = new CodexStore(path.join(freshBase(), "nested", "store"));
    store.saveHandover(record("iso"));
    assert.equal(store.getHandover("iso")?.summary, "summary");
    void os.tmpdir();
  });
});
