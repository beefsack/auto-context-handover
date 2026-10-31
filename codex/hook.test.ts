import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CodexStore, type HandoverRecord } from "./store.ts";
import { ConfigError, DEFAULT_SOFT, handleHook, resolveSoft } from "./hook.ts";
import {
  buildNotice,
  CHILD_INTRO,
  lockedReply,
  readInvocation,
  ROOT_INTRO,
  shortReply,
  TOOL_NAMES,
} from "./text.ts";
import { openCodeStageText } from "../source/shared/handover-text.ts";

const SOFT_ENV = "AUTO_CONTEXT_HANDOVER_SOFT";

function freshStore(): CodexStore {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  return new CodexStore(fs.mkdtempSync(path.join("/tmp/opencode", "codex-hook-")));
}

function record(childId: string, overrides: Partial<HandoverRecord> = {}): HandoverRecord {
  return {
    childId,
    parentSessionId: "ses-parent",
    agentType: "explore",
    model: "openai/gpt-5",
    handover: "body",
    summary: "did things",
    closed: true,
    diagnostics: { reason: "nudged", stage: "warn1", soft: 150000 },
    ...overrides,
  };
}

function postModel(childId: string, usage: unknown, status = "completed"): Record<string, unknown> {
  return {
    hook_event_name: "PostModelRequest",
    session_id: "ses-parent",
    turn_id: "t1",
    agent_id: childId,
    agent_type: "explore",
    model: "openai/gpt-5",
    status,
    token_usage: usage,
  };
}

function postTool(childId: string, toolName = "shell"): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    session_id: "ses-parent",
    turn_id: "t1",
    agent_id: childId,
    agent_type: "explore",
    model: "openai/gpt-5",
    tool_name: toolName,
    tool_input: { command: "ls" },
    tool_response: { ok: true },
  };
}

describe("config", () => {
  it("defaults to 200000 and accepts positive integers", () => {
    assert.equal(resolveSoft({}), DEFAULT_SOFT);
    assert.equal(DEFAULT_SOFT, 200000);
    assert.equal(resolveSoft({ [SOFT_ENV]: "200000" }), 200000);
  });

  it("rejects invalid soft values with no store mutation", () => {
    const store = freshStore();
    for (const bad of ["abc", "0", "-5", "1.5", "", "  ", "150k", "0x10"]) {
      assert.throws(() => resolveSoft({ [SOFT_ENV]: bad }), ConfigError);
      assert.throws(
        () => handleHook(postModel("c1", { input_tokens: 10, output_tokens: 10 }), store, { [SOFT_ENV]: bad }),
        /AUTO_CONTEXT_HANDOVER_SOFT/,
      );
    }
    assert.equal(store.getObservation("c1"), undefined);
  });
});

describe("intros", () => {
  it("SessionStart returns the exact root intro", () => {
    const out = handleHook(
      { hook_event_name: "SessionStart", session_id: "s", model: "m" },
      freshStore(),
      {},
    );
    assert.deepEqual(out, {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ROOT_INTRO },
    });
    assert.match(ROOT_INTRO, /same logical subagent/);
  });

  it("SubagentStart returns the exact child intro and resets the observation", () => {
    const store = freshStore();
    store.setObservation("kid", { soft: 1, estimatedTokens: 2, nudged: true });
    const out = handleHook(
      { hook_event_name: "SubagentStart", session_id: "s", turn_id: "t", agent_id: "kid", agent_type: "a" },
      store,
      {},
    );
    assert.deepEqual(out, {
      hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: CHILD_INTRO },
    });
    assert.equal(store.getObservation("kid"), undefined);
    assert.match(CHILD_INTRO, new RegExp(TOOL_NAMES.handover.replace(/[__]/g, ".")));
  });

  it("SubagentStart for a closed child returns locked guidance", () => {
    const store = freshStore();
    const rec = record("kid");
    store.saveHandover(rec);
    const out = handleHook(
      { hook_event_name: "SubagentStart", session_id: "s", turn_id: "t", agent_id: "kid", agent_type: "a" },
      store,
      {},
    );
    assert.deepEqual(out, {
      hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: lockedReply(rec) },
    });
  });
});

describe("measurement", () => {
  it("ignores roots", () => {
    const store = freshStore();
    const out = handleHook(
      { ...postModel("kid", { input_tokens: 5, output_tokens: 5 }), agent_id: undefined },
      store,
      {},
    );
    assert.deepEqual(out, {});
    assert.equal(fs.existsSync(path.join(store.baseDir, "observations")), false);
  });

  it("adds only input+output; cached and reasoning are subsets", () => {
    const store = freshStore();
    handleHook(
      postModel("kid", {
        input_tokens: 100,
        output_tokens: 50,
        cached_input_tokens: 100,
        reasoning_output_tokens: 50,
        total_tokens: 9999,
      }),
      store,
      {},
    );
    assert.equal(store.getObservation("kid")?.estimatedTokens, 150);
  });

  it("treats missing, zero, invalid, and non-completed usage as unknown", () => {
    for (const [name, usage, status] of [
      ["missing output", { input_tokens: 10 }, "completed"],
      ["missing input", { output_tokens: 10 }, "completed"],
      ["all zero", { input_tokens: 0, output_tokens: 0 }, "completed"],
      ["negative", { input_tokens: -1, output_tokens: 5 }, "completed"],
      ["string", { input_tokens: "10", output_tokens: 5 }, "completed"],
      ["float", { input_tokens: 1.5, output_tokens: 5 }, "completed"],
      ["failed", { input_tokens: 10, output_tokens: 10 }, "failed"],
      ["cancelled", { input_tokens: 10, output_tokens: 10 }, "cancelled"],
      ["null usage", null, "completed"],
    ] as const) {
      const store = freshStore();
      handleHook(postModel("kid", usage, status), store, {});
      assert.equal(store.getObservation("kid")?.estimatedTokens, undefined, name);
      assert.equal(store.getObservation("kid")?.soft, DEFAULT_SOFT, name);
    }
  });

  it("preserves nudge provenance across response observations", () => {
    const store = freshStore();
    store.setObservation("kid", { soft: 1000, estimatedTokens: 1000, nudged: true });
    handleHook(postModel("kid", { input_tokens: 10, output_tokens: 5 }), store, {
      [SOFT_ENV]: "1000",
    });
    assert.deepEqual(store.getObservation("kid"), { soft: 1000, estimatedTokens: 15, nudged: true });
  });
});

describe("stages and notices", () => {
  const env = { [SOFT_ENV]: "1000" };

  function observedAt(estimate: number): CodexStore {
    const store = freshStore();
    handleHook(postModel("kid", { input_tokens: estimate - 1, output_tokens: 1 }), store, env);
    return store;
  }

  it("emits staged notices only via PostToolUse at fixed boundaries", () => {
    const below = observedAt(999);
    assert.deepEqual(handleHook(postTool("kid"), below, env), {});
    for (const [estimate, stage] of [[1000, "warn1"], [1100, "warn2"], [1200, "warn3"]] as const) {
      const store = observedAt(estimate);
      const out = handleHook(postTool("kid"), store, env);
      assert.deepEqual(out, {
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: buildNotice(stage) },
      });
      assert.ok((out.hookSpecificOutput as { additionalContext: string }).additionalContext.startsWith(
        `As installed at session start: ${openCodeStageText(stage)}`,
      ));
      assert.equal(store.getObservation("kid")?.nudged, true);
    }
  });

  it("maps warn3 to diagnostics final and keeps unknowns unknown", () => {
    const store = observedAt(1200);
    assert.ok((handleHook(postTool("kid"), store, env).hookSpecificOutput as object) !== undefined);
    const out = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "ses-parent",
        turn_id: "t",
        agent_id: "kid",
        agent_type: "explore",
        model: "openai/gpt-5",
        tool_name: TOOL_NAMES.handover,
        tool_input: { handover: "h", summary: "s" },
        tool_use_id: "u1",
      },
      store,
      env,
    );
    const specific = out.hookSpecificOutput as { permissionDecision: string; updatedInput: { capability: string } };
    assert.equal(specific.permissionDecision, "allow");
    assert.match(specific.updatedInput.capability, /^[0-9a-f]{64}$/);
    assert.deepEqual(store.consumePending(specific.updatedInput.capability).diagnostics, {
      reason: "nudged",
      stage: "final",
      estimatedTokens: 1200,
      soft: 1000,
    });

    const unknown = freshStore();
    unknown.setObservation("kid", { soft: 1000 });
    const out2 = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "ses-parent",
        turn_id: "t",
        agent_id: "kid",
        tool_name: TOOL_NAMES.handover,
        tool_input: { handover: "h", summary: "s" },
        tool_use_id: "u2",
      },
      unknown,
      env,
    );
    const cap = (out2.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    assert.deepEqual(unknown.consumePending(cap).diagnostics, { reason: "not-nudged", soft: 1000 });
  });

  it("never nudges after a stored handover", () => {
    const store = observedAt(1200);
    store.saveHandover(record("kid"));
    assert.deepEqual(handleHook(postTool("kid"), store, env), {});
  });

  it("skips notices for own tools and PreToolUse ordinary tools", () => {
    const store = observedAt(1200);
    assert.deepEqual(handleHook(postTool("kid", TOOL_NAMES.handover), store, env), {});
    assert.deepEqual(handleHook(postTool("kid", TOOL_NAMES.read), store, env), {});
    assert.deepEqual(
      handleHook(
        {
          hook_event_name: "PreToolUse",
          session_id: "s",
          turn_id: "t",
          agent_id: "kid",
          tool_name: "shell",
          tool_input: {},
          tool_use_id: "u",
        },
        store,
        env,
      ),
      {},
    );
  });
});

describe("binding", () => {
  it("binds host identity; spoofed model args stay data, capability is generated", () => {
    const store = freshStore();
    store.setObservation("real-child", { soft: 1000, estimatedTokens: 1000 });
    const spoof = { handover: "h", summary: "s", capability: "evil", childId: "spoof", sessionID: "spoof" };
    const out = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "ses-live",
        turn_id: "t",
        agent_id: "real-child",
        agent_type: "explore",
        model: "openai/gpt-5",
        tool_name: TOOL_NAMES.handover,
        tool_input: spoof,
        tool_use_id: "u",
      },
      store,
      { [SOFT_ENV]: "1000" },
    );
    const cap = (out.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    const pending = store.consumePending(cap);
    assert.equal(pending.tool, "context_handover");
    assert.deepEqual(pending.caller, {
      sessionId: "ses-live",
      childId: "real-child",
      agentType: "explore",
      model: "openai/gpt-5",
    });
    assert.deepEqual(pending.args, spoof);
  });

  it("binds the read tool with childId and full flag schema", () => {
    const store = freshStore();
    const out = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "s",
        turn_id: "t",
        agent_id: "kid",
        tool_name: TOOL_NAMES.read,
        tool_input: { childId: "kid", full: true },
        tool_use_id: "u",
      },
      store,
      {},
    );
    const cap = (out.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    assert.equal(store.consumePending(cap).tool, "read_handover");
  });

  it("roots receive no capability for ordinary tools", async () => {
    const store = freshStore();
    const out = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "s",
        turn_id: "t",
        tool_name: "shell",
        tool_input: {},
        tool_use_id: "u",
      },
      store,
      {},
    );
    assert.deepEqual(out, {});
    assert.equal(fs.existsSync(path.join(store.baseDir, "pending")), false);
  });

  it("roots bind own tools with a session-only caller", async () => {
    const store = freshStore();
    const out = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "ses-parent",
        turn_id: "t",
        tool_name: TOOL_NAMES.read,
        tool_input: { childId: "kid", full: true },
        tool_use_id: "u",
      },
      store,
      {},
    );
    const cap = (out.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    assert.match(cap, /^[0-9a-f]{64}$/);
    assert.deepEqual(store.consumePending(cap).caller, { sessionId: "ses-parent" });
  });

  it("storage failure throws and exposes no capability", () => {
    const store = freshStore();
    fs.writeFileSync(path.join(store.baseDir, "pending"), "blocker");
    assert.throws(
      () =>
        handleHook(
          {
            hook_event_name: "PreToolUse",
            session_id: "s",
            turn_id: "t",
            agent_id: "kid",
            tool_name: TOOL_NAMES.handover,
            tool_input: { handover: "h", summary: "s" },
            tool_use_id: "u",
          },
          store,
          {},
        ),
      /blocker|ENOTDIR|EEXIST/,
    );
  });
});

describe("closed children", () => {
  it("denies ordinary tools and the reader with an explicit locked message", () => {
    const store = freshStore();
    store.saveHandover(record("kid"));
    for (const tool of ["shell", TOOL_NAMES.read, TOOL_NAMES.handover]) {
      const out = handleHook(
        {
          hook_event_name: "PreToolUse",
          session_id: "s",
          turn_id: "t",
          agent_id: "kid",
          tool_name: tool,
          tool_input: {},
          tool_use_id: "u",
        },
        store,
        {},
      );
      const specific = out.hookSpecificOutput as {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
      assert.equal(specific.permissionDecision, "deny", tool);
      assert.match(specific.permissionDecisionReason, /locked after a context handover/);
      assert.ok(specific.permissionDecisionReason.includes(readInvocation("kid", true)), tool);
      assert.equal(specific.permissionDecisionReason.includes("capability"), false);
    }
  });
});

describe("compaction", () => {
  it("clears stale anchors with no control effects", () => {
    const store = freshStore();
    store.setObservation("kid", { soft: 1, estimatedTokens: 2, nudged: true });
    for (const event of ["PreCompact", "PostCompact"]) {
      const out = handleHook(
        { hook_event_name: event, session_id: "s", turn_id: "t", agent_id: "kid", agent_type: "a" },
        store,
        {},
      );
      assert.deepEqual(out, {});
    }
    assert.equal(store.getObservation("kid"), undefined);
    assert.deepEqual(
      handleHook({ hook_event_name: "PreCompact", session_id: "s", turn_id: "t" }, freshStore(), {}),
      {},
    );
  });
});

describe("stop shaping", () => {
  it("blocks once with the exact short reply, then never reblocks", () => {
    const store = freshStore();
    const rec = record("kid", { summary: "did things" });
    store.saveHandover(rec);
    const expected = shortReply(rec);
    const base = {
      hook_event_name: "SubagentStop",
      session_id: "s",
      turn_id: "t",
      agent_id: "kid",
      agent_type: "explore",
      agent_transcript_path: null,
    };
    assert.deepEqual(
      handleHook({ ...base, stop_hook_active: false, last_assistant_message: "something else" }, store, {}),
      { decision: "block", reason: expected },
    );
    assert.deepEqual(
      handleHook({ ...base, stop_hook_active: false, last_assistant_message: expected }, store, {}),
      {},
    );
    assert.deepEqual(
      handleHook({ ...base, stop_hook_active: true, last_assistant_message: "something else" }, store, {}),
      {},
    );
  });

  it("ignores open children and unknown events", () => {
    const store = freshStore();
    assert.deepEqual(
      handleHook(
        {
          hook_event_name: "SubagentStop",
          session_id: "s",
          turn_id: "t",
          agent_id: "kid",
          agent_type: "a",
          stop_hook_active: false,
          last_assistant_message: "done",
        },
        store,
        {},
      ),
      {},
    );
    assert.deepEqual(handleHook({ hook_event_name: "UserPromptSubmit" }, store, {}), {});
    assert.deepEqual(handleHook(null, store, {}), {});
  });
});
