// AiderDesk adapter tests: fake Extension API, real filesystem under
// os.tmpdir(), no host, no network, no model calls.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import Extension, { EXTENSION_ID, FULL_READ_TOOL_NAME, FULL_TOOL_NAME } from "./index.ts";
import { SEED_FRAMING } from "../source/shared/handover-text.ts";

const ENV_SOFT = "AUTO_CONTEXT_HANDOVER_SOFT";
const SUBDIR = ".auto-context-handover";

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_SOFT];
  delete process.env[ENV_SOFT];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_SOFT];
  else process.env[ENV_SOFT] = savedEnv;
});

const freshDir = (): string => mkdtempSync(join(tmpdir(), "ach-aiderdesk-"));

const rootProfile = (overrides: Record<string, unknown> = {}): any => ({
  id: "profile-1",
  provider: "prov",
  model: "mod",
  isSubagent: false,
  ...overrides,
});

function makeTask(options: {
  id?: string;
  dir?: string;
  data?: Record<string, unknown>;
  estimate?: number | (() => Promise<number>);
} = {}): { task: any; calls: { runPrompts: Array<unknown>; estimateCalls: number } } {
  const calls: { runPrompts: Array<unknown>; estimateCalls: number } = { runPrompts: [], estimateCalls: 0 };
  const dir = options.dir ?? freshDir();
  const base = {
    data: { id: options.id ?? "task-1", ...(options.data ?? {}) },
    getTaskDir: () => dir,
    getEstimatedTokens: async () => {
      calls.estimateCalls++;
      if (typeof options.estimate === "function") return options.estimate();
      return options.estimate ?? 0;
    },
    runPrompt: async (...args: Array<unknown>) => {
      calls.runPrompts.push(args);
      throw new Error("runPrompt must never be called: storage only, no automatic successor");
    },
  };
  const task = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      return (..._args: Array<unknown>) => {
        throw new Error(`unexpected TaskContext call: ${String(prop)}`);
      };
    },
  });
  return { task, calls };
}

interface CtxCalls {
  logs: Array<{ readonly message: string; readonly type?: string }>;
  cleanups: Array<() => unknown>;
}

function makeCtx(options: { task?: any; project?: any; models?: unknown; modelsThrow?: boolean } = {}): {
  ctx: any;
  calls: CtxCalls;
} {
  const calls: CtxCalls = { logs: [], cleanups: [] };
  const base = {
    getTaskContext: () => options.task ?? null,
    getProjectContext: () => {
      if (!options.project) throw new Error("no project available");
      return options.project;
    },
    getModelConfigs: async () => {
      if (options.modelsThrow) throw new Error("models boom");
      return options.models ?? [];
    },
    log: (message: string, type?: string) => {
      calls.logs.push({ message, type });
    },
    addDisposable: (setup: () => unknown) => {
      const cleanup = setup();
      if (typeof cleanup === "function") calls.cleanups.push(cleanup as () => unknown);
    },
    getProjectDir: () => "/proj",
  };
  const ctx = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      return (..._args: Array<unknown>) => {
        throw new Error(`unexpected ExtensionContext call: ${String(prop)}`);
      };
    },
  });
  return { ctx, calls };
}

function makeProject(options: { tasksById?: Record<string, any> } = {}): { project: any; calls: { created: Array<unknown> } } {
  const calls: { created: Array<unknown> } = { created: [] };
  const project = {
    baseDir: "/proj",
    createTask: async (...args: Array<unknown>) => {
      calls.created.push(args);
      throw new Error("createTask must never be called: storage only, no automatic successor");
    },
    getTask: (id: string) => options.tasksById?.[id] ?? null,
  };
  return { project, calls };
}

const load = async (ctx: any): Promise<Extension> => {
  const ext = new Extension();
  await ext.onLoad(ctx);
  return ext;
};

const toolMap = (ext: Extension, ctx: any, mode = "agent", profile: any = rootProfile()): Map<string, any> =>
  new Map(ext.getTools(ctx, mode, profile).map((tool) => [tool.name, tool]));

const subdirFiles = (dir: string, taskId = "task-1"): Array<string> => {
  try {
    return readdirSync(join(dir, SUBDIR, createHash("sha256").update(taskId, "utf8").digest("hex"))).sort();
  } catch {
    return [];
  }
};

const taskFile = (dir: string, taskId: string, name: string): string =>
  join(dir, SUBDIR, createHash("sha256").update(taskId, "utf8").digest("hex"), name);

describe("tool registration", () => {
  it("registers kebab-case tools for root agent runs with exact host full names", async () => {
    const { ctx } = makeCtx();
    const ext = await load(ctx);
    const tools = ext.getTools(ctx, "agent", rootProfile());
    assert.equal(tools.length, 2);
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["context-handover", "read-handover"]);
    for (const tool of tools) {
      assert.ok(tool.inputSchema instanceof z.ZodType, `${tool.name} inputSchema must be a Zod schema`);
      assert.match(tool.name, /^[a-z][a-z0-9-]*$/);
    }
    assert.equal(FULL_TOOL_NAME, "aiderdesk---context-handover");
    assert.equal(FULL_READ_TOOL_NAME, "aiderdesk---read-handover");
    assert.equal(EXTENSION_ID, "aiderdesk");
  });

  it("registers no tools for subagent profiles or non-agent modes", async () => {
    const { ctx } = makeCtx();
    const ext = await load(ctx);
    assert.deepEqual(ext.getTools(ctx, "agent", rootProfile({ isSubagent: true })), []);
    assert.deepEqual(ext.getTools(ctx, "subagent", rootProfile()), []);
    assert.deepEqual(ext.getTools(ctx, "ask", rootProfile()), []);
  });

  it("exposes static metadata describing storage-only manual continuation", () => {
    const metadata = (Extension as unknown as { metadata: { name: string; version: string; description: string } }).metadata;
    assert.ok(metadata.name.length > 0);
    assert.ok(metadata.version.length > 0);
    assert.match(metadata.description, /manual/i);
    assert.doesNotMatch(metadata.description, /automatic successor/i);
  });

  it("describes storage-only semantics with no automatic successor", async () => {
    const { ctx } = makeCtx();
    const ext = await load(ctx);
    const tools = toolMap(ext, ctx);
    const storeDesc = String(tools.get("context-handover")!.description);
    const readDesc = String(tools.get("read-handover")!.description);
    assert.match(storeDesc, /Storage only/);
    assert.match(storeDesc, /no automatic successor/i);
    assert.match(readDesc, /no automatic successor/i);
  });
});

describe("thresholds and unknowns", () => {
  it("defaults to 150000 uncapped with an unknown window", async () => {
    const { task } = makeTask({ estimate: 150000 });
    const { ctx } = makeCtx({ task, models: [] });
    const ext = await load(ctx);
    const event: any = { mode: "agent", agentProfile: rootProfile(), messages: [{ id: "m", role: "user", content: "x" }] };
    const result = await ext.onAgentStepStarted(event, ctx);
    assert.ok(result?.messages && result.messages.length === 2);
    assert.equal(event.messages.length, 1);
  });

  it("caps integer soft values at 70% of a known window", async () => {
    const models = [{ providerId: "prov", id: "mod", maxInputTokens: 100000 }];
    const { task: low } = makeTask({ id: "t-low", estimate: 69999 });
    const { task: high } = makeTask({ id: "t-high", estimate: 70000 });
    const { ctx: ctxLow } = makeCtx({ task: low, models });
    const { ctx: ctxHigh } = makeCtx({ task: high, models });
    const ext = await load(ctxLow);
    const base: any = { mode: "agent", agentProfile: rootProfile(), messages: [] };
    assert.equal(await ext.onAgentStepStarted({ ...base }, ctxLow), undefined);
    const hit = await ext.onAgentStepStarted({ ...base }, ctxHigh);
    assert.ok(hit?.messages && hit.messages.length === 1);
  });

  it("applies explicit percents uncapped and stays silent with an unknown window", async () => {
    process.env[ENV_SOFT] = "50%";
    const models = [{ providerId: "prov", id: "mod", maxInputTokens: 200000 }];
    const { task } = makeTask({ estimate: 100000 });
    const { ctx } = makeCtx({ task, models });
    const ext = await load(ctx);
    const hit = await ext.onAgentStepStarted({ mode: "agent", agentProfile: rootProfile(), messages: [] } as any, ctx);
    assert.ok(hit?.messages);

    const { task: unknownTask } = makeTask({ id: "t-u", estimate: 999999999 });
    const { ctx: unknownCtx } = makeCtx({ task: unknownTask, models: [] });
    const ext2 = await load(unknownCtx);
    const silent = await ext2.onAgentStepStarted(
      { mode: "agent", agentProfile: rootProfile(), messages: [] } as any,
      unknownCtx,
    );
    assert.equal(silent, undefined);
  });

  it("treats zero and errored estimates as unknown", async () => {
    const { task: zero } = makeTask({ id: "t-zero", estimate: 0 });
    const { ctx: ctxZero } = makeCtx({ task: zero, models: [] });
    const ext = await load(ctxZero);
    assert.equal(
      await ext.onAgentStepStarted({ mode: "agent", agentProfile: rootProfile(), messages: [] } as any, ctxZero),
      undefined,
    );
    const { task: failing } = makeTask({
      id: "t-fail",
      estimate: () => Promise.reject(new Error("estimate boom")),
    });
    const { ctx: ctxFail } = makeCtx({ task: failing, models: [] });
    assert.equal(
      await ext.onAgentStepStarted({ mode: "agent", agentProfile: rootProfile(), messages: [] } as any, ctxFail),
      undefined,
    );
  });

  it("fails open to unknown when model configs are unavailable or unmatched", async () => {
    const { task } = makeTask({ id: "t-nomatch", estimate: 150000 });
    const { ctx } = makeCtx({ task, models: [{ providerId: "other", id: "other", maxInputTokens: 10 }] });
    const ext = await load(ctx);
    const hit = await ext.onAgentStepStarted({ mode: "agent", agentProfile: rootProfile(), messages: [] } as any, ctx);
    assert.ok(hit?.messages);

    const { task: task2 } = makeTask({ id: "t-throw-low", estimate: 10 });
    const { ctx: ctx2 } = makeCtx({ task: task2, modelsThrow: true });
    const ext2 = await load(ctx2);
    assert.equal(
      await ext2.onAgentStepStarted({ mode: "agent", agentProfile: rootProfile(), messages: [] } as any, ctx2),
      undefined,
    );
  });

  it("errors on load for invalid explicit values and disables advisories", async () => {
    process.env[ENV_SOFT] = "bogus";
    const { ctx, calls } = makeCtx();
    const ext = await load(ctx);
    assert.ok(calls.logs.some((entry) => entry.type === "error" && entry.message.includes(ENV_SOFT)));
    const { task } = makeTask({ id: "t-inv", estimate: 999999999 });
    const { ctx: stepCtx } = makeCtx({ task, models: [] });
    (ext as unknown as { diagByTask: Map<string, unknown> }).diagByTask.clear();
    const silent = await ext.onAgentStepStarted(
      { mode: "agent", agentProfile: rootProfile(), messages: [] } as any,
      stepCtx,
    );
    assert.equal(silent, undefined);
  });

  it("treats an explicit empty soft value as invalid and stays silent", async () => {
    process.env[ENV_SOFT] = "";
    const { ctx, calls } = makeCtx();
    const ext = await load(ctx);
    assert.ok(calls.logs.some((entry) => entry.type === "error" && entry.message.includes(ENV_SOFT)));
    const { task } = makeTask({ id: "t-empty", estimate: 999999999 });
    const { ctx: stepCtx } = makeCtx({ task, models: [] });
    const silent = await ext.onAgentStepStarted(
      { mode: "agent", agentProfile: rootProfile(), messages: [] } as any,
      stepCtx,
    );
    assert.equal(silent, undefined);
  });
});

describe("intro and transient notices", () => {
  it("appends a root intro without rewriting the system prompt", async () => {
    const { task } = makeTask();
    const { ctx } = makeCtx({ task });
    const ext = await load(ctx);
    const messages = [{ id: "m1", role: "user", content: "hello" }];
    const event: any = {
      mode: "agent",
      agentProfile: rootProfile(),
      prompt: "hello",
      systemPrompt: "system",
      contextMessages: messages,
    };
    const result = await ext.onAgentStarted(event, ctx);
    assert.ok(result?.contextMessages);
    assert.equal(result.contextMessages.length, 2);
    assert.equal(messages.length, 1);
    assert.equal(result.contextMessages[0], messages[0]);
    assert.ok(!("prompt" in (result as object)) && !("systemPrompt" in (result as object)));
  });

  it("intro states storage-only manual continuation with no automatic successor", async () => {
    const { task } = makeTask();
    const { ctx } = makeCtx({ task });
    const ext = await load(ctx);
    const result = await ext.onAgentStarted(
      { mode: "agent", agentProfile: rootProfile(), contextMessages: [] } as any,
      ctx,
    );
    const intro = String(result?.contextMessages?.[0]?.content ?? result?.contextMessages?.[1]?.content ?? "");
    assert.match(intro, /no automatic successor/i);
    assert.match(intro, /dedicated plugin storage/i);
  });

  it("skips the intro for subagents and non-agent modes", async () => {
    const { ctx } = makeCtx();
    const ext = await load(ctx);
    const event: any = { mode: "agent", agentProfile: rootProfile(), contextMessages: [] };
    assert.equal(await ext.onAgentStarted({ ...event, agentProfile: rootProfile({ isSubagent: true }) }, ctx), undefined);
    assert.equal(await ext.onAgentStarted({ ...event, mode: "subagent" }, ctx), undefined);
  });

  it("keeps step notices transient and silent when ok or unknown", async () => {
    const { task } = makeTask({ estimate: 10 });
    const { ctx } = makeCtx({ task, models: [] });
    const ext = await load(ctx);
    assert.equal(
      await ext.onAgentStepStarted({ mode: "agent", agentProfile: rootProfile(), messages: [] } as any, ctx),
      undefined,
    );
    const sub: any = { mode: "agent", agentProfile: rootProfile({ isSubagent: true }), messages: [] };
    assert.equal(await ext.onAgentStepStarted(sub, ctx), undefined);
  });

  it("step notice states dedicated plugin storage and no automatic successor", async () => {
    const { task } = makeTask({ estimate: 200000 });
    const { ctx } = makeCtx({ task, models: [] });
    const ext = await load(ctx);
    const hit = await ext.onAgentStepStarted({ mode: "agent", agentProfile: rootProfile(), messages: [] } as any, ctx);
    const notice = String(hit?.messages?.[hit.messages.length - 1]?.content ?? "");
    assert.match(notice, /dedicated plugin storage/i);
    assert.match(notice, /no automatic successor/i);
  });
});

describe("handover storage", () => {
  it("stores verbatim text with diagnostics and reads it back with a manual hint", async () => {
    const dir = freshDir();
    const { task } = makeTask({ dir, estimate: 200000, data: {} });
    const { ctx } = makeCtx({ task, models: [] });
    const ext = await load(ctx);
    await ext.onAgentStepStarted({ mode: "agent", agentProfile: rootProfile(), messages: [] } as any, ctx);
    await ext.onAgentStarted(
      { mode: "agent", agentProfile: rootProfile(), contextMessages: [] } as any,
      ctx,
    );
    const tools = toolMap(ext, ctx);
    const stored = await tools.get("context-handover")!.execute(
      { handover: "body text", summary: "status summary" },
      undefined,
      ctx,
      {},
    );
    assert.match(String(stored), /Handover stored for task task-1/);
    assert.match(String(stored), /no automatic successor/i);
    assert.deepEqual(subdirFiles(dir), ["handover.json"]);
    const read = await tools.get("read-handover")!.execute({}, undefined, ctx, {});
    assert.match(String(read), /Handover from task task-1 \(model prov\/mod\):/);
    assert.match(String(read), /Diagnostics: reason=nudged, stage=warn3, estimated-context-tokens=200000, soft-limit=150000/);
    assert.match(String(read), /Manual continuation only/);
    assert.match(String(read), /read-handover/);
    assert.match(String(read), /task-1/);
    assert.ok(String(read).includes(SEED_FRAMING));
    assert.ok(String(read).endsWith("\n\nbody text"));
    const raw = JSON.parse(readFileSync(taskFile(dir, "task-1", "handover.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.handover, "body text");
    assert.equal(raw.summary, "status summary");
  });

  it("rejects empty payloads and missing task context", async () => {
    const { ctx } = makeCtx();
    const ext = await load(ctx);
    const tools = toolMap(ext, ctx);
    await assert.rejects(() => tools.get("context-handover")!.execute({ handover: "  ", summary: "s" }, undefined, ctx, {}));
    await assert.rejects(() => tools.get("context-handover")!.execute({ handover: "h", summary: " " }, undefined, ctx, {}));
    await assert.rejects(() => tools.get("read-handover")!.execute({}, undefined, ctx, {}));
  });

  it("keeps the first writer and reports unknown diagnostics after reload", async () => {
    const dir = freshDir();
    const { task } = makeTask({ dir });
    const { ctx } = makeCtx({ task, models: [] });
    const ext = await load(ctx);
    const tools = toolMap(ext, ctx);
    await tools.get("context-handover")!.execute({ handover: "first", summary: "one" }, undefined, ctx, {});
    const second = await tools.get("context-handover")!.execute({ handover: "second", summary: "two" }, undefined, ctx, {});
    assert.match(String(second), /already stored.*original is kept/);

    const reloaded = new Extension();
    const { ctx: ctx2 } = makeCtx({ task, models: [] });
    await reloaded.onLoad(ctx2);
    const tools2 = toolMap(reloaded, ctx2);
    const read = await tools2.get("read-handover")!.execute({}, undefined, ctx2, {});
    assert.ok(String(read).endsWith("\n\nfirst"));
    assert.match(String(read), /estimated-context-tokens=unknown, soft-limit=unknown/);
    assert.match(String(read), /model unknown\/unknown/);
  });

  it("serializes cross-instance concurrent stores to one immutable file", async () => {
    const dir = freshDir();
    const { task: taskA } = makeTask({ id: "task-1", dir });
    const { task: taskB } = makeTask({ id: "task-1", dir });
    const { ctx: ctxA } = makeCtx({ task: taskA, models: [] });
    const { ctx: ctxB } = makeCtx({ task: taskB, models: [] });
    const extA = await load(ctxA);
    const extB = await load(ctxB);
    const toolsA = toolMap(extA, ctxA);
    const toolsB = toolMap(extB, ctxB);
    const [a, b] = await Promise.all([
      toolsA.get("context-handover")!.execute({ handover: "aaa", summary: "summary-a" }, undefined, ctxA, {}),
      toolsB.get("context-handover")!.execute({ handover: "bbb", summary: "summary-b" }, undefined, ctxB, {}),
    ]);
    const texts = [String(a), String(b)];
    assert.equal(texts.filter((text) => text.includes("Handover stored")).length, 1);
    assert.equal(texts.filter((text) => text.includes("already stored")).length, 1);
    const raw = JSON.parse(readFileSync(taskFile(dir, "task-1", "handover.json"), "utf8")) as {
      handover: string;
      summary: string;
    };
    assert.ok(
      (raw.handover === "aaa" && raw.summary === "summary-a") ||
        (raw.handover === "bbb" && raw.summary === "summary-b"),
    );
    const readA = String(await toolsA.get("read-handover")!.execute({}, undefined, ctxA, {}));
    const readB = String(await toolsB.get("read-handover")!.execute({}, undefined, ctxB, {}));
    assert.ok(readA.endsWith(`\n\n${raw.handover}`));
    assert.ok(readB.endsWith(`\n\n${raw.handover}`));
    assert.deepEqual(subdirFiles(dir), ["handover.json"]);
  });

  it("reports missing and invalid entries honestly", async () => {
    const dir = freshDir();
    const { task } = makeTask({ dir });
    const { ctx } = makeCtx({ task, models: [] });
    const ext = await load(ctx);
    const tools = toolMap(ext, ctx);
    assert.match(String(await tools.get("read-handover")!.execute({}, undefined, ctx, {})), /No handover stored/);
    mkdirSync(join(dir, SUBDIR, createHash("sha256").update("task-1", "utf8").digest("hex")), { recursive: true });
    writeFileSync(taskFile(dir, "task-1", "handover.json"), "{not-json");
    assert.match(String(await tools.get("read-handover")!.execute({}, undefined, ctx, {})), /invalid/);
  });

  it("reports a storage failure honestly and never claims success", async () => {
    const dir = freshDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const { task } = makeTask({ id: "io-fail", dir: blocker });
    const { ctx } = makeCtx({ task, models: [] });
    const ext = await load(ctx);
    const tools = toolMap(ext, ctx);
    await assert.rejects(
      () => tools.get("context-handover")!.execute({ handover: "body", summary: "s" }, undefined, ctx, {}),
      /failed to store handover/,
    );
  });

  it("scopes taskId reads to loaded project tasks, never arbitrary paths", async () => {
    const dir = freshDir();
    const { task: other } = makeTask({ id: "other", dir });
    const { project } = makeProject({ tasksById: { other } });
    const { task: current } = makeTask({ id: "current", dir: freshDir() });
    const { ctx } = makeCtx({ task: current, project, models: [] });
    const ext = await load(ctx);
    const tools = toolMap(ext, ctx);
    await tools.get("context-handover")!.execute({ handover: "scoped", summary: "s" }, undefined, {
      ...ctx,
      getTaskContext: () => other,
    } as any, {});
    const read = await tools.get("read-handover")!.execute({ taskId: "other" }, undefined, ctx, {});
    assert.ok(String(read).endsWith("\n\nscoped"));
    await assert.rejects(
      () => tools.get("read-handover")!.execute({ taskId: "missing" }, undefined, ctx, {}),
      /not loaded/,
    );
    const { ctx: noProject } = makeCtx({ task: current, models: [] });
    await assert.rejects(
      () => tools.get("read-handover")!.execute({ taskId: "other" }, undefined, noProject, {}),
      /no project context/,
    );
  });

  it("isolates different task ids sharing one host directory by hashed scope", async () => {
    const dir = freshDir();
    const { task: taskA } = makeTask({ id: "task-a", dir });
    const { task: taskB } = makeTask({ id: "task-b", dir });
    const { project } = makeProject({ tasksById: { "task-a": taskA, "task-b": taskB } });
    const { ctx: ctxA } = makeCtx({ task: taskA, project, models: [] });
    const { ctx: ctxB } = makeCtx({ task: taskB, project, models: [] });
    const ext = await load(ctxA);
    const tools = toolMap(ext, ctxA);
    const storedA = await tools.get("context-handover")!.execute(
      { handover: "alpha-body", summary: "alpha summary" },
      undefined,
      ctxA,
      {},
    );
    const storedB = await tools.get("context-handover")!.execute(
      { handover: "beta-body", summary: "beta summary" },
      undefined,
      ctxB,
      {},
    );
    assert.match(String(storedA), /Handover stored for task task-a/);
    assert.match(String(storedB), /Handover stored for task task-b/);
    const readA = String(await tools.get("read-handover")!.execute({}, undefined, ctxA, {}));
    const readB = String(await tools.get("read-handover")!.execute({}, undefined, ctxB, {}));
    assert.ok(readA.endsWith("\n\nbeta-body") === false && readA.endsWith("\n\nalpha-body"));
    assert.ok(readB.endsWith("\n\nbeta-body"));
    assert.match(readA, /Handover from task task-a/);
    assert.match(readB, /Handover from task task-b/);
    const crossA = String(await tools.get("read-handover")!.execute({ taskId: "task-a" }, undefined, ctxB, {}));
    assert.ok(crossA.endsWith("\n\nalpha-body"));
    const rawA = JSON.parse(readFileSync(taskFile(dir, "task-a", "handover.json"), "utf8")) as Record<string, unknown>;
    const rawB = JSON.parse(readFileSync(taskFile(dir, "task-b", "handover.json"), "utf8")) as Record<string, unknown>;
    assert.equal(rawA.handover, "alpha-body");
    assert.equal(rawB.handover, "beta-body");
    const scopes = readdirSync(join(dir, SUBDIR)).sort();
    assert.equal(scopes.length, 2);
    for (const entry of scopes) assert.match(entry, /^[0-9a-f]{64}$/);
    assert.ok(!scopes.includes("task-a") && !scopes.includes("task-b"));
    const again = await tools.get("context-handover")!.execute(
      { handover: "alpha-second", summary: "alpha two" },
      undefined,
      ctxA,
      {},
    );
    assert.match(String(again), /already stored.*original is kept/);
    const rawA2 = JSON.parse(readFileSync(taskFile(dir, "task-a", "handover.json"), "utf8")) as Record<string, unknown>;
    assert.equal(rawA2.handover, "alpha-body");
  });
});

describe("no automatic continuation", () => {
  it("exposes no onPromptFinished handler and stores only handover.json", async () => {
    const dir = freshDir();
    const { task, calls: taskCalls } = makeTask({ dir });
    const { project, calls: projectCalls } = makeProject({ tasksById: {} });
    const { ctx } = makeCtx({ task, project, models: [] });
    const ext = await load(ctx);
    assert.equal((ext as unknown as { onPromptFinished?: unknown }).onPromptFinished, undefined);
    const tools = toolMap(ext, ctx);
    await tools.get("context-handover")!.execute({ handover: "body", summary: "s" }, undefined, ctx, {});
    assert.deepEqual(subdirFiles(dir), ["handover.json"]);
    assert.deepEqual(projectCalls.created, []);
    assert.deepEqual(taskCalls.runPrompts, []);
  });

  it("reloaded instance still has no automatic continuation", async () => {
    const dir = freshDir();
    const { task } = makeTask({ dir });
    const { project, calls: projectCalls } = makeProject({ tasksById: {} });
    const { ctx } = makeCtx({ task, project, models: [] });
    const ext = await load(ctx);
    await toolMap(ext, ctx).get("context-handover")!.execute({ handover: "body", summary: "s" }, undefined, ctx, {});
    const reloaded = new Extension();
    const { ctx: ctx2 } = makeCtx({ task, project, models: [] });
    await reloaded.onLoad(ctx2);
    assert.equal((reloaded as unknown as { onPromptFinished?: unknown }).onPromptFinished, undefined);
    const again = await toolMap(reloaded, ctx2).get("context-handover")!.execute(
      { handover: "body", summary: "s" },
      undefined,
      ctx2,
      {},
    );
    assert.match(String(again), /already stored/);
    assert.deepEqual(subdirFiles(dir), ["handover.json"]);
    assert.deepEqual(projectCalls.created, []);
  });
});

describe("lifecycle", () => {
  it("clears transient diagnostics on task close but keeps the stored handover", async () => {
    const dir = freshDir();
    const { task } = makeTask({ id: "closing", dir, estimate: 200000 });
    const { project } = makeProject({ tasksById: {} });
    const { ctx } = makeCtx({ task, project, models: [] });
    const ext = await load(ctx);
    await ext.onAgentStepStarted({ mode: "agent", agentProfile: rootProfile(), messages: [] } as any, ctx);
    const tools = toolMap(ext, ctx);
    await tools.get("context-handover")!.execute({ handover: "closing-body", summary: "s" }, undefined, ctx, {});
    await ext.onTaskClosed({ task: { id: "closing" } } as any, ctx);
    const read = await tools.get("read-handover")!.execute({}, undefined, ctx, {});
    assert.ok(String(read).endsWith("\n\nclosing-body"));
    assert.match(String(read), /estimated-context-tokens=200000/);
    await ext.onUnload();
  });
});
