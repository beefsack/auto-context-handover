import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  baseDirFromEnv,
  CrushStore,
  DuplicateHandoverError,
  PendingError,
  type CallerContext,
  type HandoverRecord,
  type PendingRequest,
  type RolloverStatus,
} from "./store.ts";

function freshBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crush-store-"));
}

function freshStore(): CrushStore {
  return new CrushStore(freshBase());
}

function record(sessionId: string, overrides: Partial<HandoverRecord> = {}): HandoverRecord {
  return {
    sessionId,
    workspaceId: "ws-1",
    model: "prov/model",
    handover: "body",
    summary: "summary",
    closed: true,
    diagnostics: { reason: "nudged", stage: "warn1", soft: 150000 },
    ...overrides,
  };
}

function pendingRequest(overrides: Partial<PendingRequest> = {}): PendingRequest {
  const caller: CallerContext = { sessionId: "ses-live-1", workspaceId: "ws-1", model: "prov/model" };
  return { tool: "context_handover", caller, args: { handover: "h" }, diagnostics: { reason: "n/a" }, ...overrides };
}

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe("config", () => {
  it("requires an absolute adapter-private data dir", () => {
    const base = freshBase();
    assert.equal(baseDirFromEnv({ AUTO_CONTEXT_HANDOVER_DATA: base }), base);
    for (const bad of [undefined, "", "relative/dir", "sock-only"]) {
      assert.throws(() => baseDirFromEnv({ AUTO_CONTEXT_HANDOVER_DATA: bad as string }), /absolute/);
    }
    // No socket discovery: the data dir never falls back to a user socket.
    assert.throws(() => baseDirFromEnv({}), /AUTO_CONTEXT_HANDOVER_DATA/);
  });
});

describe("handover records", () => {
  it("missing record returns undefined", () => {
    assert.equal(freshStore().getHandover("nope"), undefined);
  });

  it("garbage and wrong-shape files throw", () => {
    const base = freshBase();
    const store = new CrushStore(base);
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
    const store = freshStore();
    const handover = "emoji \u{1F680} CJK \u6F22\u5B57 combining e\u0301\nnewline\ttab \"quotes\" \\ slash";
    const summary = "r\u00E9sum\u00E9 \u{1F525}\nline2";
    store.saveHandover(record("uni", { handover, summary }));
    const loaded = store.getHandover("uni");
    assert.equal(loaded?.handover, handover);
    assert.equal(loaded?.summary, summary);
    assert.deepEqual(loaded, record("uni", { handover, summary }));
  });

  it("traversal ids stay inside the store", () => {
    const base = freshBase();
    const store = new CrushStore(base);
    const ids = ["../../evil", "/abs", "a/b", "..\\..\\win", "ses:1"];
    for (const id of ids) store.saveHandover(record(id));
    for (const id of ids) assert.equal(store.getHandover(id)?.sessionId, id);
    const files = fs.readdirSync(path.join(base, "handovers"));
    assert.ok(files.every((file) => /^[0-9a-f]{64}\.json$/.test(file)));
  });

  it("first writer wins; the second handover is rejected immutably", () => {
    const store = freshStore();
    store.saveHandover(record("s1", { handover: "first" }));
    assert.throws(() => store.saveHandover(record("s1", { handover: "second" })), DuplicateHandoverError);
    assert.equal(store.getHandover("s1")?.handover, "first");
  });

  it("dirs are 0700 and files are 0600", () => {
    const base = freshBase();
    const store = new CrushStore(base);
    store.saveHandover(record("s1"));
    store.updateStatus("s1", { successorId: "n1" });
    store.createPending(pendingRequest());
    assert.equal(modeOf(path.join(base, "handovers")), 0o700);
    assert.equal(modeOf(path.join(base, "status")), 0o700);
    assert.equal(modeOf(path.join(base, "pending")), 0o700);
    for (const dir of ["handovers", "status", "pending"]) {
      for (const file of fs.readdirSync(path.join(base, dir))) {
        if (file.startsWith(".tmp-")) continue;
        assert.equal(modeOf(path.join(base, dir, file)), 0o600, `${dir}/${file}`);
      }
    }
  });
});

describe("rollover status", () => {
  it("missing status returns undefined and merges atomically", () => {
    const store = freshStore();
    assert.equal(store.getStatus("ghost"), undefined);
    assert.deepEqual(store.updateStatus("s1", { successorId: "n1" }), { successorId: "n1" });
    assert.deepEqual(store.updateStatus("s1", { admitted: true }), { successorId: "n1", admitted: true });
    assert.deepEqual(store.getStatus("s1"), { successorId: "n1", admitted: true });
  });

  it("status updates never rewrite the verbatim handover", () => {
    const base = freshBase();
    const store = new CrushStore(base);
    store.saveHandover(record("s1", { handover: "exact body", summary: "exact summary" }));
    const dir = path.join(base, "handovers");
    const before = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), "utf8");
    store.updateStatus("s1", { successorId: "n1", admitted: true, error: "boom" });
    const after = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), "utf8");
    assert.equal(after, before);
    assert.equal(store.getHandover("s1")?.handover, "exact body");
  });

  it("rejects unknown status fields and corrupt files", () => {
    const store = freshStore();
    assert.throws(() => store.updateStatus("s1", { nope: 1 } as unknown as RolloverStatus), /unknown field/);
    const base = freshBase();
    const local = new CrushStore(base);
    local.updateStatus("s1", { successorId: "n1" });
    const dir = path.join(base, "status");
    fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]!), "garbage{{{");
    assert.throws(() => local.getStatus("s1"), /corrupt/);
  });
});

describe("pending capabilities", () => {
  it("round-trips and is single-use", () => {
    const store = freshStore();
    const token = store.createPending(pendingRequest());
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.deepEqual(store.consumePending(token), pendingRequest());
    assert.throws(() => store.consumePending(token), PendingError);
  });

  it("rejects malformed tokens without touching storage", () => {
    const base = freshBase();
    const store = new CrushStore(base);
    for (const bad of ["", "short", "A".repeat(64), "g".repeat(64)]) {
      assert.throws(() => store.consumePending(bad), PendingError);
    }
    assert.deepEqual(fs.existsSync(path.join(base, "pending")) ? fs.readdirSync(path.join(base, "pending")) : [], []);
  });

  it("rejects corrupt pending files and bad callers", () => {
    const store = freshStore();
    assert.throws(() => store.createPending({ ...pendingRequest(), caller: { sessionId: "" } }), PendingError);
    const base = freshBase();
    const local = new CrushStore(base);
    const token = local.createPending(pendingRequest());
    fs.writeFileSync(path.join(base, "pending", `${token}.json`), "nope{{{");
    assert.throws(() => local.consumePending(token), PendingError);
  });
});
