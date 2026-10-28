import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  baseDirFromEnv,
  DuplicateHandoverError,
  GooseStore,
  type HandoverRecord,
} from "./store.ts";

function freshBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "goose-store-"));
}

function record(sessionId: string): HandoverRecord {
  return {
    sessionId,
    model: "unknown",
    handover: "full text",
    summary: "short summary",
    diagnostics: { reason: "unknown", soft: 150000 },
  };
}

describe("base dir", () => {
  it("honors an absolute override and rejects bad values", () => {
    const abs = path.join(os.tmpdir(), "goose-data");
    assert.equal(baseDirFromEnv({ AUTO_CONTEXT_HANDOVER_GOOSE_DATA: abs }), abs);
    assert.throws(() => baseDirFromEnv({ AUTO_CONTEXT_HANDOVER_GOOSE_DATA: "" }), /absolute/);
    assert.throws(() => baseDirFromEnv({ AUTO_CONTEXT_HANDOVER_GOOSE_DATA: "relative" }), /absolute/);
  });

  it("falls back to XDG_DATA_HOME then ~/.local/share", () => {
    assert.equal(
      baseDirFromEnv({ XDG_DATA_HOME: path.join(os.tmpdir(), "xdg") }),
      path.join(os.tmpdir(), "xdg", "auto-context-handover-goose"),
    );
    assert.equal(
      baseDirFromEnv({ HOME: path.join(os.tmpdir(), "fakehome"), XDG_DATA_HOME: "" }),
      path.join(os.tmpdir(), "fakehome", ".local", "share", "auto-context-handover-goose"),
    );
  });
});

describe("handovers", () => {
  it("round-trips verbatim and reports missing as undefined", () => {
    const store = new GooseStore(freshBase());
    assert.equal(store.getHandover("s1"), undefined);
    store.saveHandover(record("s1"));
    assert.deepEqual(store.getHandover("s1"), record("s1"));
  });

  it("keeps the first writer; the second loses without overwriting", () => {
    const store = new GooseStore(freshBase());
    store.saveHandover(record("s1"));
    assert.throws(() => store.saveHandover({ ...record("s1"), handover: "other" }), DuplicateHandoverError);
    assert.equal(store.getHandover("s1")?.handover, "full text");
  });

  it("treats corrupt or mistyped records as explicit errors", () => {
    const base = freshBase();
    const store = new GooseStore(base);
    store.saveHandover(record("s1"));
    const dir = path.join(base, "handovers");
    const file = fs.readdirSync(dir).find((name) => name.endsWith(".json") && !name.startsWith(".tmp"));
    assert.ok(file);
    fs.writeFileSync(path.join(dir, file as string), "{not json");
    assert.throws(() => store.getHandover("s1"), /corrupt/);
    fs.writeFileSync(path.join(dir, file as string), JSON.stringify({ ...record("s1"), handover: 42 }));
    assert.throws(() => store.getHandover("s1"), /corrupt/);
  });

  it("creates dirs 0700 and files 0600 with hashed traversal-safe names", () => {
    const base = freshBase();
    const store = new GooseStore(base);
    const evil = "../../evil-traversal";
    store.saveHandover(record(evil));
    const dir = path.join(base, "handovers");
    assert.equal((fs.statSync(dir).mode & 0o777).toString(8), "700");
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0] as string, /^[0-9a-f]{64}\.json$/);
    assert.equal((fs.statSync(path.join(dir, files[0] as string)).mode & 0o777).toString(8), "600");
    assert.deepEqual(store.getHandover(evil)?.handover, "full text");
    assert.ok(!fs.existsSync(path.join(base, "evil-traversal")));
  });

  it("rejects non-integer, negative, or unsafe diagnostics counts", () => {
    const store = new GooseStore(freshBase());
    for (const diagnostics of [
      { reason: "unknown", estimatedTokens: 1.5, soft: 150000 },
      { reason: "unknown", estimatedTokens: -1, soft: 150000 },
      { reason: "unknown", estimatedTokens: Number.MAX_SAFE_INTEGER + 1, soft: 150000 },
      { reason: "unknown", estimatedTokens: Number.POSITIVE_INFINITY, soft: 150000 },
      { reason: "unknown", estimatedTokens: Number.NaN, soft: 150000 },
      { reason: "unknown", soft: 0 },
      { reason: "unknown", soft: -5 },
      { reason: "unknown", soft: 1.5 },
    ]) {
      assert.throws(
        () => store.saveHandover({ ...record("s1"), diagnostics: diagnostics as never }),
        /diagnostics/,
      );
    }
    assert.equal(store.getHandover("s1"), undefined);
  });

  it("reloads the verbatim record from a fresh instance", () => {
    const base = freshBase();
    new GooseStore(base).saveHandover(record("s9"));
    assert.deepEqual(new GooseStore(base).getHandover("s9"), record("s9"));
  });
});
