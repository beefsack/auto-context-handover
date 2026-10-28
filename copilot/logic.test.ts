import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  CHILD_ROLLOVER_GUIDANCE,
  CHILD_SUMMARY_PREFIX,
  formatDiagLine,
  HANDOVER_SECTIONS,
  openCodeStageText,
  softStage,
  withChildSummaryPrefix,
} from "../source/shared/handover-text.ts";
import { seedTooLarge as sharedSeedTooLarge } from "../source/shared/seed-size.ts";
import { formatAgentTypeReadback, formatModelOverrideReadback } from "../hooks/child.ts";
import { parseThreshold as sharedParseThreshold } from "../source/shared/threshold.ts";
import { resolveSoftTokens as sharedResolveSoftTokens } from "../source/measure.ts";
import type { SessionEvent } from "@github/copilot-sdk";
import {
  buildExtensionConfig,
  buildNotice,
  CHILD_INTRO,
  ChildMemory,
  CopilotStore,
  DATA_DIR_NAME,
  DATA_ENV_VAR,
  DEFAULT_SOFT,
  DuplicateHandoverError,
  formatDiagLine as localFormatDiagLine,
  formatProvenanceLine,
  handleHandoverTool,
  handlePostToolUse,
  handlePreToolUse,
  handleReadTool,
  handleSessionEvent,
  handleSessionStart,
  handleSubagentStart,
  handleSubagentStop,
  handleUsageInfo,
  HANDOVER_SECTIONS as LOCAL_SECTIONS,
  lockedReply,
  parseThreshold,
  readInvocation,
  resolveDataDir,
  resolveSoftForWindow,
  resolveSoftSpec,
  ROOT_INTRO,
  SESSION_SUBSCRIPTIONS,
  seedTooLarge as localSeedTooLarge,
  shortReply,
  softStage as localSoftStage,
  stageLead,
  successorPrompt,
  withChildSummaryPrefix as localPrefix,
  __testing,
} from "./logic.mjs";

const SOFT_ENV = "AUTO_CONTEXT_HANDOVER_SOFT";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-logic-"));
  tempDirs.push(dir);
  return dir;
}

function freshStore(): CopilotStore {
  return new CopilotStore(tempDir());
}

function freshMemory(): ChildMemory {
  return new ChildMemory();
}

function usageEvent(agentId: string | undefined, currentTokens: unknown, tokenLimit: unknown): SessionEvent {
  return { type: "session.usage_info", agentId, data: { currentTokens, tokenLimit, messagesLength: 3 } } as unknown as SessionEvent;
}

function hookBase(agentId?: string): Record<string, unknown> {
  return {
    ...(agentId === undefined ? {} : { agentId }),
    sessionId: agentId === undefined ? "ses-parent" : `ses-child-${agentId}`,
    timestamp: new Date(0),
    workingDirectory: tempDir(),
  };
}

function closedRecord(store: CopilotStore, childId: string): void {
  store.saveHandover({
    childId,
    parentSessionId: "ses-parent",
    agentType: "unknown",
    handover: "body",
    summary: "s",
    closed: true,
    diagnostics: { reason: "nudged", soft: 150000 },
  });
}

describe("shared drift", () => {
  it("handover sections match shared apart from the provenance paragraph", () => {
    assert.equal(
      LOCAL_SECTIONS.replace(__testing.SHARED_PROVENANCE_PARAGRAPH, "MISSING"),
      LOCAL_SECTIONS,
      "embedded sections must contain the shared provenance paragraph to replace",
    );
    const restored = LOCAL_SECTIONS.replace(
      "The plugin-recorded child id, parent session id and agent type are the authoritative provenance; " +
        "unknown values are unknown, and no model override or chain is recorded. " +
        "Do not restate your own agent or model identity; write the handover from the task content.",
      __testing.SHARED_PROVENANCE_PARAGRAPH,
    );
    assert.equal(restored, HANDOVER_SECTIONS);
  });

  it("stage leads match shared openCodeStageText", () => {
    assert.equal(stageLead("warn1"), openCodeStageText("warn1"));
    assert.equal(stageLead("warn2"), openCodeStageText("warn2"));
    assert.equal(stageLead("warn3"), openCodeStageText("warn3"));
  });

  it("rollover guidance, prefix, diag line and prefix helper match shared", () => {
    assert.equal(__testing.CHILD_ROLLOVER_GUIDANCE, CHILD_ROLLOVER_GUIDANCE);
    assert.equal(CHILD_SUMMARY_PREFIX, "Context handover (incomplete):");
    assert.equal(localPrefix("  work  "), withChildSummaryPrefix("  work  "));
    assert.equal(localPrefix(""), withChildSummaryPrefix(""));
    const diag = { reason: "nudged", stage: "warn1", estimate: 10, soft: 100 };
    assert.equal(localFormatDiagLine(diag), formatDiagLine(diag));
    assert.equal(localFormatDiagLine({}), formatDiagLine({}));
  });

  it("threshold parsing mirrors shared parseThreshold", () => {
    for (const good of [150000, "70%", "100%"]) {
      assert.deepEqual(parseThreshold(good), sharedParseThreshold(good));
    }
    assert.equal(resolveSoftForWindow({ [SOFT_ENV]: " 200000 " }, undefined), 200000);
    for (const bad of ["abc", "0", "-5", "0%", "101%", "", 0, -3, 1.5, null, undefined, {}]) {
      assert.throws(() => parseThreshold(bad), Error);
      assert.throws(() => sharedParseThreshold(bad), Error);
    }
  });

  it("soft resolution and staging mirror shared helpers", () => {
    assert.equal(resolveSoftForWindow({}, 200000), sharedResolveSoftTokens(sharedParseThreshold(150000), 200000));
    assert.equal(resolveSoftForWindow({}, undefined), sharedResolveSoftTokens(sharedParseThreshold(150000), undefined));
    assert.equal(
      resolveSoftForWindow({ [SOFT_ENV]: "50%" }, 200000),
      sharedResolveSoftTokens(sharedParseThreshold("50%"), 200000),
    );
    assert.equal(resolveSoftForWindow({ [SOFT_ENV]: "50%" }, undefined), undefined);
    for (const [estimate, soft] of [[10, 100], [100, 100], [110, 100], [120, 100], [200, 100]]) {
      const [e, s] = [estimate as number, soft as number];
      assert.equal(localSoftStage(e, s), softStage(e, s) === "ok" ? "ok" : softStage(e, s));
    }
  });

  it("provenance fragments mirror the shared readback helpers", () => {
    assert.equal(formatAgentTypeReadback("task"), "(recorded: task)");
    assert.equal(formatAgentTypeReadback(undefined), "(recorded: unknown, use predecessor spawn params)");
    assert.equal(formatModelOverrideReadback(undefined), "(recorded: unknown, use predecessor spawn params)");
    const known = formatProvenanceLine({ childId: "c", parentSessionId: "p", agentType: "task" });
    assert.ok(known.includes('childId="c"'));
    assert.ok(known.includes('parentSessionId="p"'));
    assert.ok(known.includes(formatAgentTypeReadback("task")));
    assert.ok(known.includes(formatModelOverrideReadback(undefined)));
    assert.ok(known.includes("authoritative"));
    const unknown = formatProvenanceLine({ childId: "c", parentSessionId: "p", agentType: "unknown" });
    assert.ok(unknown.includes(formatAgentTypeReadback(undefined)));
  });

  it("seed-size warning mirrors the shared boundary", () => {
    for (const [seed, soft] of [[10, 100], [50, 100], [51, 100], [200, 100]]) {
      assert.equal(localSeedTooLarge(seed as number, soft as number), sharedSeedTooLarge(seed as number, soft as number));
    }
  });

  it("default soft is 150000 like the other adapters", () => {
    assert.equal(DEFAULT_SOFT, 150000);
    assert.deepEqual(resolveSoftSpec({}), sharedParseThreshold(150000));
  });
});

describe("data dir", () => {
  it("prefers an explicit absolute AUTO_CONTEXT_HANDOVER_DATA override", () => {
    const abs = path.join(tempDir(), "override");
    assert.equal(resolveDataDir({ [DATA_ENV_VAR]: abs }), abs);
    assert.throws(() => resolveDataDir({ [DATA_ENV_VAR]: "relative/path" }), /absolute/);
  });

  it("falls back to COPILOT_HOME plus a scoped plugin path", () => {
    const home = tempDir();
    assert.equal(resolveDataDir({ COPILOT_HOME: home }), path.join(home, DATA_DIR_NAME));
    assert.throws(() => resolveDataDir({ COPILOT_HOME: "relative" }), /absolute/);
  });

  it("defaults under the user Copilot directory", () => {
    assert.equal(resolveDataDir({}), path.join(os.homedir(), ".copilot", DATA_DIR_NAME));
  });
});

describe("store", () => {
  it("round-trips handovers and refuses second writes", () => {
    const store = freshStore();
    assert.equal(store.getHandover("child-1"), undefined);
    const record = {
      childId: "child-1",
      parentSessionId: "ses-1",
      agentType: "explore",
      handover: "body",
      summary: "did things",
      closed: true as const,
      diagnostics: { reason: "nudged" as const, stage: "warn1" as const, soft: 150000 },
    };
    store.saveHandover(record);
    assert.deepEqual(store.getHandover("child-1"), record);
    assert.throws(() => store.saveHandover(record), DuplicateHandoverError);
  });

  it("accepts unknown-reason diagnostics with optional fields", () => {
    const store = freshStore();
    store.saveHandover({
      childId: "child-1",
      parentSessionId: "ses-1",
      agentType: "unknown",
      handover: "body",
      summary: "s",
      closed: true,
      diagnostics: { reason: "unknown" },
    });
    assert.deepEqual(store.getHandover("child-1")?.diagnostics, { reason: "unknown" });
  });

  it("rejects corrupt or malformed records", () => {
    const store = freshStore();
    assert.throws(
      () =>
        store.saveHandover({
          childId: "c",
          parentSessionId: "s",
          agentType: "t",
          handover: "h",
          summary: "s",
          closed: true,
          diagnostics: { reason: "bogus" },
        } as unknown as Parameters<CopilotStore["saveHandover"]>[0]),
      /reason/,
    );
    store.saveHandover({
      childId: "corrupt",
      parentSessionId: "s",
      agentType: "t",
      handover: "h",
      summary: "s",
      closed: true,
      diagnostics: { reason: "unknown" },
    });
    const files = fs.readdirSync(store.handoversDir());
    assert.equal(files.length, 1);
    fs.writeFileSync(path.join(store.handoversDir(), files[0] as string), "{not json", { mode: 0o600 });
    assert.throws(() => store.getHandover("corrupt"), /corrupt/);
  });

  it("uses private file modes", () => {
    const store = freshStore();
    store.saveHandover({
      childId: "c",
      parentSessionId: "s",
      agentType: "t",
      handover: "h",
      summary: "s",
      closed: true,
      diagnostics: { reason: "not-nudged", soft: 1 },
    });
    const st = fs.statSync(path.join(store.handoversDir()));
    assert.equal(st.mode & 0o777, 0o700);
    const files = fs.readdirSync(store.handoversDir());
    assert.equal(files.length, 1);
    assert.equal(fs.statSync(path.join(store.handoversDir(), files[0] as string)).mode & 0o777, 0o600);
  });

  it("stores only handovers: no observation surface persists", () => {
    const store = freshStore();
    assert.equal("getObservation" in store, false);
    assert.equal("setObservation" in store, false);
    assert.equal("resetObservation" in store, false);
  });
});

describe("memory", () => {
  it("round-trips observations and clears them", () => {
    const memory = freshMemory();
    assert.equal(memory.getObservation("child-1"), undefined);
    memory.setObservation("child-1", { estimatedTokens: 160000, tokenLimit: 200000, soft: 140000 });
    assert.deepEqual(memory.getObservation("child-1"), {
      estimatedTokens: 160000,
      tokenLimit: 200000,
      soft: 140000,
    });
    memory.clearObservation("child-1");
    assert.equal(memory.getObservation("child-1"), undefined);
    memory.clearObservation("child-1");
  });

  it("keeps the first host-reported agent type only", () => {
    const memory = freshMemory();
    memory.noteAgentType("c", "task");
    memory.noteAgentType("c", "other");
    memory.noteAgentType("c", "");
    assert.equal(memory.getAgentType("c"), "task");
    memory.clearAgentType("c");
    assert.equal(memory.getAgentType("c"), undefined);
  });

  it("evicts corrupt snapshots and clears everything at once", () => {
    const memory = freshMemory();
    memory.observations.set("c", { soft: Number.NaN });
    assert.equal(memory.getObservation("c"), undefined);
    memory.setObservation("c", { soft: 1 });
    memory.noteAgentType("c", "t");
    memory.clearAll();
    assert.equal(memory.getObservation("c"), undefined);
    assert.equal(memory.getAgentType("c"), undefined);
  });
});

describe("hooks", () => {
  it("session start returns the installed-plugin root intro", () => {
    const out = handleSessionStart();
    assert.equal(out.additionalContext, ROOT_INTRO);
    assert.match(ROOT_INTRO, /installed as a plugin workflow/);
    assert.doesNotMatch(ROOT_INTRO, /trusted/);
    assert.match(ROOT_INTRO, /before replying to the user or making any decision/);
    assert.match(ROOT_INTRO, /same requested model override taken from the original spawn parameters/);
    assert.match(ROOT_INTRO, /never paste handover text into a spawn prompt/);
    assert.match(ROOT_INTRO, /replaces any required final report for that child session/);
    assert.match(ROOT_INTRO, /conditional advisory when the stored handover alone exceeds 50% of the known soft limit/);
    assert.doesNotMatch(ROOT_INTRO, /trim the original-task pointer/);
  });

  it("subagent start returns the child intro and clears stale state, locked when closed", () => {
    const store = freshStore();
    const memory = freshMemory();
    memory.setObservation("child-9", { soft: 1 });
    const fresh = handleSubagentStart({ agentName: "explore", agentId: "child-9", ...hookBase("child-9") } as never, store, memory);
    assert.equal(fresh.additionalContext, CHILD_INTRO);
    assert.match(CHILD_INTRO, /installed as a plugin workflow/);
    assert.doesNotMatch(CHILD_INTRO, /trusted/);
    assert.equal(memory.getObservation("child-9"), undefined);
    closedRecord(store, "child-9");
    const locked = handleSubagentStart({ agentId: "child-9", ...hookBase("child-9") } as never, store, memory);
    assert.match(locked.additionalContext ?? "", /locked after a context handover/);
    assert.match(locked.additionalContext ?? "", /never paste the handover into the spawn prompt/);
    assert.equal(handleSubagentStart({ agentId: "other", ...hookBase("other") } as never, store, memory).additionalContext, CHILD_INTRO);
  });

  it("usage_info records host measurement and fails open on garbage", () => {
    const store = freshStore();
    const memory = freshMemory();
    assert.equal(handleUsageInfo(usageEvent("child-1", 160000, 200000), store, memory, {}), true);
    assert.deepEqual(memory.getObservation("child-1"), {
      estimatedTokens: 160000,
      tokenLimit: 200000,
      soft: 140000,
    });
    assert.equal(handleUsageInfo({ agentId: "c", data: {} } as unknown as SessionEvent, store, memory, {}), false);
    assert.equal(handleUsageInfo(usageEvent("c", -1, 5), store, memory, {}), false);
    assert.equal(handleUsageInfo(usageEvent("c", "many", 5), store, memory, {}), false);
    assert.equal(
      handleUsageInfo(usageEvent("child-2", 10, 200000), store, memory, { [SOFT_ENV]: "bogus" }),
      false,
    );
    assert.equal(memory.getObservation("child-2"), undefined);
  });

  it("zero or unknown measurements clear stale snapshots", () => {
    const store = freshStore();
    const memory = freshMemory();
    memory.setObservation("child-1", { estimatedTokens: 160000, tokenLimit: 200000, soft: 140000 });
    assert.equal(handleUsageInfo(usageEvent("child-1", 0, 200000), store, memory, {}), false);
    assert.equal(memory.getObservation("child-1"), undefined);
    memory.setObservation("child-1", { estimatedTokens: 160000, tokenLimit: 200000, soft: 140000 });
    assert.equal(handleUsageInfo(usageEvent("child-1", undefined, 200000), store, memory, {}), false);
    assert.equal(memory.getObservation("child-1"), undefined);
    memory.setObservation("child-1", { estimatedTokens: 160000, tokenLimit: 200000, soft: 140000 });
    assert.equal(handleUsageInfo(usageEvent("child-1", 10, undefined), store, memory, { [SOFT_ENV]: "50%" }), false);
    assert.equal(memory.getObservation("child-1"), undefined);
  });

  it("root usage_info is ignored and closed children drop measurements", () => {
    const store = freshStore();
    const memory = freshMemory();
    assert.equal(handleUsageInfo(usageEvent(undefined, 500, 200000), store, memory, {}), false);
    assert.equal(memory.observations.size, 0);
    assert.equal(handlePostToolUse({ toolName: "bash", ...hookBase() } as never, store, memory, {}), undefined);
    closedRecord(store, "locked");
    memory.setObservation("locked", { soft: 1 });
    assert.equal(handleUsageInfo(usageEvent("locked", 200000, 200000), store, memory, {}), false);
    assert.equal(memory.getObservation("locked"), undefined);
  });

  it("pre tool use denies locked children and captures host agent types", () => {
    const store = freshStore();
    const memory = freshMemory();
    assert.equal(handlePreToolUse({ toolName: "bash", ...hookBase() } as never, store, memory), undefined);
    assert.equal(handlePreToolUse({ agentId: "open", toolName: "bash", ...hookBase("open") } as never, store, memory), undefined);
    handlePreToolUse({ agentId: "open", agentType: "task", toolName: "bash", ...hookBase("open") } as never, store, memory);
    assert.equal(memory.getAgentType("open"), "task");
    closedRecord(store, "locked");
    const denied = handlePreToolUse({ agentId: "locked", toolName: "bash", ...hookBase("locked") } as never, store, memory);
    assert.equal(denied?.permissionDecision, "deny");
    assert.match(denied?.permissionDecisionReason ?? "", /locked after a context handover/);
  });

  it("pre tool use stays fail-open when closure state is unreadable", () => {
    const store = freshStore();
    const memory = freshMemory();
    closedRecord(store, "locked");
    for (const file of fs.readdirSync(store.handoversDir())) {
      fs.writeFileSync(path.join(store.handoversDir(), file), "{not json", { mode: 0o600 });
    }
    assert.equal(
      handlePreToolUse({ agentId: "locked", toolName: "bash", ...hookBase("locked") } as never, store, memory),
      undefined,
    );
  });

  it("post tool use nudges at shared boundaries from host measurement", () => {
    const store = freshStore();
    const memory = freshMemory();
    const input = (agentId: string): never => ({ agentId, toolName: "bash", toolArgs: {}, toolResult: {}, ...hookBase(agentId) }) as never;
    assert.equal(handlePostToolUse(input("child-1"), store, memory, {}), undefined);
    handleUsageInfo(usageEvent("child-1", 149999, 300000), store, memory, {});
    assert.equal(handlePostToolUse(input("child-1"), store, memory, {}), undefined);
    handleUsageInfo(usageEvent("child-1", 150000, 300000), store, memory, {});
    const notice = handlePostToolUse(input("child-1"), store, memory, {});
    assert.match(notice?.additionalContext ?? "", /Context is filling/);
    assert.equal(memory.getObservation("child-1")?.nudged, true);
    handleUsageInfo(usageEvent("child-1", 165000, 300000), store, memory, {});
    assert.match(handlePostToolUse(input("child-1"), store, memory, {})?.additionalContext ?? "", /Wrap up now/);
    handleUsageInfo(usageEvent("child-1", 180000, 300000), store, memory, {});
    assert.match(handlePostToolUse(input("child-1"), store, memory, {})?.additionalContext ?? "", /final warning/);
  });

  it("post tool use stays silent for locked children and unknown measurement", () => {
    const store = freshStore();
    const memory = freshMemory();
    closedRecord(store, "locked");
    handleUsageInfo(usageEvent("locked", 200000, 200000), store, memory, {});
    assert.equal(
      handlePostToolUse({ agentId: "locked", toolName: "bash", ...hookBase("locked") } as never, store, memory, {}),
      undefined,
    );
    assert.equal(
      handlePostToolUse({ agentId: "unknown", toolName: "bash", ...hookBase("unknown") } as never, store, memory, {}),
      undefined,
    );
  });

  it("subagent stop rewrites to the receipt natively and never blocks", () => {
    const store = freshStore();
    assert.equal(handleSubagentStop({ agentId: "c", response: "done" } as never, store), undefined);
    assert.equal(handleSubagentStop({ response: "done" } as never, store), undefined);
    const memory = freshMemory();
    const receipt = handleHandoverTool(
      { handover: "body", summary: "did things" },
      { sessionId: "ses-parent", agentId: "c" } as never,
      store,
      memory,
      {},
    );
    const rewritten = handleSubagentStop({ agentId: "c", agentType: "task", response: "something else", ...hookBase("c") } as never, store);
    assert.equal(rewritten?.decision, undefined);
    assert.ok(rewritten?.modifiedResponse?.includes("Context handover (incomplete): did things") ?? false);
    assert.ok(receipt.includes(rewritten?.modifiedResponse ?? "missing"));
    const exact = handleSubagentStop(
      { agentId: "c", agentType: "task", response: rewritten?.modifiedResponse, ...hookBase("c") } as never,
      store,
    );
    assert.equal(exact?.modifiedResponse, rewritten?.modifiedResponse);
  });
});

describe("tools", () => {
  it("handover tool refuses unattributed calls without claiming root", () => {
    const store = freshStore();
    const out = handleHandoverTool({ handover: "b", summary: "s" }, { sessionId: "ses-1" } as never, store, freshMemory(), {});
    assert.match(out, /no subagent identity/);
    assert.match(out, /nothing was stored/);
    assert.doesNotMatch(out, /root sessions/i);
    assert.equal(store.getHandover("ses-1"), undefined);
  });

  it("handover tool validates shape strictly and never takes identity from args", () => {
    const store = freshStore();
    const memory = freshMemory();
    const invocation = { sessionId: "ses-parent", agentId: "child-1" } as never;
    for (const args of [
      { handover: "   ", summary: "s" },
      { handover: "b", summary: "  " },
      { handover: "b" },
      { summary: "s" },
      { handover: "b", summary: "s", childId: "child-1" },
      { handover: "b", summary: "s", agentId: "child-1" },
      ["b", "s"],
      null,
    ]) {
      assert.throws(() => handleHandoverTool(args, invocation, store, memory, {}), /copilot tool/);
    }
  });

  it("handover tool stores once with unknown diagnostics and returns the receipt", () => {
    const store = freshStore();
    const memory = freshMemory();
    handleUsageInfo(usageEvent("child-1", 160000, 200000), store, memory, {});
    const out = handleHandoverTool(
      { handover: "body text", summary: "did things" },
      { sessionId: "ses-parent", agentId: "child-1" } as never,
      store,
      memory,
      {},
    );
    assert.match(out, /Handover stored/);
    assert.match(out, /Context handover \(incomplete\): did things/);
    assert.match(out, /read_handover\(\{"childId":"child-1"\}\)/);
    const stored = store.getHandover("child-1");
    assert.equal(stored?.handover, "body text");
    assert.equal(stored?.parentSessionId, "ses-parent");
    assert.equal(stored?.diagnostics.reason, "not-nudged");
    assert.equal(stored?.agentType, "unknown");
    const again = handleHandoverTool(
      { handover: "other", summary: "s2" },
      { sessionId: "ses-parent", agentId: "child-1" } as never,
      store,
      memory,
      {},
    );
    assert.match(again, /locked after a context handover/);
    assert.equal(store.getHandover("child-1")?.handover, "body text");
  });

  it("handover works with unknown usage, unknown window, and percent soft", () => {
    const store = freshStore();
    const out = handleHandoverTool(
      { handover: "body text", summary: "s" },
      { sessionId: "p", agentId: "c" } as never,
      store,
      freshMemory(),
      { [SOFT_ENV]: "50%" },
    );
    assert.match(out, /Handover stored/);
    assert.deepEqual(store.getHandover("c")?.diagnostics, { reason: "unknown" });
  });

  it("handover records the host-captured agent type", () => {
    const store = freshStore();
    const memory = freshMemory();
    handlePreToolUse({ agentId: "c", agentType: "task", toolName: "bash", ...hookBase("c") } as never, store, memory);
    handleHandoverTool({ handover: "h", summary: "s" }, { sessionId: "p", agentId: "c" } as never, store, memory, {});
    assert.equal(store.getHandover("c")?.agentType, "task");
  });

  it("read tool returns verbatim text with diagnostics or a plain notice", () => {
    const store = freshStore();
    assert.match(
      handleReadTool({ childId: "missing" }, {} as never, store),
      /No handover is stored for child "missing"/,
    );
    const memory = freshMemory();
    handleHandoverTool({ handover: "body text", summary: "s" }, { sessionId: "p", agentId: "c" } as never, store, memory, {});
    const out = handleReadTool({ childId: "c" }, {} as never, store);
    assert.match(out, /^Diagnostics: reason=/);
    assert.ok(out.endsWith("\n\nbody text"));
    assert.throws(() => handleReadTool({ childId: "" }, {} as never, store), /non-blank/);
    assert.throws(() => handleReadTool({ childId: "  " }, {} as never, store), /non-blank/);
    assert.throws(() => handleReadTool({}, {} as never, store), /non-blank/);
    assert.throws(() => handleReadTool({ childId: "c", full: true }, {} as never, store), /unexpected argument/);
  });

  it("read tool denies locked children directly", () => {
    const store = freshStore();
    const memory = freshMemory();
    handleHandoverTool({ handover: "h", summary: "s" }, { sessionId: "p", agentId: "c" } as never, store, memory, {});
    const out = handleReadTool({ childId: "c" }, { sessionId: "p", agentId: "c" } as never, store);
    assert.match(out, /locked after a context handover/);
    assert.ok(!out.includes("\n\nh"));
  });

  it("read header exposes recorded provenance over conflicting prose", () => {
    const store = freshStore();
    const memory = freshMemory();
    handlePreToolUse({ agentId: "c", agentType: "task", toolName: "bash", ...hookBase("c") } as never, store, memory);
    handleHandoverTool(
      { handover: "I am the root running model X", summary: "s" },
      { sessionId: "p", agentId: "c" } as never,
      store,
      memory,
      {},
    );
    const out = handleReadTool({ childId: "c" }, {} as never, store);
    const [head = ""] = out.split("\n\n");
    assert.match(head, /Provenance: childId="c", parentSessionId="p"/);
    assert.match(head, /agentType=\(recorded: task\)/);
    assert.match(head, /modelOverride=\(recorded: unknown, use predecessor spawn params\)/);
    assert.match(head, /authoritative/);
    assert.ok(out.endsWith("\n\nI am the root running model X"));
  });

  it("read warns above 50% of known soft and preserves the handover once", () => {
    const store = freshStore();
    const memory = freshMemory();
    const softEnv = { [SOFT_ENV]: "100" };
    handleUsageInfo(usageEvent("big", 90, 200000), store, memory, softEnv);
    const body = "x".repeat(204);
    handleHandoverTool({ handover: body, summary: "s" }, { sessionId: "p", agentId: "big" } as never, store, memory, softEnv);
    const out = handleReadTool({ childId: "big" }, {} as never, store);
    assert.match(out, /Seed size warning \(advisory only\)/);
    assert.match(out, /over 50% of the soft limit 100/);
    assert.match(out, /compress carried-over finished notes at its next handover/);
    assert.match(out, /Stored text is unchanged/);
    assert.equal(out.split(body).length - 1, 1);
    assert.ok(out.indexOf("Seed size warning") < out.indexOf(body));
    assert.ok(out.endsWith(`\n\n${body}`));
  });

  it("read stays silent at exactly 50% and with unknown soft", () => {
    const store = freshStore();
    const softEnv = { [SOFT_ENV]: "100" };
    const exactMemory = freshMemory();
    handleUsageInfo(usageEvent("exact", 90, 200000), store, exactMemory, softEnv);
    const exactBody = "x".repeat(200);
    handleHandoverTool({ handover: exactBody, summary: "s" }, { sessionId: "p", agentId: "exact" } as never, store, exactMemory, softEnv);
    const exactOut = handleReadTool({ childId: "exact" }, {} as never, store);
    assert.ok(!exactOut.includes("Seed size warning"));
    assert.ok(exactOut.endsWith(`\n\n${exactBody}`));
    const unknownMemory = freshMemory();
    const bigBody = "y".repeat(1000);
    handleHandoverTool(
      { handover: bigBody, summary: "s" },
      { sessionId: "p", agentId: "unknown-soft" } as never,
      store,
      unknownMemory,
      { [SOFT_ENV]: "50%" },
    );
    const unknownOut = handleReadTool({ childId: "unknown-soft" }, {} as never, store);
    assert.ok(!unknownOut.includes("Seed size warning"));
    assert.ok(unknownOut.endsWith(`\n\n${bigBody}`));
  });

  it("read strict caller check throws before any target result", () => {
    const store = freshStore();
    const memory = freshMemory();
    handleHandoverTool({ handover: "caller body", summary: "s" }, { sessionId: "p", agentId: "caller" } as never, store, memory, {});
    handleHandoverTool({ handover: "unrelated body", summary: "s" }, { sessionId: "p", agentId: "other" } as never, store, freshMemory(), {});
    for (const file of fs.readdirSync(store.handoversDir())) {
      const filePath = path.join(store.handoversDir(), file);
      try {
        if ((JSON.parse(fs.readFileSync(filePath, "utf8")) as { childId?: unknown }).childId === "caller") {
          fs.writeFileSync(filePath, "{not json", { mode: 0o600 });
        }
      } catch {
        // Keep scanning: an already-corrupt file is not the caller record.
      }
    }
    assert.throws(
      () => handleReadTool({ childId: "caller" }, { sessionId: "p", agentId: "caller" } as never, store),
      /copilot tool: cannot read handover/,
    );
    assert.throws(
      () => handleReadTool({ childId: "missing-target" }, { sessionId: "p", agentId: "caller" } as never, store),
      /copilot tool: cannot read handover/,
    );
    assert.throws(
      () => handleReadTool({ childId: "other" }, { sessionId: "p", agentId: "caller" } as never, store),
      /copilot tool: cannot read handover/,
    );
  });

  it("read strict caller check throws when the caller record is unreadable as a file", () => {
    const store = freshStore();
    const memory = freshMemory();
    handleHandoverTool({ handover: "caller body", summary: "s" }, { sessionId: "p", agentId: "caller" } as never, store, memory, {});
    handleHandoverTool({ handover: "unrelated body", summary: "s" }, { sessionId: "p", agentId: "other" } as never, store, freshMemory(), {});
    let callerPath: string | undefined;
    for (const file of fs.readdirSync(store.handoversDir())) {
      const filePath = path.join(store.handoversDir(), file);
      if ((JSON.parse(fs.readFileSync(filePath, "utf8")) as { childId?: unknown }).childId === "caller") {
        callerPath = filePath;
      }
    }
    assert.ok(callerPath !== undefined);
    fs.renameSync(callerPath as string, `${callerPath as string}.bak`);
    fs.mkdirSync(callerPath as string);
    assert.throws(
      () => handleReadTool({ childId: "other" }, { sessionId: "p", agentId: "caller" } as never, store),
      /copilot tool: cannot read handover/,
    );
  });

  it("notice, invocation and reply shapes name the exact tools", () => {
    assert.match(buildNotice("warn1"), /context_handover/);
    assert.equal(readInvocation("abc"), 'read_handover({"childId":"abc"})');
    assert.match(successorPrompt("abc"), /read_handover\(\{"childId":"abc"\}\)/);
    const store = freshStore();
    handleHandoverTool({ handover: "h", summary: "s" }, { sessionId: "p", agentId: "abc" } as never, store, freshMemory(), {});
    const reply = shortReply(store.getHandover("abc")!);
    assert.match(reply, /same logical subagent/);
    assert.match(reply, /same requested model override taken from the original spawn parameters/);
    assert.match(reply, /before replying to the user or making any decision/);
    assert.match(reply, /never claim a captured model/);
    assert.match(reply, /do not paste the handover into the spawn prompt/);
    assert.match(reply, /conditional advisory when the stored handover alone exceeds 50% of the known soft limit/);
    assert.doesNotMatch(reply, /trim the original-task pointer/);
    const locked = lockedReply(store.getHandover("abc")!);
    assert.match(locked, /same requested model override taken from the original spawn parameters/);
    assert.doesNotMatch(locked, /seed it with the original task pointer and the full handover/);
    assert.match(locked, /never paste the handover into the spawn prompt/);
  });

  it("handover works from os.tmpdir-backed plugin data env", () => {
    const dir = tempDir();
    const store = new CopilotStore(dir);
    const out = handleHandoverTool({ handover: "h", summary: "s" }, { sessionId: "p", agentId: "c" } as never, store, freshMemory(), {});
    assert.match(out, /Handover stored/);
  });
});

describe("session events", () => {
  it("routes usage and lifecycle events and ignores unknown types", () => {
    const store = freshStore();
    const memory = freshMemory();
    assert.equal(handleSessionEvent(usageEvent("c", 160000, 200000), store, memory, {}), true);
    assert.equal(memory.getObservation("c")?.estimatedTokens, 160000);
    assert.equal(
      handleSessionEvent({ type: "subagent.completed", agentId: "c" } as unknown as SessionEvent, store, memory, {}),
      true,
    );
    assert.equal(memory.getObservation("c"), undefined);
    memory.setObservation("c", { soft: 1 });
    assert.equal(
      handleSessionEvent({ type: "subagent.failed", agentId: "c" } as unknown as SessionEvent, store, memory, {}),
      true,
    );
    assert.equal(memory.getObservation("c"), undefined);
    assert.equal(handleSessionEvent({ type: "session.info" } as unknown as SessionEvent, store, memory, {}), false);
  });

  it("clears scoped state on compaction and context-cleared, all state when unattributed", () => {
    const store = freshStore();
    const memory = freshMemory();
    for (const type of ["session.compaction_start", "session.compaction_complete", "session.context_cleared"]) {
      memory.setObservation("c", { soft: 1 });
      assert.equal(handleSessionEvent({ type, agentId: "c" } as unknown as SessionEvent, store, memory, {}), true);
      assert.equal(memory.getObservation("c"), undefined);
    }
    memory.setObservation("a", { soft: 1 });
    memory.setObservation("b", { soft: 2 });
    assert.equal(
      handleSessionEvent({ type: "session.context_cleared" } as unknown as SessionEvent, store, memory, {}),
      true,
    );
    assert.equal(memory.getObservation("a"), undefined);
    assert.equal(memory.getObservation("b"), undefined);
  });
});

describe("extension wiring", () => {
  it("registers the exact tools, hooks, and subscriptions", () => {
    const store = freshStore();
    const config = buildExtensionConfig(store, freshMemory(), {});
    assert.deepEqual(config.tools.map((tool) => tool.name), ["context_handover", "read_handover"]);
    for (const tool of config.tools) {
      const parameters = tool.parameters as Record<string, unknown>;
      assert.equal(parameters["type"], "object");
      assert.equal(parameters["additionalProperties"], false);
      assert.ok(Array.isArray(parameters["required"]));
      assert.equal(tool.defer, "never");
    }
    const handoverParams = config.tools[0]?.parameters as Record<string, unknown>;
    assert.deepEqual(handoverParams["required"], ["handover", "summary"]);
    assert.deepEqual(Object.keys(handoverParams["properties"] as Record<string, unknown>).sort(), ["handover", "summary"]);
    const readParams = config.tools[1]?.parameters as Record<string, unknown>;
    assert.deepEqual(readParams["required"], ["childId"]);
    assert.deepEqual(Object.keys(readParams["properties"] as Record<string, unknown>), ["childId"]);
    assert.deepEqual(Object.keys(config.hooks).sort(), [
      "onPostToolUse",
      "onPreToolUse",
      "onSessionStart",
      "onSubagentStart",
      "onSubagentStop",
    ]);
    assert.deepEqual(config.subscriptions, [
      "session.usage_info",
      "subagent.completed",
      "subagent.failed",
      "session.context_cleared",
      "session.compaction_start",
      "session.compaction_complete",
    ]);
    assert.deepEqual(config.subscriptions, [...SESSION_SUBSCRIPTIONS]);
  });

  it("registered handlers run synthetically without a host", async () => {
    const store = freshStore();
    const config = buildExtensionConfig(store, freshMemory(), {});
    const handover = config.tools[0];
    assert.equal(typeof handover.handler, "function");
    const out = (await handover.handler?.(
      { handover: "h", summary: "s" },
      { sessionId: "p", agentId: "c", toolCallId: "t", toolName: "context_handover", arguments: {} },
    )) as string;
    assert.match(out, /Handover stored/);
    const read = config.tools[1];
    const back = (await read.handler?.(
      { childId: "c" },
      { sessionId: "p", agentId: "parent", toolCallId: "t", toolName: "read_handover", arguments: {} },
    )) as string;
    assert.ok(back.endsWith("\n\nh"));
    const started = await config.hooks.onSessionStart?.({} as never, {} as never);
    assert.match(started?.additionalContext ?? "", /plugin workflow/);
    const start = await config.hooks.onSubagentStart?.({ agentName: "x" } as never, {} as never);
    assert.match(start?.additionalContext ?? "", /plugin workflow/);
  });

  it("manifest extensions path resolves to the wiring entry point", () => {
    const manifestPath = new URL("./plugin.json", import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { extensions?: unknown };
    assert.deepEqual(manifest.extensions, ["."]);
    assert.equal(fs.existsSync(new URL("./extension.mjs", import.meta.url)), true);
  });
});
