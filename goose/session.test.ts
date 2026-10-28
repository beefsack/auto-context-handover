import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  estimateFromUsage,
  EXPORT_MAX_BUFFER,
  exportSessionJson,
  GOOSE_BIN_ENV_VAR,
  isRootSession,
  modelFromExport,
  resolveGooseBin,
  SessionExportError,
  type ExportedSession,
} from "./session.ts";

function session(overrides: Partial<Record<string, unknown>> = {}): ExportedSession {
  return {
    id: "s1",
    session_type: "user",
    parent_session_id: null,
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    ...overrides,
  } as unknown as ExportedSession;
}

function okRun(payload: unknown) {
  return () => ({ status: 0, stdout: JSON.stringify(payload), stderr: "" });
}

describe("goose binary", () => {
  it("defaults to PATH lookup and honors the env override", () => {
    assert.equal(resolveGooseBin({}), "goose");
    assert.equal(resolveGooseBin({ [GOOSE_BIN_ENV_VAR]: "/opt/goose" }), "/opt/goose");
    assert.throws(() => resolveGooseBin({ [GOOSE_BIN_ENV_VAR]: "" }), SessionExportError);
  });
});

describe("session export", () => {
  it("parses a native export and rejects failures explicitly", () => {
    assert.deepEqual(exportSessionJson("s1", {}, okRun(session())), session());
    assert.throws(
      () => exportSessionJson("s1", {}, () => ({ status: 0, stdout: "oops", stderr: "" })),
      /not valid JSON/,
    );
    assert.throws(
      () => exportSessionJson("s1", {}, () => ({ status: 0, stdout: "[1]", stderr: "" })),
      /not an object/,
    );
    assert.throws(
      () => exportSessionJson("nope", {}, () => ({ status: 1, stdout: "", stderr: "Session 'nope' not found" })),
      /export failed.*not found/,
    );
    assert.throws(
      () =>
        exportSessionJson("s1", {}, () => {
          throw new Error("ENOENT");
        }),
      /could not run session export/,
    );
    assert.throws(() => exportSessionJson("", {}, okRun(session())), /non-empty/);
  });

  it("passes --session-id and --format json to the CLI", () => {
    let seen: readonly string[] = [];
    exportSessionJson("abc", { [GOOSE_BIN_ENV_VAR]: "goose-bin" }, (bin, args) => {
      seen = [bin, ...args];
      return { status: 0, stdout: JSON.stringify(session({ id: "abc" })), stderr: "" };
    });
    assert.deepEqual(seen, ["goose-bin", "session", "export", "--session-id", "abc", "--format", "json"]);
  });

  it("passes the supplied env through to the real CLI subprocess", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goose-session-real-"));
    const bin = path.join(dir, "fake-goose");
    const arglog = path.join(dir, "args.log");
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$ARGLOG"\nprintf '{"id":"%s","session_type":"user","parent_session_id":null,"usage":{"input_tokens":1,"output_tokens":2}}' "$WANT_ID"\n`,
      { mode: 0o755 },
    );
    const env = { ...process.env, [GOOSE_BIN_ENV_VAR]: bin, ARGLOG: arglog, WANT_ID: "s1" };
    const exported = exportSessionJson("s1", env);
    assert.equal(exported.id, "s1");
    const logged = fs.readFileSync(arglog, "utf8").split("\n");
    assert.deepEqual(logged, ["session", "export", "--session-id", "s1", "--format", "json", ""]);
  });

  it("reports oversize exports as unknown instead of truncating", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goose-session-huge-"));
    const bin = path.join(dir, "huge-goose");
    fs.writeFileSync(bin, `#!/bin/sh\nhead -c ${EXPORT_MAX_BUFFER + 1024} /dev/zero\n`, { mode: 0o755 });
    assert.throws(
      () => exportSessionJson("s1", { ...process.env, [GOOSE_BIN_ENV_VAR]: bin }),
      (error: unknown) =>
        error instanceof SessionExportError &&
        error.code === "EXPORT_TOO_LARGE" &&
        /treating usage as unknown/.test(error.message),
    );
  });

  it("rethrows runner SessionExportErrors without wrapping", () => {
    assert.throws(
      () => exportSessionJson("s1", {}, () => {
        throw new SessionExportError("EXPORT_TOO_LARGE", "too big; treating usage as unknown");
      }),
      (error: unknown) => error instanceof SessionExportError && (error as SessionExportError).code === "EXPORT_TOO_LARGE",
    );
  });
});

describe("root check", () => {
  it("accepts only user sessions with a null parent", () => {
    assert.equal(isRootSession(session()), true);
    assert.equal(isRootSession(session({ session_type: "sub_agent", parent_session_id: "s0" })), false);
    assert.equal(isRootSession(session({ session_type: "scheduled", parent_session_id: null })), false);
    assert.equal(isRootSession(session({ session_type: "user", parent_session_id: "s0" })), false);
    assert.equal(isRootSession(session({ parent_session_id: undefined })), false);
    assert.equal(isRootSession(session({ session_type: "USER" })), false);
  });
});

describe("usage estimate", () => {
  it("prefers total and falls back to input+output without double-counting cache", () => {
    assert.equal(estimateFromUsage(session()), 150);
    // input already folds cache subsets in; cache fields must not be added.
    assert.equal(
      estimateFromUsage(
        session({ usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 900 } }),
      ),
      1050,
    );
    assert.equal(estimateFromUsage(session({ usage: { input_tokens: 100, output_tokens: 50 } })), 150);
  });

  it("returns unknown for missing, zero, or unsafe counts", () => {
    assert.equal(estimateFromUsage(session({ usage: undefined })), undefined);
    assert.equal(estimateFromUsage(session({ usage: null })), undefined);
    assert.equal(estimateFromUsage(session({ usage: { input_tokens: 0, output_tokens: 0 } })), undefined);
    assert.equal(estimateFromUsage(session({ usage: { input_tokens: 100 } })), undefined);
    assert.equal(
      estimateFromUsage(session({ usage: { input_tokens: -1, output_tokens: 5, total_tokens: -1 } })),
      undefined,
    );
    assert.equal(
      estimateFromUsage(session({ usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } })),
      undefined,
    );
  });

  it("ignores the accumulated billing ledger in favor of the latest report", () => {
    const withLedger = session({
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      accumulated_usage: { input_tokens: 99999, output_tokens: 99999, total_tokens: 199998 },
    });
    assert.equal(estimateFromUsage(withLedger), 150);
  });
});

describe("model attribution", () => {
  it("uses only the native model_config.model_name, never a provider fallback", () => {
    assert.equal(modelFromExport(session({ model_config: { model_name: "m1" } })), "m1");
    assert.equal(modelFromExport(session({ model_config: {}, provider_name: "p1" })), "unknown");
    assert.equal(modelFromExport(session({ model_config: { model: "m1" } })), "unknown");
    assert.equal(modelFromExport(session({ model_config: {} })), "unknown");
  });
});
