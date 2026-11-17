// Pi adapter fixtures: fake ExtensionAPI capturing hooks/tools/commands/flags.
// No host, no network, no model calls.
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readFile, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let agentDirectory: string;
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const originalChildFlag = process.env.PI_SUBAGENT_CHILD;
beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), "handover-pi-"));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  delete process.env.PI_SUBAGENT_CHILD;
});
afterEach(async () => {
  await rm(agentDirectory, { recursive: true, force: true });
  if (originalChildFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChildFlag;
  if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
});
import assert from "node:assert/strict";
import createExtension from "./index.ts";
import { openCodeStageText } from "../source/shared/handover-text.ts";
import { SEED_FRAMING } from "../source/shared/handover-text.ts";

const ENTRY_TYPE = "auto-context-handover";

interface RecordedNotify {
  readonly message: string;
  readonly level: string | undefined;
}

interface FakeSessionManager {
  branch: Array<Record<string, unknown>>;
  sessionId: string;
  sessionFile: string | undefined;
  leafId: string | null;
  failBranch: boolean;
  getBranchCalls: number;
}

const entry = (id: string, customType: string, data: unknown): Record<string, unknown> => ({
  type: "custom",
  id,
  parentId: null,
  timestamp: new Date().toISOString(),
  customType,
  data,
});

function createSessionManager(overrides: Partial<FakeSessionManager> = {}): FakeSessionManager {
  return {
    branch: [],
    sessionId: "sess-1",
    sessionFile: "/sessions/sess-1.jsonl",
    leafId: "leaf-initial",
    failBranch: false,
    getBranchCalls: 0,
    ...overrides,
  };
}

interface FakePi {
  handlers: Map<string, Array<(...args: Array<never>) => unknown>>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  flags: Map<string, any>;
  flagValues: Record<string, string | boolean | undefined>;
  appended: Array<{ id: string; customType: string; data: unknown }>;
  currentSession: FakeSessionManager | undefined;
  leafCounter: number;
  failAppend: boolean;
  failSend: boolean;
  sentUserMessages: unknown[];
  setModels: unknown[];
  thinking: string;
  activeCtx: any;
  notified: RecordedNotify[];
  api: any;
}

function createFakePi(): FakePi {
  const fake: FakePi = {
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    flags: new Map(),
    flagValues: {},
    appended: [],
    currentSession: undefined,
    leafCounter: 0,
    failAppend: false,
    failSend: false,
    sentUserMessages: [],
    setModels: [],
    thinking: "high",
    activeCtx: undefined,
    notified: [],
    api: undefined,
  };
  fake.api = {
    on: (event: string, handler: (...args: Array<never>) => unknown) => {
      const list = fake.handlers.get(event) ?? [];
      list.push(handler);
      fake.handlers.set(event, list);
    },
    registerTool: (def: any) => {
      fake.tools.set(def.name, def);
    },
    registerCommand: (name: string, options: any) => {
      fake.commands.set(name, options);
    },
    registerFlag: (name: string, options: any) => {
      fake.flags.set(name, options);
      if (options.default !== undefined) fake.flagValues[name] = options.default;
    },
    getFlag: (name: string) => fake.flagValues[name],
    appendEntry: (customType: string, data?: unknown) => {
      if (fake.failAppend) throw new Error("append boom");
      const id = `leaf-${++fake.leafCounter}`;
      fake.appended.push({ id, customType, data });
      const session = fake.currentSession;
      if (session) {
        session.branch.push({
          type: "custom",
          id,
          parentId: session.leafId,
          timestamp: new Date().toISOString(),
          customType,
          data,
        });
        session.leafId = id;
      }
    },
    sendUserMessage: (...args: unknown[]) => {
      if (fake.failSend) throw new Error("dispatch boom");
      fake.sentUserMessages.push(args);
    },
    setModel: (...args: unknown[]) => {
      fake.setModels.push(args);
      if (fake.activeCtx) fake.activeCtx.model = args[0];
      return Promise.resolve(true);
    },
    getThinkingLevel: () => fake.thinking,
    setThinkingLevel: (thinking: string) => {
      fake.thinking = thinking;
      if (fake.activeCtx) fake.activeCtx.thinkingLevel = thinking;
    },
    sendMessage: () => {
      throw new Error("sendMessage must not be called");
    },
    exec: () => {
      throw new Error("exec must not be called");
    },
  };
  return fake;
}

interface FakeCtxOptions {
  fake?: FakePi;
  session?: FakeSessionManager;
  usage?: { tokens: unknown; contextWindow: unknown } | undefined | (() => unknown);
  model?: { provider: string; id: string } | undefined;
  notified?: RecordedNotify[];
  notifyThrows?: boolean;
  systemPrompt?: string;
}

function createToolCtx(options: FakeCtxOptions = {}): any {
  const session = options.session ?? createSessionManager();
  const usage = options.usage;
  if (options.fake) options.fake.currentSession = session;
  return {
    sessionManager: {
      getSessionId: () => session.sessionId,
      getSessionFile: () => session.sessionFile,
      getLeafId: () => session.leafId,
      getBranch: () => {
        session.getBranchCalls += 1;
        if (session.failBranch) throw new Error("branch boom");
        return session.branch;
      },
      getEntries: () => {
        throw new Error("must use getBranch, not getEntries");
      },
      getTree: () => {
        throw new Error("must use getBranch, not getTree");
      },
    },
    model: options.model === undefined ? { provider: "anthropic", id: "claude-x" } : options.model,
    thinkingLevel: "high",
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    getSystemPrompt: () => options.systemPrompt ?? "Root system prompt",
    getContextUsage: typeof usage === "function" ? usage : () => usage,
    ui: {
      notify: (message: string, level?: string) => {
        options.notified?.push({ message, level: level ?? "info" });
        if (options.notifyThrows) throw new Error("stale ctx");
      },
    },
  };
}

const emit = async (fake: FakePi, event: string, payload: any, ctx: any): Promise<any> => {
  const handlers = fake.handlers.get(event) ?? [];
  let result: any;
  for (const handler of handlers) {
    result = await (handler as (e: any, c: any) => unknown)(payload, ctx);
  }
  return result;
};

const validUsage = (tokens: unknown, contextWindow: unknown) => ({ tokens, contextWindow });

describe("pi registration", () => {
  it("registers tools, command, and flag without side effects at load", () => {
    const fake = createFakePi();
    createExtension(fake.api);
    assert.ok(fake.tools.has("context_handover"));
    assert.ok(fake.tools.has("read_handover"));
    assert.ok(fake.commands.has("handover"));
    assert.ok(fake.flags.has("handover-soft"));
    assert.equal(fake.flags.get("handover-soft").type, "string");
    const description = fake.tools.get("context_handover").description as string;
    assert.ok(description.includes("automatically"));
    assert.ok(!/manual by default|No automatic rollover|user runs \/handover to continue manually/i.test(description));
    assert.deepEqual(fake.appended, []);
    assert.deepEqual(fake.sentUserMessages, []);
    assert.deepEqual(fake.setModels, []);
  });

  it("intro is a custom message with no system prompt rewrite and no direct storage writes", async () => {
    // The fake only proves the extension itself calls no storage API; the
    // host persists the returned message into the session per turn.
    const fake = createFakePi();
    createExtension(fake.api);
    const ctx = createToolCtx({ usage: validUsage(10, 200000) });
    const result = await emit(fake, "before_agent_start", { prompt: "hi" }, ctx);
    assert.ok(result && typeof result === "object");
    assert.ok(!("systemPrompt" in (result as Record<string, unknown>)));
    const message = (result as any).message;
    assert.equal(typeof message.customType, "string");
    assert.ok((message.content as string).includes("context_handover"));
    assert.ok((message.content as string).includes("/handover"));
    assert.ok((message.content as string).includes("automatic"));
    assert.ok((message.content as string).includes("current step"));
    assert.deepEqual(fake.appended, []);
    assert.deepEqual(fake.sentUserMessages, []);
  });

  it("notices reference the installed intro for the current step", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    const ctx = createToolCtx({ usage: validUsage(150000, 200000) });
    const result = await emit(fake, "context", { messages: [] }, ctx);
    const last = (result as any).messages.at(-1);
    assert.ok((last.content as string).includes("auto-context-handover intro"));
    assert.ok((last.content as string).includes("current step"));
    assert.ok((last.content as string).includes("rollover follows automatically"));
  });
});

describe("pi thresholds and usage", () => {
  const noticeFor = async (tokens: unknown, window: unknown, flag?: string): Promise<any> => {
    const fake = createFakePi();
    createExtension(fake.api);
    if (flag !== undefined) fake.flagValues["handover-soft"] = flag;
    const base = [
      { role: "user", content: "hello", timestamp: 1 },
    ] as Array<Record<string, unknown>>;
    const ctx = createToolCtx({ usage: validUsage(tokens, window) });
    const result = await emit(fake, "context", { messages: base }, ctx);
    return { result, base };
  };

  it("default soft 200000 capped at 70% of the window", async () => {
    // 70% of 200000 = 140000; 150000 estimate clears it.
    const { result, base } = await noticeFor(150000, 200000);
    assert.ok(result && Array.isArray((result as any).messages));
    assert.equal((result as any).messages.length, base.length + 1);
    assert.equal(base.length, 1);
    const last = (result as any).messages.at(-1);
    assert.equal(last.role, "user");
    assert.ok((last.content as string).startsWith(openCodeStageText("warn1")));
  });

  it("stays silent below the soft threshold and leaves input untouched", async () => {
    const { result, base } = await noticeFor(100000, 200000);
    assert.equal(result, undefined);
    assert.equal(base.length, 1);
  });

  it("integer flag applies; explicit percentages are uncapped", async () => {
    // 90% of 200000 = 180000, above the 70% cap: uncapped percent.
    const below = await noticeFor(170000, 200000, "90%");
    assert.equal(below.result, undefined);
    const above = await noticeFor(185000, 200000, "90%");
    assert.ok(above.result);
  });

  it("fixed stage boundaries: soft, soft*1.1, soft*1.2", async () => {
    const at = async (tokens: number) => noticeFor(tokens, 10_000_000_000, "100000");
    assert.equal((await at(99999)).result, undefined);
    assert.ok(((await at(100000)).result as any).messages.at(-1).content.startsWith(openCodeStageText("warn1")));
    assert.ok(((await at(110001)).result as any).messages.at(-1).content.startsWith(openCodeStageText("warn2")));
    assert.ok(((await at(120001)).result as any).messages.at(-1).content.startsWith(openCodeStageText("warn3")));
  });

  it("unknown window: numerics apply uncapped, percents fail open", async () => {
    const numeric = await noticeFor(210000, 0, undefined);
    assert.ok(numeric.result);
    const fake = createFakePi();
    createExtension(fake.api);
    fake.flagValues["handover-soft"] = "70%";
    const ctx = createToolCtx({ usage: validUsage(999999, 0) });
    const out = await emit(fake, "context", { messages: [] }, ctx);
    assert.equal(out, undefined);
  });

  it("unknown or malformed usage fails open with no notice", async () => {
    for (const usage of [undefined, { tokens: null, contextWindow: 200000 }, { tokens: -5, contextWindow: 200000 }, { tokens: Number.NaN, contextWindow: 200000 }, { tokens: "lots", contextWindow: 200000 }]) {
      const { result } = await noticeFor((usage as any)?.tokens, (usage as any)?.contextWindow);
      assert.equal(result, undefined);
    }
    const fake = createFakePi();
    createExtension(fake.api);
    const ctx = createToolCtx({ usage: () => { throw new Error("usage boom"); } });
    assert.equal(await emit(fake, "context", { messages: [] }, ctx), undefined);
  });

  it("invalid flags are reported at session start and never nudged or substituted", async () => {
    for (const flag of ["0", "0%", "101%", "1.5", "nonsense", "-5", true]) {
      const fake = createFakePi();
      createExtension(fake.api);
      fake.flagValues["handover-soft"] = flag as string;
      const notified: RecordedNotify[] = [];
      const startCtx = createToolCtx({ notified });
      await emit(fake, "session_start", { type: "session_start", reason: "startup" }, startCtx);
      assert.ok(
        notified.some((n) => n.level === "error" && n.message.includes("--handover-soft")),
        `expected explicit flag error for ${String(flag)}`,
      );
      // Even far past any threshold: fail open, no silent default substitution.
      const ctx = createToolCtx({ usage: validUsage(999999, 200000) });
      assert.equal(await emit(fake, "context", { messages: [] }, ctx), undefined);
    }
  });

  it("invalid flags record unknown diagnostics instead of a substituted threshold", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    fake.flagValues["handover-soft"] = "nonsense";
    const session = createSessionManager();
    const ctx = createToolCtx({ session, usage: validUsage(999999, 200000) });
    await emit(fake, "context", { messages: [] }, ctx);
    await fake.tools.get("context_handover").execute("t1", { handover: "b", summary: "s" }, undefined, undefined, ctx);
    assert.deepEqual((fake.appended[0].data as any).diag, {
      reason: "unknown",
      stage: "unknown",
      estimate: 999999,
      soft: "unknown",
    });
  });

  it("valid flags stay quiet at session start", async () => {
    for (const flag of [undefined, "1000", "70%"]) {
      const fake = createFakePi();
      createExtension(fake.api);
      if (flag !== undefined) fake.flagValues["handover-soft"] = flag;
      const notified: RecordedNotify[] = [];
      const ctx = createToolCtx({ notified });
      await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);
      assert.deepEqual(notified, []);
    }
  });
});

describe("pi handover tool", () => {
  const store = async (
    fake: FakePi,
    handover: string,
    summary: string,
    ctx: any,
  ): Promise<any> => fake.tools.get("context_handover").execute("t1", { handover, summary }, undefined, undefined, ctx);

  it("stores strings verbatim with session id, model, and call-time diagnostics", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    const session = createSessionManager();
    const noticeCtx = createToolCtx({ session, usage: validUsage(150000, 200000) });
    await emit(fake, "context", { messages: [] }, noticeCtx);
    const tricky = "verbatim \n text \t with \u201cquotes\u201d and $pecial {chars}";
    const result = await store(fake, tricky, "did things, next does more", noticeCtx);
    assert.equal(fake.appended.length, 1);
    assert.equal(fake.appended[0].customType, ENTRY_TYPE);
    const data = fake.appended[0].data as Record<string, any>;
    assert.equal(data.handover, tricky);
    assert.equal(data.summary, "did things, next does more");
    assert.equal(data.sessionId, "sess-1");
    assert.equal(data.model.provider, "anthropic");
    assert.equal(data.model.id, "claude-x");
    assert.deepEqual(data.diag, { reason: "nudged", stage: "warn1", estimate: 150000, soft: 140000 });
    const text = (result.content[0] as { text: string }).text;
    assert.ok(text.includes("End your turn"));
    assert.ok(text.includes("automatically once this turn settles"));
    assert.ok(text.includes("/handover"));
    assert.equal(result.terminate, true);
  });

  it("records not-nudged diagnostics when under threshold and unknown after reload", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    const session = createSessionManager();
    const ctx = createToolCtx({ session, usage: validUsage(10, 200000) });
    await emit(fake, "context", { messages: [] }, ctx);
    await store(fake, "handover body", "summary", ctx);
    assert.equal((fake.appended[0].data as any).diag.reason, "not-nudged");

    const reloaded = createFakePi();
    createExtension(reloaded.api);
    const fresh = createToolCtx({ session, usage: validUsage(10, 200000) });
    await reloaded.tools.get("context_handover").execute("t1", { handover: "b", summary: "s" }, undefined, undefined, fresh);
    assert.deepEqual((reloaded.appended[0].data as any).diag, {
      reason: "unknown",
      stage: "unknown",
      estimate: "unknown",
      soft: "unknown",
    });
  });

  it("rejects whitespace-only inputs and reports append failure without false success", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    const ctx = createToolCtx({});
    await assert.rejects(() => store(fake, "   ", "s", ctx), /non-empty/);
    await assert.rejects(() => store(fake, "h", "  \n\t ", ctx), /non-empty/);
    assert.equal(fake.appended.length, 0);
    fake.failAppend = true;
    await assert.rejects(() => store(fake, "h", "s", ctx), /failed to store handover/);
  });

  it("ephemeral sessions get persistent shared-storage wording", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    const session = createSessionManager({ sessionFile: undefined });
    const ctx = createToolCtx({ session });
    const result = await store(fake, "h", "s", ctx);
    assert.ok(((result.content[0] as { text: string }).text as string).includes("private shared copy"));
  });

  it("readback returns the latest active-branch handover plus diagnostics", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    const old = entry("e1", ENTRY_TYPE, {
      handover: "old body",
      summary: "old",
      sessionId: "sess-1",
      model: { provider: "p", id: "m" },
      storedAt: 1,
      diag: { reason: "nudged", stage: "warn1", estimate: 5, soft: 4 },
    });
    const meta = entry("e2", "auto-context-handover:seed", { sourceSession: "sess-1" });
    const latest = entry("e3", ENTRY_TYPE, {
      handover: "new body",
      summary: "new",
      sessionId: "sess-1",
      model: { provider: "p", id: "m" },
      storedAt: 2,
      diag: { reason: "not-nudged", stage: "ok", estimate: 1, soft: 4 },
    });
    const session = createSessionManager({ branch: [old, meta, latest] });
    const ctx = createToolCtx({ session });
    const result = await fake.tools.get("read_handover").execute("t1", {}, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;
    assert.ok(text.includes("new body"));
    assert.ok(!text.includes("old body"));
    assert.ok(text.includes("Diagnostics:"));
    assert.ok(text.includes("not-nudged"));
  });

  it("readback reports absence without error", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    const ctx = createToolCtx({ session: createSessionManager({ branch: [] }) });
    const result = await fake.tools.get("read_handover").execute("t1", {}, undefined, undefined, ctx);
    assert.ok(((result.content[0] as { text: string }).text as string).includes("No handover stored"));
  });
});

const verifiedFresh = () => ({
  model: { provider: "anthropic", id: "claude-x" },
  thinkingLevel: "high",
  sessionManager: { getBranch: () => [entry("restored", "auto-context-handover:restore", {
    sourceSession: "sess-1", selection: { provider: "anthropic", model: "claude-x", thinking: "high" },
  })] },
});

describe("pi /handover command", () => {
  const payload = (handover: string, summary = "finish the migration"): Record<string, unknown> => ({
    type: "custom",
    id: "e1",
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: ENTRY_TYPE,
    data: {
      handover,
      summary,
      sessionId: "sess-1",
      model: { provider: "anthropic", id: "claude-x" },
      storedAt: 1,
      diag: { reason: "nudged", stage: "warn1", estimate: 5, soft: 4 },
    },
  });

  interface CommandHarness {
    fake: FakePi;
    session: FakeSessionManager;
    notified: RecordedNotify[];
    waited: boolean;
    onWait?: () => void;
    waitThrows: boolean;
    setupThrows: boolean;
    notifyThrowsOnError: boolean;
    newSessionCalls: any[];
    newSessionBehavior: "ok" | "cancel" | "throw";
    ctx: any;
  }

  const harness = (branch: Array<Record<string, unknown>>, sessionFile: string | null = "/sessions/sess-1.jsonl"): CommandHarness => {
    const fake = createFakePi();
    createExtension(fake.api);
    const h: CommandHarness = {
      fake,
      session: undefined as unknown as FakeSessionManager,
      notified: [],
      waited: false,
      waitThrows: false,
      setupThrows: false,
      notifyThrowsOnError: false,
      newSessionCalls: [],
      newSessionBehavior: "ok",
      ctx: undefined,
    };
    const session = createSessionManager({ branch, sessionFile: sessionFile ?? undefined });
    h.session = session;
    h.ctx = {
      sessionManager: {
        getSessionId: () => session.sessionId,
        getSessionFile: () => session.sessionFile,
        getBranch: () => {
          if (session.failBranch) throw new Error("branch boom");
          return session.branch;
        },
        getEntries: () => {
          throw new Error("must use getBranch, not getEntries");
        },
      },
      model: { provider: "anthropic", id: "claude-x" },
      getSystemPrompt: () => "Root system prompt",
      getContextUsage: () => validUsage(10, 200000),
      waitForIdle: async () => {
        h.waited = true;
        h.onWait?.();
        if (h.waitThrows) throw new Error("idle boom");
      },
      ui: {
        notify: (message: string, level?: "info" | "warning" | "error") => {
          h.notified.push({ message, level: level ?? "info" });
          if (h.notifyThrowsOnError && level === "error") throw new Error("stale source ctx");
        },
      },
      newSession: async (options: any) => {
        h.newSessionCalls.push(options);
        if (h.newSessionBehavior === "cancel") return { cancelled: true };
        if (h.setupThrows) {
          await options.setup({
            appendMessage: () => {
              throw new Error("seed boom");
            },
            appendCustomEntry: () => "x",
          });
        }
        if (h.newSessionBehavior === "throw") throw new Error("switch boom");
        return { cancelled: false };
      },
    };
    return h;
  };

  it("rejects arguments and missing payloads without touching sessions or models", async () => {
    const withArgs = harness([payload("body")]);
    await withArgs.fake.commands.get("handover").handler(" extra", withArgs.ctx);
    assert.ok(withArgs.notified.some((n) => n.level === "error"));
    assert.equal(withArgs.newSessionCalls.length, 0);

    const empty = harness([]);
    await empty.fake.commands.get("handover").handler("", empty.ctx);
    assert.ok(empty.notified.some((n) => n.level === "error" && n.message.includes("no handover")));
    assert.equal(empty.newSessionCalls.length, 0);
    assert.deepEqual(empty.fake.sentUserMessages, []);
  });

  it("seeds the verbatim handover once and continues via the fresh context only", async () => {
    const handover = "unique-marker-12345 full body";
    const h = harness([payload(handover)]);
    const staleSends: unknown[] = [];
    h.ctx.sendUserMessage = (...args: unknown[]) => {
      staleSends.push(args);
    };
    await h.fake.commands.get("handover").handler("", h.ctx);
    assert.equal(h.waited, true);
    assert.equal(h.newSessionCalls.length, 1);
    assert.ok(
      h.notified.some(
        (n) => n.level === "info" && n.message.includes("replacing this session") && n.message.includes("/handover"),
      ),
    );
    const options = h.newSessionCalls[0];
    assert.equal(options.parentSession, "/sessions/sess-1.jsonl");

    const appendedMessages: unknown[] = [];
    const appendedEntries: unknown[] = [];
    await options.setup({
      appendMessage: (message: unknown) => {
        appendedMessages.push(message);
        return "seed-id";
      },
      appendCustomEntry: (customType: string, data: unknown) => {
        appendedEntries.push({ customType, data });
        return "meta-id";
      },
    });
    assert.equal(appendedMessages.length, 1);
    const seed = (appendedMessages[0] as { content: string }).content;
    assert.ok(seed.includes(SEED_FRAMING));
    assert.equal(seed.split(handover).length - 1, 1);
    assert.equal(appendedEntries.length, 1);

    const freshSends: unknown[] = [];
    const freshNotifies: RecordedNotify[] = [];
    await options.withSession({
      ...verifiedFresh(),
      sendUserMessage: async (text: unknown) => {
        freshSends.push(text);
      },
      ui: {
        notify: (message: string, level?: string) => {
          freshNotifies.push({ message, level: level ?? "info" });
        },
      },
    });
    assert.equal(freshSends.length, 1);
    assert.ok((freshSends[0] as string).includes("Prioritized next steps"));
    assert.deepEqual(staleSends, []);
    assert.deepEqual(h.fake.sentUserMessages, []);
  });

  it("reads the branch after waitForIdle settles: missing becomes stored", async () => {
    const h = harness([]);
    h.onWait = () => {
      h.session.branch.push(payload("late body", "late summary"));
    };
    await h.fake.commands.get("handover").handler("", h.ctx);
    assert.equal(h.waited, true);
    assert.equal(h.newSessionCalls.length, 1);
    const appendedMessages: unknown[] = [];
    await h.newSessionCalls[0].setup({
      appendMessage: (message: unknown) => {
        appendedMessages.push(message);
        return "seed-id";
      },
      appendCustomEntry: () => "meta-id",
    });
    assert.ok(((appendedMessages[0] as { content: string }).content as string).includes("late body"));
  });

  it("reads the branch after waitForIdle settles: newer handover wins", async () => {
    const h = harness([payload("old body", "old summary")]);
    h.onWait = () => {
      h.session.branch.push({ ...payload("new body", "new summary"), id: "e2" });
    };
    await h.fake.commands.get("handover").handler("", h.ctx);
    assert.equal(h.newSessionCalls.length, 1);
    const appendedMessages: unknown[] = [];
    await h.newSessionCalls[0].setup({
      appendMessage: (message: unknown) => {
        appendedMessages.push(message);
        return "seed-id";
      },
      appendCustomEntry: () => "meta-id",
    });
    const seed = (appendedMessages[0] as { content: string }).content as string;
    assert.equal(seed.split("new body").length - 1, 1);
    assert.ok(!seed.includes("old body"));
  });

  it("a waitForIdle failure refuses replacement without touching sessions", async () => {
    const h = harness([payload("body")]);
    h.waitThrows = true;
    await h.fake.commands.get("handover").handler("", h.ctx);
    assert.equal(h.waited, true);
    assert.equal(h.newSessionCalls.length, 0);
    assert.ok(h.notified.some((n) => n.level === "error" && n.message.includes("refusing to replace anything")));
    assert.deepEqual(h.fake.sentUserMessages, []);
  });

  it("a setup failure reports an unconfirmable outcome without claiming the source is unchanged", async () => {
    const h = harness([payload("body")]);
    h.setupThrows = true;
    await h.fake.commands.get("handover").handler("", h.ctx);
    const errors = h.notified.filter((n) => n.level === "error");
    assert.ok(errors.some((n) => n.message.includes("cannot be confirmed")));
    assert.ok(errors.every((n) => !n.message.includes("unchanged") && !n.message.includes("remains in the source")));
  });

  it("refuses to fall back to an older handover when the latest entry is malformed", async () => {
    const malformed: Record<string, unknown> = {
      type: "custom",
      id: "e2",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: ENTRY_TYPE,
      data: { handover: 42, summary: "broken" },
    };
    const fake = createFakePi();
    createExtension(fake.api);
    const readCtx = createToolCtx({ session: createSessionManager({ branch: [payload("old body"), malformed] }) });
    const result = await fake.tools.get("read_handover").execute("t1", {}, undefined, undefined, readCtx);
    const text = (result.content[0] as { text: string }).text as string;
    assert.ok(text.includes("invalid"));
    assert.ok(!text.includes("old body"));

    const h = harness([payload("old body"), malformed]);
    await h.fake.commands.get("handover").handler("", h.ctx);
    assert.equal(h.newSessionCalls.length, 0);
    assert.ok(h.notified.some((n) => n.level === "error" && n.message.includes("invalid")));
  });

  it("omits the parent session for ephemeral sources", async () => {
    const h = harness([payload("body")], null);
    await h.fake.commands.get("handover").handler("", h.ctx);
    assert.equal(h.newSessionCalls.length, 1);
    assert.ok(!("parentSession" in h.newSessionCalls[0]));
  });

  it("warns on oversized seeds, reports cancel cleanly, and never claims success on error", async () => {
    const big = harness([payload("x".repeat(100000))]);
    big.fake.flagValues["handover-soft"] = "1000";
    await big.fake.commands.get("handover").handler("", big.ctx);
    assert.ok(big.notified.some((n) => n.level === "warning" && n.message.includes("50%")));

    const cancelled = harness([payload("body")]);
    cancelled.newSessionBehavior = "cancel";
    await cancelled.fake.commands.get("handover").handler("", cancelled.ctx);
    assert.ok(cancelled.notified.some((n) => n.message.includes("unchanged")));

    const failed = harness([payload("body")]);
    failed.newSessionBehavior = "throw";
    await failed.fake.commands.get("handover").handler("", failed.ctx);
    const errors = failed.notified.filter((n) => n.level === "error");
    assert.ok(errors.length > 0);
    assert.ok(errors.every((n) => !n.message.includes("complete") && !n.message.includes("ready")));
  });

  it("reports replacement-context failures through the fresh context", async () => {
    const h = harness([payload("body")]);
    await h.fake.commands.get("handover").handler("", h.ctx);
    const options = h.newSessionCalls[0];
    const freshNotifies: RecordedNotify[] = [];
    await options.withSession({
      ...verifiedFresh(),
      sendUserMessage: async () => {
        throw new Error("kickoff boom");
      },
      ui: {
        notify: (message: string, level?: string) => {
          freshNotifies.push({ message, level: level ?? "info" });
        },
      },
    });
    assert.ok(freshNotifies.some((n) => n.level === "error" && n.message.includes("continuation prompt failed")));
  });

  it("throws a clear host error when a stale source ctx cannot carry a replacement failure", async () => {
    const h = harness([payload("body")]);
    h.notifyThrowsOnError = true;
    h.newSessionBehavior = "throw";
    await assert.rejects(
      () => h.fake.commands.get("handover").handler("", h.ctx),
      /handover continuation failed[\s\S]*run \/handover[\s\S]*stale source ctx/,
    );
  });

  it("throws a clear host error when a stale fresh ctx cannot carry a continuation failure", async () => {
    const h = harness([payload("body")]);
    await h.fake.commands.get("handover").handler("", h.ctx);
    const options = h.newSessionCalls[0];
    await assert.rejects(
      () =>
        options.withSession({
          ...verifiedFresh(),
          sendUserMessage: async () => {
            throw new Error("kickoff boom");
          },
          ui: {
            notify: () => {
              throw new Error("stale fresh ctx");
            },
          },
        }),
      /continuation prompt failed[\s\S]*run \/handover[\s\S]*stale fresh ctx/,
    );
  });
});

describe("pi automatic rollover", () => {
  const setup = (overrides: Partial<FakeSessionManager> = {}, notifyThrows = false) => {
    const fake = createFakePi();
    createExtension(fake.api);
    const session = createSessionManager(overrides);
    const notified: RecordedNotify[] = [];
    const ctx = createToolCtx({ fake, session, notified, notifyThrows });
    return { fake, session, notified, ctx };
  };

  const start = async (fake: FakePi, ctx: any): Promise<void> => {
    await emit(fake, "agent_start", { type: "agent_start" }, ctx);
  };

  const store = async (fake: FakePi, ctx: any, handover = "automatic body", summary = "automatic summary"): Promise<any> =>
    fake.tools.get("context_handover").execute("t1", { handover, summary }, undefined, undefined, ctx);

  const settle = async (fake: FakePi, ctx: any, aborted = false): Promise<void> => {
    await emit(fake, "agent_settled", { type: "agent_settled", aborted }, ctx);
  };

  it("dispatches the registered command once with expansion after successful storage and settlement", async () => {
    const { fake, ctx, notified } = setup();
    await start(fake, ctx);
    const result = await store(fake, ctx);
    assert.equal(result.terminate, true);
    assert.equal(fake.sentUserMessages.length, 0);

    await settle(fake, ctx);
    assert.deepEqual(fake.sentUserMessages, [["/handover", { expandPromptTemplates: true }]]);
    assert.ok(!notified.some((n) => n.level === "error"));

    await settle(fake, ctx);
    assert.equal(fake.sentUserMessages.length, 1);
  });

  it("never replays a historical handover or a readback", async () => {
    const { fake, session, ctx } = setup();
    await settle(fake, ctx);
    session.branch.push({
      type: "custom",
      id: "historic",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: ENTRY_TYPE,
      data: {
        handover: "old body",
        summary: "old",
        sessionId: "sess-1",
        model: { provider: "p", id: "m" },
        storedAt: 1,
        diag: { reason: "unknown", stage: "unknown", estimate: "unknown", soft: "unknown" },
      },
    });
    await settle(fake, ctx);
    await fake.tools.get("read_handover").execute("t2", {}, undefined, undefined, ctx);
    await settle(fake, ctx);
    assert.deepEqual(fake.sentUserMessages, []);
  });

  it("does not queue an automatic rollover when storage fails", async () => {
    const { fake, ctx } = setup();
    await start(fake, ctx);
    fake.failAppend = true;
    await assert.rejects(() => store(fake, ctx), /failed to store handover/);
    fake.failAppend = false;
    await settle(fake, ctx);
    assert.deepEqual(fake.sentUserMessages, []);
  });

  it("skips replay when session, branch, run or lifecycle no longer matches", async () => {
    const sessionMismatch = setup();
    await start(sessionMismatch.fake, sessionMismatch.ctx);
    await store(sessionMismatch.fake, sessionMismatch.ctx);
    const otherCtx = createToolCtx({
      fake: sessionMismatch.fake,
      session: createSessionManager({ sessionId: "sess-other" }),
    });
    await settle(sessionMismatch.fake, otherCtx);
    assert.deepEqual(sessionMismatch.fake.sentUserMessages, []);

    const branchMismatch = setup();
    await start(branchMismatch.fake, branchMismatch.ctx);
    await store(branchMismatch.fake, branchMismatch.ctx);
    branchMismatch.session.branch = [];
    await settle(branchMismatch.fake, branchMismatch.ctx);
    assert.deepEqual(branchMismatch.fake.sentUserMessages, []);

    const runMismatch = setup();
    await start(runMismatch.fake, runMismatch.ctx);
    await store(runMismatch.fake, runMismatch.ctx);
    await start(runMismatch.fake, runMismatch.ctx);
    await settle(runMismatch.fake, runMismatch.ctx);
    assert.deepEqual(runMismatch.fake.sentUserMessages, []);

    const shutdown = setup();
    await start(shutdown.fake, shutdown.ctx);
    await store(shutdown.fake, shutdown.ctx);
    await emit(shutdown.fake, "session_shutdown", { type: "session_shutdown", reason: "quit" }, shutdown.ctx);
    await settle(shutdown.fake, shutdown.ctx);
    assert.deepEqual(shutdown.fake.sentUserMessages, []);
  });

  it("keeps the latest repeated store single-use and never retries after abort", async () => {
    const repeats = setup();
    await start(repeats.fake, repeats.ctx);
    await store(repeats.fake, repeats.ctx, "first body");
    await store(repeats.fake, repeats.ctx, "second body");
    await settle(repeats.fake, repeats.ctx);
    assert.equal(repeats.fake.sentUserMessages.length, 1);

    const aborted = setup();
    await start(aborted.fake, aborted.ctx);
    await store(aborted.fake, aborted.ctx);
    await settle(aborted.fake, aborted.ctx, true);
    await settle(aborted.fake, aborted.ctx);
    assert.deepEqual(aborted.fake.sentUserMessages, []);
  });

  it("reports synchronous dispatch failure with source recovery guidance, including stale ctx", async () => {
    const { fake, ctx, notified } = setup();
    await start(fake, ctx);
    await store(fake, ctx);
    fake.failSend = true;
    await settle(fake, ctx);
    assert.ok(
      notified.some(
        (n) =>
          n.level === "error" &&
          n.message.includes("automatic rollover dispatch failed") &&
          n.message.includes("sess-1") &&
          n.message.includes("run /handover"),
      ),
    );

    const stale = setup({}, true);
    await start(stale.fake, stale.ctx);
    await store(stale.fake, stale.ctx);
    stale.fake.failSend = true;
    await assert.rejects(
      () => settle(stale.fake, stale.ctx),
      /automatic rollover dispatch failed[\s\S]*run \/handover[\s\S]*stale ctx/,
    );
  });
});

describe("pi shared child handovers", () => {
  const store = async (fake: FakePi, ctx: any, handover = "full child handover", summary = "unfinished step") =>
    fake.tools.get("context_handover").execute("write", { handover, summary }, undefined, undefined, ctx);

  it("hands back an ephemeral foreground child without terminating or rolling over, and closes later tools across reload", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    const session = createSessionManager({ sessionId: "child-foreground", sessionFile: undefined });
    const ctx = createToolCtx({ fake, session, systemPrompt: '<active_agent name="worker"/>\nTask' });
    const intro = await emit(fake, "before_agent_start", { systemPrompt: ctx.getSystemPrompt() }, ctx);
    assert.match(intro.message.content, /child session/);
    await emit(fake, "context", { messages: [] }, Object.assign(ctx, { getContextUsage: () => validUsage(150000, 200000) }));
    const notice = await emit(fake, "context", { messages: [] }, ctx);
    assert.match(notice.messages.at(-1).content, /Children never roll over/);
    const result = await store(fake, ctx, "verbatim\nfull text\n", "short summary");
    assert.equal(result.terminate, undefined);
    assert.match(result.content[0].text, /exactly the following text as your final message/);
    assert.match(result.content[0].text, /Context handover \(incomplete\): short summary/);
    assert.ok(result.content[0].text.includes('read_handover({"sessionID":"child-foreground"})'));
    assert.match(result.content[0].text, /Prioritized next steps/);
    await emit(fake, "agent_settled", { aborted: false }, ctx);
    assert.deepEqual(fake.sentUserMessages, []);
    await assert.rejects(() => store(fake, ctx, "overwrite"), /do no further work/);
    const reloaded = createFakePi();
    createExtension(reloaded.api);
    const toolGate = await emit(reloaded, "tool_call", { toolName: "bash" }, ctx);
    assert.equal(toolGate.block, true);
    assert.match(toolGate.reason, /short summary/);
    await assert.rejects(() => reloaded.tools.get("read_handover").execute("r", {}, undefined, undefined, ctx), /do no further work/);
    const parentCtx = createToolCtx({ session: createSessionManager({ sessionId: "parent" }) });
    const read = await reloaded.tools.get("read_handover").execute("r", { sessionID: session.sessionId }, undefined, undefined, parentCtx);
    assert.equal(read.content[0].text.split("verbatim\nfull text\n").length - 1, 1);
    assert.equal(read.details.sessionId, session.sessionId);
  });

  it("recognizes background children and does not confuse root predecessor links with children", async () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    const fake = createFakePi();
    createExtension(fake.api);
    const ctx = createToolCtx({ fake, session: createSessionManager({ sessionId: "background" }) });
    assert.equal((await store(fake, ctx)).terminate, undefined);
    delete process.env.PI_SUBAGENT_CHILD;
    const rootSession = createSessionManager({ sessionId: "root-successor" });
    const rootCtx = createToolCtx({ fake, session: rootSession });
    rootCtx.sessionManager.getHeader = () => ({ parentSession: "predecessor" });
    assert.equal((await store(fake, rootCtx)).terminate, true);
    await emit(fake, "agent_settled", { aborted: false }, rootCtx);
    assert.equal(fake.sentUserMessages.length, 1);
  });

  it("writes hashed private atomic records, retains only the latest ID value, and accepts IDs rather than paths", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    const sessionID = "../../untrusted/session";
    const ctx = createToolCtx({ fake, session: createSessionManager({ sessionId: sessionID, sessionFile: undefined }) });
    await store(fake, ctx, "first");
    await store(fake, ctx, "second\nverbatim");
    const directory = join(agentDirectory, "auto-context-handover");
    const files = await readdir(directory);
    const expected = `${createHash("sha256").update(sessionID).digest("hex")}.json`;
    assert.deepEqual(files, [expected]);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, expected))).mode & 0o777, 0o600);
    const data = JSON.parse(await readFile(join(directory, expected), "utf8"));
    assert.equal(data.handover, "second\nverbatim");
    assert.equal(data.sessionId, sessionID);
    const parent = createToolCtx({ session: createSessionManager({ sessionId: "other" }) });
    const reader = fake.tools.get("read_handover");
    assert.equal((await reader.execute("r", { sessionID }, undefined, undefined, parent)).details.stored, true);
    assert.equal((await reader.execute("r", { sessionID: join(directory, expected) }, undefined, undefined, parent)).details.stored, false);
    await writeFile(join(directory, expected), JSON.stringify({ ...data, sessionId: "different" }));
    await assert.rejects(() => reader.execute("r", { sessionID }, undefined, undefined, parent), /invalid shared handover/);
    await writeFile(join(directory, expected), "invalid JSON");
    await assert.rejects(() => reader.execute("r", { sessionID }, undefined, undefined, parent));
  });

  it("keeps an open root usable and repairable after corruption while retaining a closed child's branch refusal", async () => {
    const fake = createFakePi();
    createExtension(fake.api);
    const rootSession = createSessionManager({ sessionId: "repairable-root" });
    const ctx = createToolCtx({ fake, session: rootSession });
    await store(fake, ctx, "original");
    const path = join(agentDirectory, "auto-context-handover", `${createHash("sha256").update(rootSession.sessionId).digest("hex")}.json`);
    await writeFile(path, "corrupt");
    assert.equal(await emit(fake, "tool_call", { toolName: "bash" }, ctx), undefined);
    const branchRead = await fake.tools.get("read_handover").execute("r", {}, undefined, undefined, ctx);
    assert.match(branchRead.content[0].text, /original/);
    await store(fake, ctx, "repaired");
    assert.equal(JSON.parse(await readFile(path, "utf8")).handover, "repaired");

    const childSession = createSessionManager({ sessionId: "closed-child" });
    const childCtx = createToolCtx({ fake, session: childSession, systemPrompt: '<active_agent name="worker"/>' });
    await store(fake, childCtx);
    const childPath = join(agentDirectory, "auto-context-handover", `${createHash("sha256").update(childSession.sessionId).digest("hex")}.json`);
    await writeFile(childPath, "corrupt");
    const reload = createFakePi();
    createExtension(reload.api);
    const unmarkedCtx = createToolCtx({ session: childSession });
    const gate = await emit(reload, "tool_call", { toolName: "bash" }, unmarkedCtx);
    assert.equal(gate.block, true);
    assert.match(gate.reason, /Context handover \(incomplete\)/);
  });

  it("does not request rollover or claim success when shared storage is inaccessible", async () => {
    await writeFile(join(agentDirectory, "auto-context-handover"), "not a directory");
    const fake = createFakePi();
    createExtension(fake.api);
    const notifications: RecordedNotify[] = [];
    const ctx = createToolCtx({ fake, notified: notifications });
    await assert.rejects(() => store(fake, ctx), /no continuation requested/);
    await emit(fake, "agent_settled", { aborted: false }, ctx);
    assert.deepEqual(fake.sentUserMessages, []);
    assert.equal(await emit(fake, "tool_call", { toolName: "bash" }, ctx), undefined);
    const intro = await emit(fake, "before_agent_start", { systemPrompt: ctx.getSystemPrompt() }, ctx);
    assert.match(intro.message.content, /root session/);
    assert.equal(notifications.filter((notice) => notice.level === "warning").length, 1);
    const childCtx = createToolCtx({ systemPrompt: '<active_agent name="worker"/>' });
    const childGate = await emit(fake, "tool_call", { toolName: "bash" }, childCtx);
    assert.equal(childGate.block, true);
    assert.match(childGate.reason, /cannot verify session completion state/);
  });
});

describe("pi successor model preservation", () => {
  const setup = async (thinking = "high", mislabeledRoot = false) => {
    const old = createFakePi();
    createExtension(old.api);
    old.thinking = thinking;
    const selection = { provider: "chosen-provider", model: "chosen-model", thinking };
    const source = createSessionManager({ branch: [entry("h", ENTRY_TYPE, {
      handover: "continue", summary: "next", sessionId: "sess-1", model: { provider: "older", id: "stale" }, closed: mislabeledRoot,
    })] });
    const options: any[] = [];
    const systemPrompt = mislabeledRoot ? '<active_agent name="inherited-marker"/>' : undefined;
    const ctx = createToolCtx({ fake: old, session: source, model: { provider: selection.provider, id: selection.model }, systemPrompt });
    Object.assign(ctx, { waitForIdle: async () => {}, newSession: async (option: any) => { options.push(option); return { cancelled: false }; } });
    await old.commands.get("handover").handler("", ctx);
    const successor = createSessionManager({ sessionId: "successor" });
    await options[0].setup({ appendMessage: () => "seed", appendCustomEntry: (type: string, data: unknown) => {
      successor.branch.push(entry("meta", type, data)); return "meta";
    } });
    const fresh = createFakePi();
    createExtension(fresh.api);
    fresh.thinking = "off";
    const notifications: RecordedNotify[] = [];
    const freshCtx = createToolCtx({ fake: fresh, session: successor, model: { provider: "default", id: "default" }, notified: notifications, systemPrompt });
    freshCtx.thinkingLevel = "off";
    fresh.activeCtx = freshCtx;
    const sends: string[] = [];
    freshCtx.sendUserMessage = async (text: string) => { sends.push(text); };
    // Any accidental old-instance access after replacement must fail.
    old.api.setModel = () => { throw new Error("stale old model API"); };
    old.api.getThinkingLevel = () => { throw new Error("stale old thinking API"); };
    return { selection, fresh, freshCtx, options: options[0], sends, notifications };
  };

  it("restores model then thinking using the new instance before kickoff, once only", async () => {
    const h = await setup("xhigh");
    const calls: string[] = [];
    const setModel = h.fresh.api.setModel;
    h.fresh.api.setModel = async (...args: unknown[]) => { calls.push("model"); return setModel(...args); };
    const setThinking = h.fresh.api.setThinkingLevel;
    h.fresh.api.setThinkingLevel = (level: string) => { calls.push("thinking"); setThinking(level); };
    await emit(h.fresh, "session_start", { reason: "new" }, h.freshCtx);
    assert.deepEqual(calls, ["model", "thinking"]);
    assert.equal(h.freshCtx.model.provider, h.selection.provider);
    assert.equal(h.freshCtx.thinkingLevel, "xhigh");
    await h.options.withSession(h.freshCtx);
    assert.equal(h.sends.length, 1);
    await emit(h.fresh, "session_start", { reason: "new" }, h.freshCtx);
    assert.equal(h.fresh.setModels.length, 1);
    const reload = createFakePi();
    createExtension(reload.api);
    await emit(reload, "session_start", { reason: "reload" }, h.freshCtx);
    await emit(reload, "session_start", { reason: "resume" }, h.freshCtx);
    await emit(reload, "session_start", { reason: "startup" }, h.freshCtx);
    assert.equal(reload.setModels.length, 0);
  });

  it("manual command recovers a mislabeled closed root and restores selection despite inherited child signals", async () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    const h = await setup("medium", true);
    await emit(h.fresh, "session_start", { reason: "new" }, h.freshCtx);
    await h.options.withSession(h.freshCtx);
    assert.equal(h.sends.length, 1);
    assert.equal(h.freshCtx.model.id, h.selection.model);
    assert.equal(h.freshCtx.thinkingLevel, "medium");
  });

  it("withholds kickoff for unavailable models, failed restoration, or unverified settings", async () => {
    for (const failure of ["missing", "auth", "throw", "thinking", "missing-event", "changed-model", "changed-thinking"]) {
      const h = await setup();
      if (failure === "missing") h.freshCtx.modelRegistry.find = () => undefined;
      if (failure === "auth") h.fresh.api.setModel = async () => false;
      if (failure === "throw") h.fresh.api.setModel = async () => { throw new Error("model boom"); };
      if (failure === "thinking") h.fresh.api.setThinkingLevel = () => {};
      if (failure !== "missing-event") await emit(h.fresh, "session_start", { reason: "new" }, h.freshCtx);
      if (failure === "changed-model") h.freshCtx.model = { provider: "default", id: "default" };
      if (failure === "changed-thinking") h.freshCtx.thinkingLevel = "off";
      await h.options.withSession(h.freshCtx);
      assert.deepEqual(h.sends, [], failure);
      assert.ok(h.notifications.some((notice) => notice.level === "error"), failure);
    }
  });
});
