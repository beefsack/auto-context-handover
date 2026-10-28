import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  ConfigError,
  DEFAULT_SOFT,
  handleHook,
  isStopOptIn,
  resolveSoft,
  STOP_OPT_IN_ENV_VAR,
} from "./hook.ts";
import { OPENCODE_WARN1, OPENCODE_WARN2, OPENCODE_WARN3 } from "../source/shared/handover-text.ts";
import type { ExportedSession, SessionReader } from "./session.ts";
import { GooseStore } from "./store.ts";
import { SESSION_BANNER, TOOL_NAMES } from "./text.ts";

const SOFT_ENV = "AUTO_CONTEXT_HANDOVER_SOFT";
const OPT_IN = { [STOP_OPT_IN_ENV_VAR]: "1" };

function freshStore(): GooseStore {
  return new GooseStore(fs.mkdtempSync(path.join(os.tmpdir(), "goose-hook-")));
}

function rootExport(overrides: Partial<Record<string, unknown>> = {}): ExportedSession {
  return {
    id: "s1",
    session_type: "user",
    parent_session_id: null,
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    ...overrides,
  } as unknown as ExportedSession;
}

function readerFor(exported: ExportedSession): SessionReader {
  return () => exported;
}

function stopPayload(sessionId = "s1", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { event: "Stop", session_id: sessionId, working_dir: os.tmpdir(), ...extra };
}

function captureStderr(fn: () => void): string {
  const original = process.stderr.write;
  let out = "";
  process.stderr.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

describe("config", () => {
  it("defaults soft to 150000 and accepts positive integers only", () => {
    assert.equal(DEFAULT_SOFT, 150000);
    assert.equal(resolveSoft({}), 150000);
    assert.equal(resolveSoft({ [SOFT_ENV]: "200000" }), 200000);
    for (const bad of ["abc", "0", "-5", "1.5", "", "150k", "70%", "0x10", "101%"]) {
      assert.throws(() => resolveSoft({ [SOFT_ENV]: bad }), ConfigError, bad);
    }
  });

  it("requires explicit opt-in for Stop denials", () => {
    assert.equal(isStopOptIn({}), false);
    assert.equal(isStopOptIn(OPT_IN), true);
    assert.equal(isStopOptIn({ [STOP_OPT_IN_ENV_VAR]: "true" }), false);
  });
});

describe("non-Stop input", () => {
  it("banners SessionStart and ignores everything else without I/O", () => {
    const store = freshStore();
    const reader = readerFor(rootExport());
    assert.deepEqual(handleHook({ event: "SessionStart", session_id: "s1" }, store, reader, OPT_IN), {
      banner: SESSION_BANNER,
    });
    // SessionStart never needs the soft limit, even when it is invalid.
    assert.deepEqual(
      handleHook({ event: "SessionStart", session_id: "s1" }, store, reader, { [SOFT_ENV]: "70%" }),
      { banner: SESSION_BANNER },
    );
    for (const input of [
      null,
      "nope",
      {},
      { event: "PreToolUse", session_id: "s1" },
      { event: "UserPromptSubmit", session_id: "s1" },
      { event: "Stop" },
      { event: "Stop", session_id: "" },
      { hook_event_name: "SessionEnd", session_id: "s1" },
    ]) {
      assert.deepEqual(handleHook(input, store, reader, OPT_IN), {}, JSON.stringify(input));
    }
    assert.equal(fs.existsSync(path.join(store.baseDir, "handovers")), false);
  });
});

describe("Stop gate", () => {
  it("allows Stop when not opted in, even over soft", () => {
    const store = freshStore();
    const huge = rootExport({ usage: { input_tokens: 90000, output_tokens: 90000, total_tokens: 180000 } });
    assert.deepEqual(handleHook(stopPayload(), store, readerFor(huge), {}), {});
  });

  it("allows Stop once a handover is already stored", () => {
    const store = freshStore();
    store.saveHandover({
      sessionId: "s1",
      model: "unknown",
      handover: "h",
      summary: "s",
      diagnostics: { reason: "unknown", soft: 150000 },
    });
    const huge = rootExport({ usage: { input_tokens: 90000, output_tokens: 90000, total_tokens: 180000 } });
    assert.deepEqual(handleHook(stopPayload(), store, readerFor(huge), OPT_IN), {});
  });

  it("allows Stop when retained storage is unreadable", () => {
    const store = freshStore();
    fs.writeFileSync(path.join(store.baseDir, "handovers"), "not a directory");
    const over = rootExport({ usage: { total_tokens: 180000 } });
    assert.deepEqual(handleHook(stopPayload(), store, readerFor(over), OPT_IN), {});
  });

  it("reports malformed stdin as hook failure, never exit-2 policy denial", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "goose-hook-input-"));
    const result = spawnSync(process.execPath, [new URL("./hook.ts", import.meta.url).pathname], {
      input: "not json",
      encoding: "utf8",
      env: { ...process.env, HOME: home, AUTO_CONTEXT_HANDOVER_GOOSE_DATA: home },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stdin is not valid JSON/);
  });

  it("fails open on export errors, children, mismatched ids, and unknown usage", () => {
    const store = freshStore();
    const failing: SessionReader = () => {
      throw new Error("db locked");
    };
    assert.deepEqual(handleHook(stopPayload(), store, failing, OPT_IN), {});
    assert.deepEqual(
      handleHook(stopPayload(), store, readerFor(rootExport({ session_type: "sub_agent", parent_session_id: "p" })), OPT_IN),
      {},
    );
    assert.deepEqual(handleHook(stopPayload(), store, readerFor(rootExport({ id: "other" })), OPT_IN), {});
    assert.deepEqual(handleHook(stopPayload(), store, readerFor(rootExport({ usage: undefined })), OPT_IN), {});
    assert.deepEqual(handleHook(stopPayload("ghost"), store, readerFor(rootExport()), OPT_IN), {});
  });

  it("denies over-soft roots with a stage lead, tool names, and attribution", () => {
    const store = freshStore();
    const cases: Array<{ total: number; lead: string }> = [
      { total: 150000, lead: OPENCODE_WARN1 },
      { total: 165000, lead: OPENCODE_WARN2 },
      { total: 180000, lead: OPENCODE_WARN3 },
    ];
    for (const { total, lead } of cases) {
      const out = handleHook(
        stopPayload(),
        store,
        readerFor(rootExport({ usage: { input_tokens: total - 50, output_tokens: 50, total_tokens: total } })),
        OPT_IN,
      );
      assert.equal(out.decision, "block");
      const reason = String(out.reason);
      assert.ok(reason.includes(lead), `missing stage lead for ${total}`);
      assert.ok(reason.includes(TOOL_NAMES.handover));
      assert.ok(reason.includes(TOOL_NAMES.read));
      assert.ok(reason.includes(JSON.stringify("s1")));
      assert.ok(reason.includes("no automatic continuation") || reason.includes("manually"));
    }
  });

  it("stays quiet under soft and denies repeatedly without loop state", () => {
    const store = freshStore();
    const under = rootExport({ usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } });
    assert.deepEqual(handleHook(stopPayload(), store, readerFor(under), OPT_IN), {});
    const over = rootExport({ usage: { input_tokens: 150000, output_tokens: 1, total_tokens: 150001 } });
    const reader = readerFor(over);
    const first = handleHook(stopPayload(), store, reader, OPT_IN);
    const second = handleHook(stopPayload(), store, reader, OPT_IN);
    assert.equal(first.decision, "block");
    assert.equal(second.decision, "block");
    // No loop state is kept: still no handover stored after two denials.
    assert.equal(store.getHandover("s1"), undefined);
  });

  it("disables Stop notices on invalid soft instead of throwing", () => {
    const store = freshStore();
    const huge = rootExport({ usage: { input_tokens: 90000, output_tokens: 90000, total_tokens: 180000 } });
    const logged = captureStderr(() => {
      assert.deepEqual(handleHook(stopPayload(), store, readerFor(huge), { [SOFT_ENV]: "70%" }), {});
    });
    assert.match(logged, /AUTO_CONTEXT_HANDOVER_SOFT must be a positive integer/);
    // resolveSoft itself still rejects bad values for direct callers.
    assert.throws(() => resolveSoft({ [SOFT_ENV]: "70%" }), ConfigError);
  });
});
