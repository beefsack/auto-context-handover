import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CodexStore as QwenStore, type HandoverRecord } from "../codex/store.ts";
import {
  baseDirFromEnv,
  childJsonlPath,
  childKey,
  DEFAULT_SOFT,
  handleHook,
  measureChild,
  resolveSoft,
  TOOL_NAMES,
} from "./hook.ts";
import {
  buildNotice,
  CHILD_INTRO,
  lockedReply,
  readInvocation,
  ROOT_INTRO,
  shortReply,
} from "./text.ts";
import { openCodeStageText } from "../source/shared/handover-text.ts";

const SOFT_ENV = "AUTO_CONTEXT_HANDOVER_SOFT";

function freshStore(): QwenStore {
  return new QwenStore(fs.mkdtempSync(path.join(os.tmpdir(), "qwen-hook-")));
}

/** Project fixture: returns hook-input path fields plus the child file. */
function freshProject(sessionId = "ses-parent", agentId = "agent-1a"): {
  dir: string;
  transcriptPath: string;
  sessionId: string;
  agentId: string;
  key: string;
  childFile: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-proj-"));
  const transcriptPath = path.join(dir, "chats", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, "");
  const childFile = path.join(dir, "subagents", sessionId, `agent-${agentId}.jsonl`);
  return { dir, transcriptPath, sessionId, agentId, key: childKey(sessionId, agentId), childFile };
}

function assistantRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: "u1",
    parentUuid: null,
    sessionId: "ses-parent",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "assistant",
    message: { role: "model", parts: [{ text: "working" }] },
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    agentId: "agent-1a",
    isSidechain: true,
    agentRunId: "run-1",
    agentRound: 1,
    ...overrides,
  };
}

function appendRecords(childFile: string, records: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(childFile), { recursive: true });
  for (const record of records) {
    fs.appendFileSync(childFile, `${JSON.stringify(record)}\n`);
  }
}

function record(key: string, overrides: Partial<HandoverRecord> = {}): HandoverRecord {
  return {
    childId: key,
    parentSessionId: "ses-parent",
    agentType: "unknown",
    model: "unknown",
    handover: "body",
    summary: "did things",
    closed: true,
    diagnostics: { reason: "nudged", stage: "warn1", soft: 150000 },
    ...overrides,
  };
}

function preTool(
  proj: { transcriptPath: string; sessionId: string; agentId: string },
  toolName: string,
  toolInput: unknown = {},
): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    session_id: proj.sessionId,
    transcript_path: proj.transcriptPath,
    cwd: "/tmp",
    agent_id: proj.agentId,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "u1",
  };
}

describe("config", () => {
  it("defaults to 150000 and accepts positive integers uncapped", () => {
    assert.equal(resolveSoft({}), DEFAULT_SOFT);
    assert.equal(DEFAULT_SOFT, 150000);
    assert.equal(resolveSoft({ [SOFT_ENV]: "200000" }), 200000);
  });

  it("invalid soft disables notices without throwing or mutating", () => {
    const store = freshStore();
    for (const bad of ["abc", "0", "-5", "1.5", "", "150k", "70%"]) {
      assert.equal(resolveSoft({ [SOFT_ENV]: bad }), undefined);
      const out = handleHook(
        { hook_event_name: "PostToolUse", session_id: "s", agent_id: "a", tool_name: "shell", tool_response: {} },
        store,
        { [SOFT_ENV]: bad },
      );
      assert.deepEqual(out, {});
    }
    assert.equal(fs.existsSync(path.join(store.baseDir, "observations")), false);
  });

  it("resolves the HOME-based data dir", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-home-"));
    assert.equal(baseDirFromEnv({ HOME: home }), path.join(home, ".qwen", "auto-context-handover"));
  });
});

describe("child path", () => {
  it("derives the exact child path from the root transcript path", () => {
    const proj = freshProject();
    assert.equal(
      childJsonlPath({ transcript_path: proj.transcriptPath, session_id: "ses-parent", agent_id: "agent-1a" }),
      proj.childFile,
    );
  });

  it("refuses roots, unsafe ids, and unexpected layouts", () => {
    const proj = freshProject();
    assert.equal(childJsonlPath({ transcript_path: proj.transcriptPath, session_id: "ses-parent" }), undefined);
    assert.equal(
      childJsonlPath({ transcript_path: proj.transcriptPath, session_id: "ses;parent", agent_id: "agent-1a" }),
      undefined,
    );
    assert.equal(
      childJsonlPath({ transcript_path: proj.transcriptPath, session_id: "ses-parent", agent_id: "../x" }),
      undefined,
    );
    assert.equal(
      childJsonlPath({ transcript_path: "/tmp/other.jsonl", session_id: "ses-parent", agent_id: "agent-1a" }),
      undefined,
    );
    assert.equal(
      childJsonlPath({
        transcript_path: proj.transcriptPath.replace("/chats/", "/other/"),
        session_id: "ses-parent",
        agent_id: "agent-1a",
      }),
      undefined,
    );
  });
});

describe("measurement", () => {
  it("reads the latest per-response prompt+candidates usage", () => {
    const proj = freshProject();
    appendRecords(proj.childFile, [
      assistantRecord({ uuid: "u1", agentRound: 1, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }),
      assistantRecord({ uuid: "u2", agentRound: 2, usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 100 } }),
    ]);
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), 1000);
  });

  it("ignores other sessions, agents, non-assistant types, and non-round records", () => {
    const proj = freshProject();
    appendRecords(proj.childFile, [
      assistantRecord({ uuid: "u1", agentRound: 1, usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 100 } }),
      { ...assistantRecord({ uuid: "u2", agentRound: 2 }), sessionId: "other", usageMetadata: undefined },
      { ...assistantRecord({ uuid: "u3", agentRound: 3 }), agentId: "other-agent", usageMetadata: undefined },
      { ...assistantRecord({ uuid: "u4" }), type: "tool_result" },
      { uuid: "u5", sessionId: "ses-parent", type: "assistant", agentId: "agent-1a" },
      assistantRecord({ uuid: "u6", agentRound: 4, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
    ]);
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), 15);
  });

  it("treats usage-bearing foreign records as unknown, not ignored", () => {
    const proj = freshProject();
    appendRecords(proj.childFile, [
      assistantRecord({ uuid: "u1", agentRound: 1, usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }),
      assistantRecord({ uuid: "u2", agentRound: 2, sessionId: "other" }),
    ]);
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), undefined);
    fs.rmSync(proj.childFile, { force: true });
    appendRecords(proj.childFile, [
      assistantRecord({ uuid: "u1", agentRound: 1, usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }),
      assistantRecord({ uuid: "u2", agentRound: 2, agentId: "other-agent" }),
    ]);
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), undefined);
  });

  it("treats torn writes, malformed lines, and non-object records as unknown", () => {
    const proj = freshProject();
    appendRecords(proj.childFile, [
      assistantRecord({ uuid: "u1", agentRound: 1, usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }),
    ]);
    const raw = fs.readFileSync(proj.childFile, "utf8");
    assert.ok(raw.endsWith("\n"));
    fs.writeFileSync(proj.childFile, raw.slice(0, -1));
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), undefined);

    fs.rmSync(proj.childFile, { force: true });
    appendRecords(proj.childFile, [
      assistantRecord({ uuid: "u1", agentRound: 1, usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }),
    ]);
    fs.appendFileSync(proj.childFile, "this is not json\n");
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), undefined);

    fs.rmSync(proj.childFile, { force: true });
    appendRecords(proj.childFile, [
      assistantRecord({ uuid: "u1", agentRound: 1, usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }),
    ]);
    fs.appendFileSync(proj.childFile, "42\n");
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), undefined);
  });

  it("treats invalid latest usage as unknown with no older fallback", () => {
    const proj = freshProject();
    for (const bad of [
      { promptTokenCount: 100 },
      { candidatesTokenCount: 100 },
      { promptTokenCount: 0, candidatesTokenCount: 0 },
      { promptTokenCount: -1, candidatesTokenCount: 5 },
      { promptTokenCount: "100", candidatesTokenCount: 5 },
      { promptTokenCount: 1.5, candidatesTokenCount: 5 },
    ]) {
      fs.rmSync(proj.childFile, { force: true });
      appendRecords(proj.childFile, [
        assistantRecord({ uuid: "u1", agentRound: 1, usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }),
        assistantRecord({ uuid: "u2", agentRound: 2, usageMetadata: bad }),
      ]);
      assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), undefined);
    }
  });

  it("never adds billing totals, cache, or thoughts", () => {
    const proj = freshProject();
    appendRecords(proj.childFile, [
      assistantRecord({
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 9999,
          cachedContentTokenCount: 100,
          thoughtsTokenCount: 500,
        },
      }),
    ]);
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), 150);
  });

  it("returns unknown for a missing child file", () => {
    const proj = freshProject();
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), undefined);
  });

  it("scans only bytes after the checkpoint", () => {
    const proj = freshProject();
    appendRecords(proj.childFile, [
      assistantRecord({ uuid: "u1", agentRound: 1, usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }),
    ]);
    const cutoff = fs.statSync(proj.childFile).size;
    appendRecords(proj.childFile, [
      assistantRecord({ uuid: "u2", agentRound: 2, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
    ]);
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, cutoff), 15);
    assert.equal(measureChild(proj.childFile, proj.sessionId, proj.agentId, 0), 15);
  });
});

describe("intros", () => {
  it("SessionStart returns the exact root intro for roots only", () => {
    const out = handleHook({ hook_event_name: "SessionStart", session_id: "s" }, freshStore(), {});
    assert.deepEqual(out, {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ROOT_INTRO },
    });
    assert.match(ROOT_INTRO, /same logical subagent/);
    assert.deepEqual(
      handleHook({ hook_event_name: "SessionStart", session_id: "s", agent_id: "a" }, freshStore(), {}),
      {},
    );
  });

  it("SubagentStart returns the exact child intro and resets the observation", () => {
    const store = freshStore();
    store.setObservation("ses-parent:agent-1a", { soft: 1, estimatedTokens: 2, nudged: true });
    const out = handleHook(
      { hook_event_name: "SubagentStart", session_id: "ses-parent", agent_id: "agent-1a" },
      store,
      {},
    );
    assert.deepEqual(out, {
      hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: CHILD_INTRO },
    });
    assert.equal(store.getObservation("ses-parent:agent-1a"), undefined);
    assert.match(CHILD_INTRO, new RegExp(TOOL_NAMES.handover.replace(/[__]/g, ".")));
  });

  it("SubagentStart for a closed child returns locked guidance", () => {
    const store = freshStore();
    const rec = record("ses-parent:agent-1a");
    store.saveHandover(rec);
    assert.deepEqual(
      handleHook({ hook_event_name: "SubagentStart", session_id: "ses-parent", agent_id: "agent-1a" }, store, {}),
      { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: lockedReply(rec) } },
    );
  });
});

describe("stages and notices", () => {
  const env = { [SOFT_ENV]: "1000" };

  function observedAt(proj: ReturnType<typeof freshProject>, estimate: number): QwenStore {
    const store = freshStore();
    appendRecords(proj.childFile, [
      assistantRecord({
        sessionId: proj.sessionId,
        agentId: proj.agentId,
        usageMetadata: { promptTokenCount: estimate - 1, candidatesTokenCount: 1 },
      }),
    ]);
    const out = handleHook(
      {
        hook_event_name: "PostToolUse",
        session_id: proj.sessionId,
        transcript_path: proj.transcriptPath,
        agent_id: proj.agentId,
        tool_name: "shell",
        tool_input: {},
        tool_response: {},
      },
      store,
      env,
    );
    assert.ok((out.hookSpecificOutput as { additionalContext: string }).additionalContext.length > 0);
    return store;
  }

  function postTool(proj: ReturnType<typeof freshProject>, toolName = "shell"): Record<string, unknown> {
    return {
      hook_event_name: "PostToolUse",
      session_id: proj.sessionId,
      transcript_path: proj.transcriptPath,
      agent_id: proj.agentId,
      tool_name: toolName,
      tool_input: {},
      tool_response: {},
    };
  }

  it("emits staged notices at fixed boundaries", () => {
    for (const [estimate, stage] of [[1000, "warn1"], [1100, "warn2"], [1200, "warn3"]] as const) {
      const proj = freshProject();
      const store = freshStore();
      appendRecords(proj.childFile, [
        assistantRecord({
          sessionId: proj.sessionId,
          agentId: proj.agentId,
          usageMetadata: { promptTokenCount: estimate - 1, candidatesTokenCount: 1 },
        }),
      ]);
      const out = handleHook(postTool(proj), store, env);
      assert.deepEqual(out, {
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: buildNotice(stage) },
      });
      assert.ok(
        (out.hookSpecificOutput as { additionalContext: string }).additionalContext.startsWith(
          `As installed at session start: ${openCodeStageText(stage)}`,
        ),
      );
      assert.equal(store.getObservation(proj.key)?.nudged, true);
    }
  });

  it("stays silent below soft and ignores the removed PostToolBatch event", () => {
    const proj = freshProject();
    const store = freshStore();
    appendRecords(proj.childFile, [
      assistantRecord({
        sessionId: proj.sessionId,
        agentId: proj.agentId,
        usageMetadata: { promptTokenCount: 998, candidatesTokenCount: 1 },
      }),
    ]);
    assert.deepEqual(handleHook(postTool(proj), store, env), {});
    // PostToolBatch was removed: even ordinary batches stay silent.
    assert.deepEqual(
      handleHook(
        {
          hook_event_name: "PostToolBatch",
          session_id: proj.sessionId,
          transcript_path: proj.transcriptPath,
          agent_id: proj.agentId,
          tool_calls: [{ tool_name: "shell", tool_input: {}, tool_use_id: "u1", status: "success" }],
        },
        store,
        env,
      ),
      {},
    );
    assert.deepEqual(
      handleHook(
        {
          hook_event_name: "PostToolBatch",
          session_id: proj.sessionId,
          transcript_path: proj.transcriptPath,
          agent_id: proj.agentId,
          tool_calls: [
            { tool_name: TOOL_NAMES.handover, tool_input: {}, tool_use_id: "u1", status: "success" },
            { tool_name: TOOL_NAMES.read, tool_input: {}, tool_use_id: "u2", status: "success" },
          ],
        },
        store,
        env,
      ),
      {},
    );
  });

  it("never emits notices via PostToolBatch, even over soft", () => {
    const proj = freshProject("ses-b", "agent-9");
    const store = freshStore();
    appendRecords(proj.childFile, [
      assistantRecord({
        uuid: "u1",
        sessionId: "ses-b",
        agentId: "agent-9",
        usageMetadata: { promptTokenCount: 1099, candidatesTokenCount: 1 },
      }),
    ]);
    const out = handleHook(
      {
        hook_event_name: "PostToolBatch",
        session_id: "ses-b",
        transcript_path: proj.transcriptPath,
        agent_id: "agent-9",
        tool_calls: [{ tool_name: "shell", tool_input: {}, tool_use_id: "u1", status: "success" }],
      },
      store,
      env,
    );
    assert.deepEqual(out, {});
    assert.equal(store.getObservation(proj.key), undefined);
  });

  it("maps warn3 to diagnostics final and keeps unknowns unknown", () => {
    const proj = freshProject();
    const store = observedAt(proj, 1200);
    const out = handleHook(preTool(proj, TOOL_NAMES.handover, { handover: "h", summary: "s" }), store, env);
    const specific = out.hookSpecificOutput as { permissionDecision: string; updatedInput: { capability: string } };
    assert.equal(specific.permissionDecision, "allow");
    assert.deepEqual(store.consumePending(specific.updatedInput.capability).diagnostics, {
      reason: "nudged",
      stage: "final",
      estimatedTokens: 1200,
      soft: 1000,
    });

    const unknown = freshStore();
    const fresh = freshProject("ses-fresh", "agent-fresh");
    unknown.setObservation(fresh.key, { soft: 1000 });
    const out2 = handleHook(preTool(fresh, TOOL_NAMES.handover, { handover: "h", summary: "s" }), unknown, env);
    const cap = (out2.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    assert.deepEqual(unknown.consumePending(cap).diagnostics, { reason: "not-nudged", soft: 1000 });
  });

  it("mints invalid-soft capabilities with the sentinel not-nudged/soft-0 diagnostics", () => {
    const proj = freshProject();
    const store = freshStore();
    appendRecords(proj.childFile, [
      assistantRecord({
        sessionId: proj.sessionId,
        agentId: proj.agentId,
        usageMetadata: { promptTokenCount: 1099, candidatesTokenCount: 1 },
      }),
    ]);
    const out = handleHook(preTool(proj, TOOL_NAMES.handover, { handover: "h", summary: "s" }), store, {
      [SOFT_ENV]: "bogus",
    });
    const specific = out.hookSpecificOutput as { permissionDecision: string; updatedInput: { capability: string } };
    assert.equal(specific.permissionDecision, "allow");
    assert.deepEqual(store.consumePending(specific.updatedInput.capability).diagnostics, {
      reason: "not-nudged",
      soft: 0,
    });
  });

  it("suppresses notices when the checkpoint is corrupt or unreadable", () => {
    for (const payload of ["not-json", JSON.stringify({ byteLength: "x" }), JSON.stringify({ other: 1 })]) {
      const proj = freshProject();
      const store = freshStore();
      appendRecords(proj.childFile, [
        assistantRecord({
          sessionId: proj.sessionId,
          agentId: proj.agentId,
          usageMetadata: { promptTokenCount: 1099, candidatesTokenCount: 1 },
        }),
      ]);
      const dir = path.join(store.baseDir, "checkpoints");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${createHash("sha256").update(proj.key, "utf8").digest("hex")}.json`);
      fs.writeFileSync(file, payload);
      assert.deepEqual(handleHook(postTool(proj), store, env), {});
      // PreToolUse still binds, but records no estimate under a bad checkpoint.
      const out = handleHook(preTool(proj, TOOL_NAMES.handover, { handover: "h", summary: "s" }), store, env);
      const cap = (out.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
      assert.deepEqual(store.consumePending(cap).diagnostics, { reason: "not-nudged", soft: 1000 });
    }
  });

  it("never nudges after a stored handover", () => {
    const proj = freshProject();
    const store = observedAt(proj, 1200);
    store.saveHandover(record(proj.key));
    assert.deepEqual(handleHook(postTool(proj), store, env), {});
  });

  it("skips notices for own tools and roots", () => {
    const proj = freshProject();
    const store = observedAt(proj, 1200);
    assert.deepEqual(handleHook(postTool(proj, TOOL_NAMES.handover), store, env), {});
    assert.deepEqual(handleHook(postTool(proj, TOOL_NAMES.read), store, env), {});
    assert.deepEqual(
      handleHook(
        {
          hook_event_name: "PostToolUse",
          session_id: proj.sessionId,
          transcript_path: proj.transcriptPath,
          tool_name: "shell",
          tool_input: {},
          tool_response: {},
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
    const proj = freshProject();
    const store = freshStore();
    const spoof = { handover: "h", summary: "s", capability: "evil", childId: "spoof", sessionID: "spoof" };
    const out = handleHook(preTool(proj, TOOL_NAMES.handover, spoof), store, { [SOFT_ENV]: "1000" });
    const cap = (out.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    assert.match(cap, /^[0-9a-f]{64}$/);
    const pending = store.consumePending(cap);
    assert.equal(pending.tool, "context_handover");
    assert.deepEqual(pending.caller, { sessionId: proj.sessionId, childId: proj.key });
    assert.deepEqual(pending.args, spoof);
  });

  it("roots receive no capability for ordinary tools but bind own tools session-only", () => {
    const proj = freshProject();
    const store = freshStore();
    assert.deepEqual(
      handleHook(
        {
          hook_event_name: "PreToolUse",
          session_id: proj.sessionId,
          transcript_path: proj.transcriptPath,
          tool_name: "shell",
          tool_input: {},
          tool_use_id: "u",
        },
        store,
        {},
      ),
      {},
    );
    const out = handleHook(
      {
        hook_event_name: "PreToolUse",
        session_id: proj.sessionId,
        transcript_path: proj.transcriptPath,
        tool_name: TOOL_NAMES.read,
        tool_input: { childId: "x", full: true },
        tool_use_id: "u",
      },
      store,
      {},
    );
    const cap = (out.hookSpecificOutput as { updatedInput: { capability: string } }).updatedInput.capability;
    assert.deepEqual(store.consumePending(cap).caller, { sessionId: proj.sessionId });
  });
});

describe("closed children", () => {
  it("denies ordinary tools and own tools with an explicit locked message", () => {
    const proj = freshProject();
    const store = freshStore();
    store.saveHandover(record(proj.key));
    for (const tool of ["shell", TOOL_NAMES.read, TOOL_NAMES.handover]) {
      const out = handleHook(preTool(proj, tool, {}), store, {});
      const specific = out.hookSpecificOutput as {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
      assert.equal(specific.permissionDecision, "deny", tool);
      assert.match(specific.permissionDecisionReason, /locked after a context handover/);
      assert.ok(specific.permissionDecisionReason.includes(readInvocation(proj.key, true)), tool);
      assert.equal(specific.permissionDecisionReason.includes("capability"), false);
    }
  });
});

describe("compaction", () => {
  it("checkpoints the child file so only later records measure", () => {
    const proj = freshProject("ses-c", "agent-7");
    const store = freshStore();
    const env = { [SOFT_ENV]: "1000" };
    appendRecords(proj.childFile, [
      assistantRecord({
        uuid: "u1",
        sessionId: "ses-c",
        agentId: "agent-7",
        usageMetadata: { promptTokenCount: 1099, candidatesTokenCount: 1 },
      }),
    ]);
    const before = handleHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "ses-c",
        transcript_path: proj.transcriptPath,
        agent_id: "agent-7",
        tool_name: "shell",
        tool_input: {},
        tool_response: {},
      },
      store,
      env,
    );
    assert.ok((before.hookSpecificOutput as { additionalContext: string }).additionalContext.length > 0);
    for (const event of ["PreCompact", "PostCompact"]) {
      assert.deepEqual(
        handleHook(
          { hook_event_name: event, session_id: "ses-c", transcript_path: proj.transcriptPath, agent_id: "agent-7" },
          store,
          env,
        ),
        {},
      );
    }
    assert.equal(store.getObservation(childKey("ses-c", "agent-7")), undefined);
    // Old records no longer measure: no notice without new usage.
    assert.deepEqual(
      handleHook(
        {
          hook_event_name: "PostToolUse",
          session_id: "ses-c",
          transcript_path: proj.transcriptPath,
          agent_id: "agent-7",
          tool_name: "shell",
          tool_input: {},
          tool_response: {},
        },
        store,
        env,
      ),
      {},
    );
    // Fresh post-compaction usage measures again.
    appendRecords(proj.childFile, [
      assistantRecord({
        uuid: "u2",
        parentUuid: "u1",
        sessionId: "ses-c",
        agentId: "agent-7",
        agentRunId: "run-2",
        agentRound: 1,
        usageMetadata: { promptTokenCount: 1099, candidatesTokenCount: 1 },
      }),
    ]);
    const after = handleHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "ses-c",
        transcript_path: proj.transcriptPath,
        agent_id: "agent-7",
        tool_name: "shell",
        tool_input: {},
        tool_response: {},
      },
      store,
      env,
    );
    assert.deepEqual(after, {
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: buildNotice("warn2") },
    });
  });

  it("ignores root compacts", () => {
    assert.deepEqual(
      handleHook({ hook_event_name: "PreCompact", session_id: "s" }, freshStore(), {}),
      {},
    );
  });
});

describe("stop shaping", () => {
  it("blocks once with the exact short reply, then never reblocks", () => {
    const store = freshStore();
    const rec = record("ses-parent:agent-1a", { summary: "did things" });
    store.saveHandover(rec);
    const expected = shortReply(rec);
    const base = {
      hook_event_name: "SubagentStop",
      session_id: "ses-parent",
      transcript_path: "/tmp/x/chats/ses-parent.jsonl",
      agent_id: "agent-1a",
      agent_transcript_path: "/tmp/x/subagents/ses-parent/agent-agent-1a.jsonl",
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

  it("ignores open children, roots, and unknown events", () => {
    const store = freshStore();
    assert.deepEqual(
      handleHook(
        {
          hook_event_name: "SubagentStop",
          session_id: "s",
          agent_id: "kid",
          stop_hook_active: false,
          last_assistant_message: "done",
        },
        store,
        {},
      ),
      {},
    );
    assert.deepEqual(handleHook({ hook_event_name: "SubagentStop", session_id: "s" }, store, {}), {});
    assert.deepEqual(handleHook({ hook_event_name: "Stop", session_id: "s" }, store, {}), {});
    assert.deepEqual(handleHook({ hook_event_name: "UserPromptSubmit" }, store, {}), {});
    assert.deepEqual(handleHook(null, store, {}), {});
  });
});
