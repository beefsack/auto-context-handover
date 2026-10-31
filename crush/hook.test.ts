import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { CrushApi } from "./client.ts";
import {
  ConfigError,
  DEFAULT_SOFT,
  handleHook,
  isSupportedCrushVersion,
  parseSoftSpec,
  resolveDataDir,
  resolveSocket,
  SUPPORTED_CRUSH_VERSION,
} from "./hook.ts";
import { CrushStore } from "./store.ts";
import { LAG_DISCLOSURE, TOOL_NAMES } from "./text.ts";

const SOFT_ENV = "AUTO_CONTEXT_HANDOVER_SOFT";

function freshStore(): CrushStore {
  return new CrushStore(fs.mkdtempSync(path.join(os.tmpdir(), "crush-hook-")));
}

function workspaceDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crush-ws-"));
}

function fakeApi(dir: string, overrides: Partial<CrushApi> = {}): CrushApi {
  return {
    getVersion: async () => ({ version: SUPPORTED_CRUSH_VERSION }),
    listWorkspaces: async () => [{ id: "ws-1", path: dir }],
    getSession: async () => ({ id: "ses-1", parent_session_id: "", prompt_tokens: 100, completion_tokens: 50 }),
    getAgent: async () => ({
      model: { id: "m1", context_window: 200000 },
      model_cfg: { provider: "p", model: "m" },
      is_ready: true,
    }),
    createSession: async () => {
      throw new Error("hook must never create sessions");
    },
    sendAgentPrompt: async () => {
      throw new Error("hook must never admit prompts");
    },
    ...overrides,
  };
}

function toolPayload(dir: string, toolName: string, toolInput: unknown = {}): Record<string, unknown> {
  return { event: "PreToolUse", session_id: "ses-1", cwd: dir, tool_name: toolName, tool_input: toolInput };
}

describe("config", () => {
  it("defaults soft to 200000 and accepts integers and percents", () => {
    assert.equal(DEFAULT_SOFT, 200000);
    assert.deepEqual(parseSoftSpec({}), { kind: "tokens", tokens: 200000 });
    assert.deepEqual(parseSoftSpec({ [SOFT_ENV]: "200000" }), { kind: "tokens", tokens: 200000 });
    assert.deepEqual(parseSoftSpec({ [SOFT_ENV]: "70%" }), { kind: "percent", ratio: 0.7 });
  });

  it("rejects invalid soft values before any store mutation", async () => {
    const store = freshStore();
    const dir = workspaceDir();
    for (const bad of ["abc", "0", "-5", "1.5", "", "150k", "0x10", "101%", "0%", "{}"]) {
      assert.throws(() => parseSoftSpec({ [SOFT_ENV]: bad }), ConfigError, bad);
      await assert.rejects(handleHook(toolPayload(dir, "bash"), store, fakeApi(dir), { [SOFT_ENV]: bad }), ConfigError);
    }
    assert.equal(fs.existsSync(path.join(store.baseDir, "pending")), false);
  });

  it("requires explicit absolute socket and data paths (no discovery)", () => {
    const abs = path.join(os.tmpdir(), "crush.sock");
    assert.equal(resolveSocket({ AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET: abs }), abs);
    assert.equal(resolveDataDir({ AUTO_CONTEXT_HANDOVER_DATA: abs }), abs);
    for (const bad of [undefined, "", "relative.sock", "crush.sock"]) {
      assert.throws(() => resolveSocket({ AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET: bad as string }), ConfigError);
      assert.throws(() => resolveDataDir({ AUTO_CONTEXT_HANDOVER_DATA: bad as string }), ConfigError);
    }
    assert.throws(() => resolveSocket({}), ConfigError);
    assert.throws(() => resolveDataDir({}), ConfigError);
  });
});

describe("strict input", () => {
  it("ignores non-PreToolUse input without I/O side effects", async () => {
    const store = freshStore();
    const dir = workspaceDir();
    const api = fakeApi(dir);
    for (const input of [
      null,
      "nope",
      {},
      { event: "SessionStart", session_id: "s", cwd: dir },
      { event: "PostToolUse", session_id: "s", cwd: dir },
      { hook_event_name: "TurnEnd", session_id: "s", cwd: dir },
      { event: "PreToolUse", cwd: dir },
      { event: "PreToolUse", session_id: "s" },
      { event: "PreToolUse", session_id: "", cwd: "" },
    ]) {
      assert.deepEqual(await handleHook(input, store, api, {}), {}, JSON.stringify(input));
    }
    assert.equal(fs.existsSync(path.join(store.baseDir, "pending")), false);
  });

  it("accepts the Claude-style hook_event_name alias", async () => {
    const store = freshStore();
    const dir = workspaceDir();
    const out = await handleHook(
      { hook_event_name: "PreToolUse", session_id: "ses-1", cwd: dir, tool_name: TOOL_NAMES.handover, tool_input: { handover: "h", summary: "s" } },
      store,
      fakeApi(dir, { getSession: async () => ({ id: "ses-1", parent_session_id: "", prompt_tokens: 1, completion_tokens: 1 }) }),
      {},
    );
    assert.match((out.updated_input as { capability: string }).capability, /^[0-9a-f]{64}$/);
  });
});

describe("thresholds and nudges", () => {
  const env = { [SOFT_ENV]: "1000" };

  function countersApi(dir: string, prompt: number, completion: number): CrushApi {
    return fakeApi(dir, {
      getSession: async () => ({ id: "ses-1", parent_session_id: "", prompt_tokens: prompt, completion_tokens: completion }),
    });
  }

  it("stays silent below soft and advises at fixed boundaries", async () => {
    const dir = workspaceDir();
    assert.deepEqual(await handleHook(toolPayload(dir, "bash"), freshStore(), countersApi(dir, 900, 99), env), {});
    for (const [total, lead] of [[1000, "Context is filling"], [1100, "Wrap up now"], [1200, "Stop after this step"]] as const) {
      const store = freshStore();
      const out = await handleHook(toolPayload(dir, "bash"), store, countersApi(dir, total - 1, 1), env);
      const context = (out as { context: string }).context;
      assert.ok(context.includes(lead), `${total}: ${context}`);
      assert.ok(context.includes(`Diagnostics: estimated-context-tokens=${total}, soft-limit=1000.`), context);
      assert.ok(context.includes(LAG_DISCLOSURE), "lag labeling");
      assert.ok(context.includes("installed workflow intro"), "installed intro reference");
      assert.ok(context.includes("replaces any required final report"), "final-report replacement");
      assert.ok(context.includes("writes only plugin storage"), "read-only storage permission");
      assert.ok(context.includes(TOOL_NAMES.handover), context);
      assert.ok(context.includes("only after this nudge or an explicit handover request"), context);
      assert.equal((out as { decision?: unknown }).decision, undefined, "never a permission decision");
      assert.equal(fs.existsSync(path.join(store.baseDir, "pending")), false, "advisory mints no capability");
    }
  });

  it("caps integer soft at 70% of the known window", async () => {
    const dir = workspaceDir();
    // soft 200000 capped to 70000 by the 100000-token window.
    const api = fakeApi(dir, {
      getAgent: async () => ({ model: { id: "m", context_window: 100000 } }),
      getSession: async () => ({ id: "ses-1", parent_session_id: "", prompt_tokens: 69999, completion_tokens: 1 }),
    });
    const out = await handleHook(toolPayload(dir, "bash"), freshStore(), api, {});
    assert.ok((out as { context: string }).context.includes("soft-limit=70000"));
  });

  it("resolves percents only against a known window", async () => {
    const dir = workspaceDir();
    // 50% of 200000 = 100000; estimate 150 stays silent.
    const out = await handleHook(toolPayload(dir, "bash"), freshStore(), fakeApi(dir), { [SOFT_ENV]: "50%" });
    assert.deepEqual(out, {});
    const over = await handleHook(
      toolPayload(dir, "bash"),
      freshStore(),
      countersApi(dir, 99999, 1),
      { [SOFT_ENV]: "50%" },
    );
    assert.ok((over as { context: string }).context.includes("soft-limit=100000"));
  });

  it("leaves percent soft unknown when the window is unknown: ordinary silent, own tools still bind", async () => {
    const dir = workspaceDir();
    const unknownWindow = fakeApi(dir, {
      getAgent: async () => {
        throw new Error("agent unknown");
      },
      getSession: async () => ({ id: "ses-1", parent_session_id: "", prompt_tokens: 10 ** 9, completion_tokens: 0 }),
    });
    const ordinaryStore = freshStore();
    const ordinaryOut = await handleHook(toolPayload(dir, "bash"), ordinaryStore, unknownWindow, {
      [SOFT_ENV]: "50%",
    });
    assert.deepEqual(ordinaryOut, {}, "ordinary");
    assert.equal(fs.existsSync(path.join(ordinaryStore.baseDir, "pending")), false, "ordinary");
    for (const tool of [TOOL_NAMES.handover, TOOL_NAMES.read]) {
      const store = freshStore();
      const out = await handleHook(toolPayload(dir, tool, { handover: "h", summary: "s", sessionID: "ses-1" }), store, unknownWindow, {
        [SOFT_ENV]: "50%",
      });
      const cap = (out as { updated_input?: { capability: string } }).updated_input?.capability;
      assert.match(cap ?? "", /^[0-9a-f]{64}$/, tool);
      const pending = store.consumePending(cap!);
      const diag = pending.diagnostics as { reason?: unknown; soft?: unknown; estimatedTokens?: unknown };
      assert.equal(diag.reason, "unknown", tool);
      assert.equal(diag.soft, undefined, `${tool} soft stays unknown`);
      assert.equal(diag.estimatedTokens, 10 ** 9, tool);
    }
  });

  it("treats zero, missing, unsafe, and negative counters as unknown", async () => {
    const dir = workspaceDir();
    for (const [name, prompt, completion] of [
      ["zero", 0, 0],
      ["missing", NaN, NaN],
      ["negative", -1, 5],
      ["unsafe", Number.MAX_SAFE_INTEGER, 1],
    ] as const) {
      const store = freshStore();
      const out = await handleHook(toolPayload(dir, "bash"), store, countersApi(dir, prompt, completion), { [SOFT_ENV]: "1" });
      assert.deepEqual(out, {}, name);
      assert.equal(fs.existsSync(path.join(store.baseDir, "pending")), false, name);
    }
  });

  it("fails open on version mismatch, workspace mismatch, non-roots, and API errors", async () => {
    const dir = workspaceDir();
    const other = workspaceDir();
    const loud: CrushApi = fakeApi(dir, {
      getSession: async () => ({ id: "ses-1", parent_session_id: "", prompt_tokens: 10 ** 9, completion_tokens: 0 }),
    });
    // Version outside the stable major-0 guard (nightly or anything not a stable 0.x.y release).
    assert.deepEqual(await handleHook(toolPayload(dir, "bash"), freshStore(), fakeApi(dir, { getVersion: async () => ({ version: "nightly" }) }), {}), {});
    // Workspace mismatch: cwd is not a known workspace path.
    assert.deepEqual(await handleHook(toolPayload(other, "bash"), freshStore(), loud, {}), {});
    // Non-root session: parent id nonempty.
    const child = fakeApi(dir, {
      getSession: async () => ({ id: "ses-1", parent_session_id: "parent-1", prompt_tokens: 10 ** 9, completion_tokens: 0 }),
    });
    assert.deepEqual(await handleHook(toolPayload(dir, "bash"), freshStore(), child, {}), {});
    // API down.
    const down: CrushApi = {
      ...loud,
      getVersion: async () => {
        throw new Error("socket gone");
      },
    };
    assert.deepEqual(await handleHook(toolPayload(dir, "bash"), freshStore(), down, {}), {});
  });
});

describe("version guard", () => {
  it("accepts the assessed version and newer stable patch/minor releases", () => {
    for (const version of ["v0.98.2", "v0.98.3", "v0.99.0", "v0.100.10", "0.98.2"]) {
      assert.equal(isSupportedCrushVersion(version), true, version);
    }
  });

  it("rejects malformed, missing, nightly, and different-major versions", () => {
    for (const version of [
      "nightly",
      "v0.98.3-nightly",
      "v0.98.3-0.20261027134723-3538c722ffce",
      "v1.0.0",
      "1.2.3",
      "v0.98",
      "v0.98.2.1",
      "",
      undefined,
      null,
      42,
    ]) {
      assert.equal(isSupportedCrushVersion(version), false, String(version));
    }
  });

  it("binds newer stable releases and still refuses nightly/major bumps", async () => {
    const dir = workspaceDir();
    const loud = (version: string): CrushApi =>
      fakeApi(dir, {
        getVersion: async () => ({ version }),
        getSession: async () => ({ id: "ses-1", parent_session_id: "", prompt_tokens: 10 ** 9, completion_tokens: 0 }),
      });
    for (const version of ["v0.98.3", "v0.99.0"]) {
      const out = await handleHook(toolPayload(dir, "bash"), freshStore(), loud(version), {});
      assert.ok((out as { context: string }).context.includes("soft-limit="), version);
      const store = freshStore();
      const read = await handleHook(toolPayload(dir, TOOL_NAMES.read, { sessionID: "x" }), store, loud(version), {});
      const pending = store.consumePending((read.updated_input as { capability: string }).capability);
      assert.equal(pending.tool, "read_handover", version);
      assert.equal(pending.caller.sessionId, "ses-1", version);
    }
    for (const version of ["v0.98.3-nightly", "v1.0.0", "nightly"]) {
      assert.deepEqual(await handleHook(toolPayload(dir, "bash"), freshStore(), loud(version), {}), {}, version);
      assert.deepEqual(
        await handleHook(toolPayload(dir, TOOL_NAMES.read, { sessionID: "x" }), freshStore(), loud(version), {}),
        {},
        version,
      );
    }
  });
});

describe("own-tool binding", () => {
  it("binds host session/workspace/model and stores exact original args", async () => {
    const store = freshStore();
    const dir = workspaceDir();
    const spoof = { handover: "h", summary: "s", capability: "evil", sessionID: "spoof", session_id: "spoof" };
    const out = await handleHook(toolPayload(dir, TOOL_NAMES.handover, spoof), store, countersApi(dir, 1199, 1), { [SOFT_ENV]: "1000" });
    const cap = (out.updated_input as { capability: string }).capability;
    assert.match(cap, /^[0-9a-f]{64}$/);
    assert.equal((out as { decision?: unknown }).decision, undefined, "binding never pre-approves");
    const pending = store.consumePending(cap);
    assert.equal(pending.tool, "context_handover");
    // Spoofed model fields stay data; identity comes from the host payload.
    assert.deepEqual(pending.caller, { sessionId: "ses-1", workspaceId: "ws-1", model: "p/m" });
    assert.deepEqual(pending.args, spoof);
    // warn3 maps to diagnostics final; reason is always unknown (no persistence feature).
    assert.deepEqual(pending.diagnostics, { reason: "unknown", stage: "final", estimatedTokens: 1200, soft: 1000 });
  });

  function countersApi(dir: string, prompt: number, completion: number): CrushApi {
    return fakeApi(dir, {
      getSession: async () => ({ id: "ses-1", parent_session_id: "", prompt_tokens: prompt, completion_tokens: completion }),
    });
  }

  it("binds the reader and preserves known estimates with reason unknown", async () => {
    const store = freshStore();
    const dir = workspaceDir();
    const out = await handleHook(toolPayload(dir, TOOL_NAMES.read, { sessionID: "ses-1" }), store, countersApi(dir, 0, 0), {});
    const cap = (out.updated_input as { capability: string }).capability;
    const pending = store.consumePending(cap);
    assert.equal(pending.tool, "read_handover");
    // Default 200000 capped at 70% of the known 200000 window; unknown estimate omits tokens/stage.
    assert.deepEqual(pending.diagnostics, { reason: "unknown", soft: 140000 });
    const known = freshStore();
    const outKnown = await handleHook(toolPayload(dir, TOOL_NAMES.read, { sessionID: "ses-1" }), known, countersApi(dir, 10, 5), {});
    const pendingKnown = known.consumePending((outKnown.updated_input as { capability: string }).capability);
    assert.deepEqual(pendingKnown.diagnostics, { reason: "unknown", estimatedTokens: 15, soft: 140000 });
  });

  it("refuses to bind without a workspace match, for non-roots, or on version mismatch", async () => {
    const dir = workspaceDir();
    const other = workspaceDir();
    const rich = countersApi(dir, 10 ** 9, 0);
    // Workspace mismatch.
    assert.deepEqual(await handleHook(toolPayload(other, TOOL_NAMES.handover, { handover: "h", summary: "s" }), freshStore(), rich, {}), {});
    // Non-root.
    const child = fakeApi(dir, {
      getSession: async () => ({ id: "ses-1", parent_session_id: "p", prompt_tokens: 10 ** 9, completion_tokens: 0 }),
    });
    assert.deepEqual(await handleHook(toolPayload(dir, TOOL_NAMES.handover, { handover: "h", summary: "s" }), freshStore(), child, {}), {});
    // Version mismatch.
    const nightly = fakeApi(dir, { getVersion: async () => ({ version: "v0.98.3-nightly" }) });
    assert.deepEqual(await handleHook(toolPayload(dir, TOOL_NAMES.read, { sessionID: "x" }), freshStore(), nightly, {}), {});
  });

  it("ordinary tools never mint capabilities", async () => {
    const store = freshStore();
    const dir = workspaceDir();
    const out = await handleHook(toolPayload(dir, "bash"), store, countersApi(dir, 10 ** 9, 0), {});
    assert.equal((out as { updated_input?: unknown }).updated_input, undefined);
    assert.equal(fs.existsSync(path.join(store.baseDir, "pending")), false);
  });
});

describe("closed sources", () => {
  it("denies and halts every tool with an explicit refusal naming the successor", async () => {
    const store = freshStore();
    const dir = workspaceDir();
    store.saveHandover({
      sessionId: "ses-1",
      workspaceId: "ws-1",
      model: "p/m",
      handover: "body",
      summary: "summary",
      closed: true,
      diagnostics: { reason: "unknown", stage: "warn1", estimatedTokens: 1, soft: 1 },
    });
    store.updateStatus("ses-1", { successorId: "ses-new-1", admitted: true });
    const api = fakeApi(dir);
    for (const tool of ["bash", TOOL_NAMES.handover, TOOL_NAMES.read]) {
      const out = await handleHook(toolPayload(dir, tool), store, api, {});
      assert.equal(out.decision, "deny", tool);
      assert.equal(out.halt, true, tool);
      assert.match(String(out.reason), /locked after a context handover/, tool);
      assert.ok(String(out.reason).includes("ses-new-1"), tool);
      assert.ok(String(out.reason).includes("tool backstop only"), tool);
      assert.ok(String(out.reason).includes("fresh live root"), tool);
      assert.equal((out as { updated_input?: unknown }).updated_input, undefined, tool);
    }
    assert.equal(fs.existsSync(path.join(store.baseDir, "pending")), false);
  });

  it("names an unknown successor when bookkeeping is missing", async () => {
    const store = freshStore();
    const dir = workspaceDir();
    store.saveHandover({
      sessionId: "ses-1",
      workspaceId: "ws-1",
      model: "unknown",
      handover: "body",
      summary: "summary",
      closed: true,
      diagnostics: { reason: "not-nudged", soft: 1 },
    });
    const out = await handleHook(toolPayload(dir, "bash"), store, fakeApi(dir), {});
    assert.ok(String(out.reason).includes("unknown"));
  });
});

describe("symlink entrypoint", () => {
  it("runs through a symlinked path with spaces (missing env fails, not silent exit 0)", () => {
    const realHook = fileURLToPath(new URL("./hook.ts", import.meta.url));
    const spaced = fs.mkdtempSync(path.join(os.tmpdir(), "crush root with spaces-"));
    const linkDir = path.join(spaced, "linked root");
    fs.mkdirSync(linkDir, { recursive: true });
    const linkHook = path.join(linkDir, "hook.ts");
    try {
      fs.symlinkSync(realHook, linkHook);
    } catch {
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crush-home-"));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, ".local/share"), XDG_CONFIG_HOME: path.join(home, ".config") };
    for (const key of ["AUTO_CONTEXT_HANDOVER_DATA", "AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET", "CRUSH_PROJECT_DIR"]) {
      delete env[key];
    }
    const result = spawnSync(process.execPath, [linkHook], { input: "{}", encoding: "utf8", env });
    assert.notEqual(result.status, 0, `symlinked hook must not exit 0 silently; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.ok(String(result.stderr).length > 0, "missing env must produce stderr");
  });
});
