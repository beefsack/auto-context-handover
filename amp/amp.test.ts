// Amp adapter tests: fake typed PluginAPI, real fs under os.tmpdir.
// No live HOME mutation (storage dir is always injected), no network, no model.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAmpHandoverPlugin, parseAmpSoftEnv, DEFAULT_SOFT, TOOL_NAME, READ_TOOL_NAME } from "./index.ts";
import { SEED_FRAMING } from "../source/shared/handover-text.ts";

const createdDirs: string[] = [];
after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});
function trackDir(dir: string): string {
  createdDirs.push(dir);
  return dir;
}
const testDir = (): string => trackDir(mkdtempSync(join(tmpdir(), "amp-ho-test-")));

// Minimal fakes matching only what the plugin touches.
interface FakeToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (input: unknown, ctx: any) => Promise<unknown>;
}
interface FakeAmp {
  logger: { logs: string[]; log: (...args: unknown[]) => void };
  activeThread: { current: { id: string } | null };
  tools: Map<string, FakeToolDef>;
  handlers: Map<string, Array<(event: any, ctx: any) => Promise<unknown>>>;
  createAgentCalled: number;
  getBuiltinAgentCalled: number;
  api: any;
}
function createFakeAmp(activeId: string | null = "T-source"): FakeAmp {
  const fake: FakeAmp = {
    logger: { logs: [], log: (...args: unknown[]) => { fake.logger.logs.push(args.map(String).join(" ")); } },
    activeThread: { current: activeId ? { id: activeId } : null },
    tools: new Map(),
    handlers: new Map(),
    createAgentCalled: 0,
    getBuiltinAgentCalled: 0,
    api: undefined,
  };
  fake.api = {
    logger: fake.logger,
    activeThread: fake.activeThread,
    registerTool: (def: FakeToolDef) => { fake.tools.set(def.name, def); },
    on: (event: string, handler: (event: any, ctx: any) => Promise<unknown>) => {
      const list = fake.handlers.get(event) ?? [];
      list.push(handler);
      fake.handlers.set(event, list);
    },
    createAgent: () => { fake.createAgentCalled++; throw new Error("createAgent must not be used"); },
    getBuiltinAgent: () => { fake.getBuiltinAgentCalled++; throw new Error("getBuiltinAgent must not be used"); },
  };
  return fake;
}

interface FakeThreadOptions {
  id?: string;
  parent?: string | null | "throw";
  transcript?: any[];
  messagesFail?: boolean;
  agent?: FakeAgent | "throw";
}
interface FakeAgent {
  createCalls: Array<Record<string, unknown>>;
  createFail?: boolean;
  failNextAppend?: boolean;
  appendCalls: Array<{ successorId: string; message: any }>;
  successors: FakeSuccessor[];
  handle: any;
}
interface FakeSuccessor {
  id: string;
  appended: any[];
  appendFail?: boolean;
}
function createFakeAgent(): FakeAgent {
  const agent: FakeAgent = { createCalls: [], appendCalls: [], successors: [], handle: undefined };
  let counter = 0;
  agent.handle = {
    createThread: async (options: Record<string, unknown>) => {
      agent.createCalls.push(options);
      if (agent.createFail) throw new Error("create boom");
      counter++;
      const successor: FakeSuccessor = { id: `T-successor-${counter}`, appended: [] };
      if (agent.failNextAppend) {
        agent.failNextAppend = false;
        successor.appendFail = true;
      }
      agent.successors.push(successor);
      return {
        id: successor.id,
        appendUserMessage: async (message: any) => {
          successor.appended.push(message);
          agent.appendCalls.push({ successorId: successor.id, message });
          if (successor.appendFail) throw new Error("append boom");
        },
      };
    },
  };
  return agent;
}
function createFakeThread(options: FakeThreadOptions = {}): any {
  const id = options.id ?? "T-source";
  const transcript = options.transcript ?? [];
  return {
    id,
    parentCalls: 0,
    parentThreadID: async () => {
      if (options.parent === "throw") throw new Error("parent boom");
      return (options.parent ?? null) as any;
    },
    messages: async (opts: any) => {
      assert.notEqual(opts?.full, true, "must never request full:true");
      if (options.messagesFail) throw new Error("messages boom");
      const offset = opts?.offset ?? 0;
      const limit = Math.min(opts?.limit ?? 20, 20);
      return transcript.slice(offset, offset + limit);
    },
    agent: async () => {
      if (options.agent === "throw") throw new Error("agent boom");
      return (options.agent as FakeAgent)?.handle ?? createFakeAgent().handle;
    },
  };
}
const eventCtx = (thread: any, logger?: any) => ({ thread, logger: logger ?? { log: () => {} } });
const toolCtx = (thread: any, signal?: AbortSignal) => ({ thread, logger: { log: () => {} }, signal });

const textMsg = (id: number | string, text: string, role = "user"): any => ({ id, role, content: [{ type: "text", text }] });
const toolUseMsg = (id: number | string, toolUseID: string, input: unknown = {}): any =>
  ({ id, role: "assistant", content: [{ type: "tool_use", id: toolUseID, name: "read_file", input: input as Record<string, unknown> }] });
const toolResultMsg = (id: number | string, toolUseID: string, status: string, output: unknown): any =>
  ({ id, role: "user", content: [{ type: "tool_result", toolUseID, status, output }] });
const bigText = (chars: number): string => "x".repeat(chars);
// The writer confirmation carries the stored call-time diagnostics verbatim,
// so tests assert exact estimates and reasons through it.
const parseDiag = (confirmation: string): Record<string, string> => {
  const match = /reason=([^,\s]+), stage=([^,\s]+), estimated-context-tokens=([^,\s]+), soft-limit=([^,\s]+)/.exec(confirmation);
  assert.ok(match, `expected a diagnostics line in: ${confirmation}`);
  return { reason: match[1]!, stage: match[2]!, estimate: match[3]!, soft: match[4]! };
};
const storedPaths = (dir: string, threadID: string) => {
  const d = join(dir, createHash("sha256").update(threadID, "utf8").digest("hex"));
  return { dir: d, handover: join(d, "handover.json"), claim: join(d, "continuation-claim.json"), result: join(d, "continuation-result.json") };
};
async function emit(fake: FakeAmp, event: string, payload: any, ctx: any): Promise<unknown> {
  const handlers = fake.handlers.get(event) ?? [];
  let last: unknown;
  for (const handler of handlers) last = await handler(payload, ctx);
  return last;
}

describe("amp soft parsing", () => {
  it("defaults and accepts integers only", () => {
    assert.equal(parseAmpSoftEnv(undefined).soft, DEFAULT_SOFT);
    assert.equal(parseAmpSoftEnv("200000").soft, 200000);
    for (const bad of ["", "  ", "abc", "12.5", "-1", "0", "50%", "70 %"]) {
      assert.ok(parseAmpSoftEnv(bad).error, `expected error for ${JSON.stringify(bad)}`);
    }
  });
  it("invalid env logs and disables notices but keeps tools", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, env: { AUTO_CONTEXT_HANDOVER_SOFT: "bogus" } });
    assert.ok(fake.logger.logs.some((line) => line.includes("invalid")));
    assert.ok(fake.tools.has(TOOL_NAME) && fake.tools.has(READ_TOOL_NAME));
    const thread = createFakeThread({ id: "T-source", transcript: [textMsg(1, bigText(700000))] });
    const out = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "hi", id: 999 }, eventCtx(thread)) as any;
    assert.ok(out?.message?.content);
    assert.ok(!out.message.content.includes("Wrap up") && !out.message.content.includes("Finish the current"));
  });
});

describe("amp measurement and notices", () => {
  it("intros small threads and warns past soft with stage boundaries", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 1000 });
    const small = createFakeThread({ id: "T-source", transcript: [textMsg(1, "hello")] });
    const smallOut = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "prompt", id: 2 }, eventCtx(small)) as any;
    assert.ok(smallOut.message.content.includes("auto-context-handover is active"));
    assert.ok(!smallOut.message.content.includes("Finish the current"));
    const warned = createFakeThread({ id: "T-source", transcript: [textMsg(1, bigText(4000))] });
    const warnOut = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 500 }, eventCtx(warned)) as any;
    assert.ok(warnOut.message.content.includes("Finish the current unit of work"));
    const warn2 = createFakeThread({ id: "T-source", transcript: [textMsg(1, bigText(4400))] });
    const warn2Out = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 501 }, eventCtx(warn2)) as any;
    assert.ok(warn2Out.message.content.includes("Wrap up now"));
  });
  it("pages across limit boundaries and never uses full:true", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 1000 });
    const transcript = Array.from({ length: 45 }, (_, i) => textMsg(i + 1, bigText(100)));
    const thread = createFakeThread({ id: "T-source", transcript });
    const out = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 1000 }, eventCtx(thread)) as any;
    assert.ok(out.message.content.includes("This advisory applies"));
  });
  it("resolves unknown when the page cap exhausts before the end", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 10 });
    // 250 full pages of 20 without a short page: the walk never establishes
    // the end, so the partial total must not pose as an estimate.
    const transcript = Array.from({ length: 5020 }, (_, i) => textMsg(i + 1, "x"));
    const thread = createFakeThread({ id: "T-source", transcript });
    const out = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 99999 }, eventCtx(thread)) as any;
    assert.ok(out.message.content.includes("auto-context-handover is active"));
    assert.ok(!out.message.content.includes("This advisory applies"));
  });
  it("resolves unknown for missing or invalid message ids", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 10 });
    const missing = createFakeThread({ id: "T-source", transcript: [{ role: "user", content: [{ type: "text", text: bigText(5000) }] }] });
    const missingOut = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 9 }, eventCtx(missing)) as any;
    assert.ok(!missingOut.message.content.includes("This advisory applies"));
    const invalid = createFakeThread({ id: "T-source", transcript: [{ id: null, role: "user", content: [{ type: "text", text: bigText(5000) }] }] });
    const invalidOut = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 9 }, eventCtx(invalid)) as any;
    assert.ok(!invalidOut.message.content.includes("This advisory applies"));
  });
  it("does not double count a prompt already visible as event.id", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 100000 });
    const transcript = [textMsg(7, bigText(100))];
    const thread = createFakeThread({ id: "T-source", transcript });
    const seen = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: bigText(100), id: 7 }, eventCtx(thread)) as any;
    assert.ok(!seen.message.content.includes("Finish the current"));
  });
  it("unknown on duplicate, malformed, and erroring transcripts without throwing", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 10 });
    const dup = createFakeThread({ id: "T-source", transcript: [textMsg(1, bigText(1000)), textMsg(1, bigText(1000))] });
    const dupOut = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 9 }, eventCtx(dup)) as any;
    assert.ok(!dupOut.message.content.includes("Finish the current"));
    const malformed = createFakeThread({ id: "T-source", transcript: [{ id: 1, role: "user", content: [{ type: "text" }] }] });
    const malOut = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 9 }, eventCtx(malformed)) as any;
    assert.ok(!malOut.message.content.includes("Finish the current"));
    const failing = createFakeThread({ id: "T-source", messagesFail: true });
    const failOut = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 9 }, eventCtx(failing)) as any;
    assert.ok(!failOut.message.content.includes("Finish the current"));
  });
  it("excludes image data from the estimate", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 100000 });
    const imageMsg = {
      id: 1, role: "user",
      content: [{ type: "tool_result", toolUseID: "t1", status: "done", output: [{ type: "image", mimeType: "image/png", data: "A".repeat(400000) }] }],
    };
    const thread = createFakeThread({ id: "T-source", transcript: [imageMsg] });
    const out = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 2 }, eventCtx(thread)) as any;
    assert.ok(!out.message.content.includes("Finish the current"));
  });
  it("child, background, and parent errors never notice and fail open", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-other");
    createAmpHandoverPlugin(fake.api, { dir, soft: 10 });
    const child = createFakeThread({ id: "T-source", parent: "T-parent", transcript: [textMsg(1, bigText(5000))] });
    assert.equal((await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 1 }, eventCtx(child)) as any)?.message, undefined);
    const bg = createFakeThread({ id: "T-source", transcript: [textMsg(1, bigText(5000))] });
    assert.equal((await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 1 }, eventCtx(bg)) as any)?.message, undefined);
    const errParent = createFakeThread({ id: "T-source", parent: "throw", transcript: [textMsg(1, bigText(5000))] });
    assert.equal((await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 1 }, eventCtx(errParent)) as any)?.message, undefined);
  });
});

describe("amp tool.result notices", () => {
  it("appends to string and text-block outputs preserving status and error", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 100 });
    const thread = createFakeThread({ id: "T-source", transcript: [textMsg(1, bigText(1000))] });
    const stringOut = await emit(fake, "tool.result",
      { thread: { id: "T-source" }, toolUseID: "new-1", tool: "read_file", input: {}, status: "error", error: "nope", output: "partial" },
      eventCtx(thread)) as any;
    assert.equal(stringOut.status, "error");
    assert.equal(stringOut.error, "nope");
    assert.ok(String(stringOut.output).includes("partial") && String(stringOut.output).includes("This advisory applies"));
    const blocksOut = await emit(fake, "tool.result",
      { thread: { id: "T-source" }, toolUseID: "new-2", tool: "read_file", input: {}, status: "done", output: [{ type: "text", text: "ok" }] },
      eventCtx(thread)) as any;
    assert.equal(blocksOut.status, "done");
    assert.equal(blocksOut.output.length, 2);
    assert.ok(blocksOut.output[1].text.includes("This advisory applies"));
  });
  it("leaves unsupported outputs unchanged and skips own tools without throwing", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 100 });
    const thread = createFakeThread({ id: "T-source", transcript: [textMsg(1, bigText(1000))] });
    assert.equal(await emit(fake, "tool.result",
      { thread: { id: "T-source" }, toolUseID: "u1", tool: "read_file", input: {}, status: "done", output: 42 },
      eventCtx(thread)), undefined);
    assert.equal(await emit(fake, "tool.result",
      { thread: { id: "T-source" }, toolUseID: "u2", tool: TOOL_NAME, input: {}, status: "done", output: "x" },
      eventCtx(thread)), undefined);
    assert.equal(await emit(fake, "tool.result",
      { thread: { id: "T-source" }, toolUseID: "u3", tool: READ_TOOL_NAME, input: {}, status: "done", output: "x" },
      eventCtx(thread)), undefined);
  });
  it("counts the current result when only tool_use is visible, with exact diagnostics", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 100000 });
    // "hi" (2) + tool_use input {} (2): a visible tool_use proves input, not
    // the result, so the 400-char current result must be added: (4+400)/4.
    const thread = createFakeThread({ id: "T-source", transcript: [textMsg(1, "hi"), toolUseMsg(2, "t1")] });
    const out = await emit(fake, "tool.result",
      { thread: { id: "T-source" }, toolUseID: "t1", tool: "read_file", input: {}, status: "done", output: bigText(400) },
      eventCtx(thread));
    assert.equal(out, undefined);
    const writer = fake.tools.get(TOOL_NAME)!;
    const diag = parseDiag(String(await writer.execute({ handover: "h", summary: "s" }, toolCtx(thread))));
    assert.equal(diag.estimate, "101");
    assert.equal(diag.reason, "not-nudged");
  });
  it("does not double count an already-final tool_result, with exact diagnostics", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 100000 });
    // "hi" (2) + terminal "small" result (5): the current 400-char output for
    // the same toolUseID is already final, so the estimate stays (2+5)/4.
    const thread = createFakeThread({ id: "T-source", transcript: [textMsg(1, "hi"), toolResultMsg(2, "t1", "done", "small")] });
    const out = await emit(fake, "tool.result",
      { thread: { id: "T-source" }, toolUseID: "t1", tool: "read_file", input: {}, status: "done", output: bigText(400) },
      eventCtx(thread));
    assert.equal(out, undefined);
    const writer = fake.tools.get(TOOL_NAME)!;
    const diag = parseDiag(String(await writer.execute({ handover: "h", summary: "s" }, toolCtx(thread))));
    assert.equal(diag.estimate, "2");
    assert.equal(diag.reason, "not-nudged");
  });
  it("pending tool_result placeholders do not prove the current result included", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 100000 });
    // "hi" (2) + pending "small" (5), but pending proves nothing, so the
    // current 400 chars are added: (7+400)/4 = 101.75 -> 102.
    const thread = createFakeThread({ id: "T-source", transcript: [textMsg(1, "hi"), toolResultMsg(2, "t1", "running", "small")] });
    const out = await emit(fake, "tool.result",
      { thread: { id: "T-source" }, toolUseID: "t1", tool: "read_file", input: {}, status: "done", output: bigText(400) },
      eventCtx(thread));
    assert.equal(out, undefined);
    const writer = fake.tools.get(TOOL_NAME)!;
    const diag = parseDiag(String(await writer.execute({ handover: "h", summary: "s" }, toolCtx(thread))));
    assert.equal(diag.estimate, "102");
  });
  it("unsupported output over soft records a known stage without a nudged reason", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 100 });
    const thread = createFakeThread({ id: "T-source", transcript: [textMsg(1, bigText(1000))] });
    assert.equal(await emit(fake, "tool.result",
      { thread: { id: "T-source" }, toolUseID: "u1", tool: "read_file", input: {}, status: "done", output: 42 },
      eventCtx(thread)), undefined);
    const writer = fake.tools.get(TOOL_NAME)!;
    const diag = parseDiag(String(await writer.execute({ handover: "h", summary: "s" }, toolCtx(thread))));
    assert.equal(diag.stage, "warn3");
    assert.equal(diag.reason, "not-nudged");
  });
  it("a staged start notice records a nudged reason in the stored diagnostics", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 1000 });
    const thread = createFakeThread({ id: "T-source", transcript: [textMsg(1, bigText(4000))] });
    const out = await emit(fake, "agent.start", { thread: { id: "T-source" }, message: "", id: 500 }, eventCtx(thread)) as any;
    assert.ok(out.message.content.includes("This advisory applies"));
    const writer = fake.tools.get(TOOL_NAME)!;
    const diag = parseDiag(String(await writer.execute({ handover: "h", summary: "s" }, toolCtx(thread))));
    assert.equal(diag.stage, "warn1");
    assert.equal(diag.reason, "nudged");
  });
});

describe("amp writer and reader storage", () => {
  it("stores first-wins, refuses children/background/aborted, and reads back", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const writer = fake.tools.get(TOOL_NAME);
    assert.ok(writer);
    const thread = createFakeThread({ id: "T-source" });
    const confirmation = String(await writer.execute({ handover: "full text here", summary: "did x, next y" }, toolCtx(thread)));
    assert.ok(confirmation.includes("T-source"));
    const paths = storedPaths(dir, "T-source");
    assert.ok(JSON.parse(readFileSync(paths.handover, "utf8")).handover.includes("full text here"));
    await assert.rejects(() => writer.execute({ handover: "second", summary: "s2" }, toolCtx(thread)), /already stored/);
    assert.ok(JSON.parse(readFileSync(paths.handover, "utf8")).handover.includes("full text here"));
    const child = createFakeThread({ id: "T-source", parent: "T-parent" });
    await assert.rejects(() => writer.execute({ handover: "x", summary: "y" }, toolCtx(child)), /refusing to store/);
    fake.activeThread.current = { id: "T-elsewhere" };
    await assert.rejects(() => writer.execute({ handover: "x", summary: "y" }, toolCtx(thread)), /refusing to store/);
    fake.activeThread.current = { id: "T-source" };
    const aborted = AbortSignal.abort();
    await assert.rejects(() => writer.execute({ handover: "x", summary: "y" }, toolCtx(thread, aborted)), /aborted/);
    const reader = fake.tools.get(READ_TOOL_NAME);
    assert.ok(reader);
    const text = String(await reader.execute({ threadID: "T-source" }, toolCtx(createFakeThread({ id: "T-child", parent: "T-p" }))));
    assert.ok(text.includes("full text here") && text.includes(SEED_FRAMING));
    assert.equal(String(await reader.execute({ threadID: "T-missing" }, toolCtx(thread))), `No handover stored for thread "T-missing" yet.`);
  });
  it("rejects whitespace-only handover and summary", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const writer = fake.tools.get(TOOL_NAME)!;
    const thread = createFakeThread({ id: "T-source" });
    await assert.rejects(() => writer.execute({ handover: "   ", summary: "s" }, toolCtx(thread)), /"handover"/);
    await assert.rejects(() => writer.execute({ handover: "h", summary: "  " }, toolCtx(thread)), /"summary"/);
  });
  it("publishes one intact verbatim pair across concurrent instances with private modes", async () => {
    const dir = testDir();
    const a = createFakeAmp();
    const b = createFakeAmp();
    createAmpHandoverPlugin(a.api, { dir });
    createAmpHandoverPlugin(b.api, { dir });
    const pairs = [{ handover: "  body a\n\n", summary: " summary a\n" }, { handover: "\n body b  ", summary: " summary b " }];
    const results = await Promise.allSettled([
      a.tools.get(TOOL_NAME)!.execute(pairs[0], toolCtx(createFakeThread())),
      b.tools.get(TOOL_NAME)!.execute(pairs[1], toolCtx(createFakeThread())),
    ]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const winner = results.findIndex(r => r.status === "fulfilled");
    const paths = storedPaths(dir, "T-source");
    const stored = JSON.parse(readFileSync(paths.handover, "utf8"));
    assert.equal(stored.handover, pairs[winner]!.handover);
    assert.equal(stored.summary, pairs[winner]!.summary);
    assert.equal(statSync(paths.dir).mode & 0o777, 0o700);
    assert.equal(statSync(paths.handover).mode & 0o777, 0o600);
  });
  it("reports claim-only and corrupt outcomes as unknown with inspect-before-retry guidance", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const reader = fake.tools.get(READ_TOOL_NAME)!;
    const thread = createFakeThread({ id: "T-source" });
    // No claim and no result: honestly not attempted.
    const plainDir = storedPaths(dir, "T-plain");
    mkdirSync(plainDir.dir, { recursive: true });
    writeFileSync(plainDir.handover, JSON.stringify({ version: 1, handover: "body", summary: "s", sourceThreadID: "T-plain", storedAt: 1, diag: {} }));
    const notAttempted = String(await reader.execute({ threadID: "T-plain" }, toolCtx(thread)));
    assert.ok(notAttempted.includes("No automatic continuation was attempted"));
    // Claim without a result (crash mid-attempt): unknown, inspect first,
    // never a blind retry.
    const paths = storedPaths(dir, "T-source");
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.handover, JSON.stringify({ version: 1, handover: "body", summary: "s", sourceThreadID: "T-source", storedAt: 1, diag: {} }));
    writeFileSync(paths.claim, JSON.stringify({ version: 1, sourceThreadID: "T-source", claimedAt: 2, eventId: "1" }));
    const claimed = String(await reader.execute({ threadID: "T-source" }, toolCtx(thread)));
    assert.ok(claimed.includes("unknown"));
    assert.ok(claimed.includes("inspect existing threads"));
    assert.ok(claimed.includes("automatic retry will not occur"));
    assert.ok(!claimed.includes("No automatic continuation was attempted"));
    // Corrupt result file: unknown, immutable body stands alone.
    writeFileSync(paths.result, "{not json");
    const corrupt = String(await reader.execute({ threadID: "T-source" }, toolCtx(thread)));
    assert.ok(corrupt.includes("unknown"));
    assert.ok(corrupt.includes("stands alone"));
  });
  it("adds compression advice when the stored handover alone exceeds half the soft limit", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 1000 });
    const writer = fake.tools.get(TOOL_NAME)!;
    const reader = fake.tools.get(READ_TOOL_NAME)!;
    const thread = createFakeThread({ id: "T-source" });
    const confirmation = String(await writer.execute({ handover: bigText(3000), summary: "s" }, toolCtx(thread)));
    assert.ok(confirmation.includes("compress carried-over completed notes"));
    const text = String(await reader.execute({ threadID: "T-source" }, toolCtx(thread)));
    assert.ok(text.includes("compress carried-over completed notes"));
  });
  it("does not treat an unreadable claim as an absent attempt", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir });
    const paths = storedPaths(dir, "T-source");
    await fake.tools.get(TOOL_NAME)!.execute({ handover: "body", summary: "s" }, toolCtx(createFakeThread()));
    mkdirSync(paths.claim);
    const text = String(await fake.tools.get(READ_TOOL_NAME)!.execute({ threadID: "T-source" }, toolCtx(createFakeThread())));
    assert.ok(text.includes("status: unknown"));
    assert.ok(!text.includes("No automatic continuation was attempted"));
  });
  it("surfaces corrupt storage without overwrite and reports reload unknowns honestly", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const paths = storedPaths(dir, "T-source");
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.handover, "{not json");
    const reader = fake.tools.get(READ_TOOL_NAME)!;
    await assert.rejects(() => reader.execute({ threadID: "T-source" }, toolCtx(createFakeThread())), /corrupt/);
    const fake2 = createFakeAmp("T-fresh");
    createAmpHandoverPlugin(fake2.api, { dir, soft: 150000 });
    const writer2 = fake2.tools.get(TOOL_NAME)!;
    const thread = createFakeThread({ id: "T-fresh" });
    const confirmation = String(await writer2.execute({ handover: "after reload", summary: "s" }, toolCtx(thread)));
    assert.ok(confirmation.includes("unknown"));
  });
});

describe("amp automatic continuation", () => {
  it("creates one fresh root thread and appends the exact seed via the source agent", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const agent = createFakeAgent();
    const thread = createFakeThread({ id: "T-source", agent });
    thread.agent = async () => agent.handle;
    const writer = fake.tools.get(TOOL_NAME)!;
    await writer.execute({ handover: "handover body", summary: "finished step, next continue" }, toolCtx(thread));
    await emit(fake, "agent.end", { thread: { id: "T-source" }, message: "p", id: 1, status: "done", messages: [] }, eventCtx(thread));
    assert.equal(agent.createCalls.length, 1);
    assert.deepEqual(agent.createCalls[0], { show: true });
    assert.ok(!("parentThreadID" in agent.createCalls[0]));
    assert.equal(agent.appendCalls.length, 1);
    const seed = String(agent.appendCalls[0]!.message.content);
    assert.ok(seed.includes("handover body"));
    assert.equal(seed.split("handover body").length - 1, 1);
    assert.ok(seed.includes("T-source") && seed.includes(SEED_FRAMING) && seed.includes("finished step"));
    assert.equal(fake.createAgentCalled, 0);
    assert.equal(fake.getBuiltinAgentCalled, 0);
    const paths = storedPaths(dir, "T-source");
    assert.ok(JSON.parse(readFileSync(paths.claim, "utf8")).sourceThreadID === "T-source");
    assert.equal(JSON.parse(readFileSync(paths.result, "utf8")).status, "seeded");
    await emit(fake, "agent.end", { thread: { id: "T-source" }, message: "p", id: 1, status: "done", messages: [] }, eventCtx(thread));
    assert.equal(agent.createCalls.length, 1);
  });
  it("duplicate concurrent ends create only once", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const agent = createFakeAgent();
    const thread = createFakeThread({ id: "T-source", agent });
    thread.agent = async () => agent.handle;
    await fake.tools.get(TOOL_NAME)!.execute({ handover: "b", summary: "s" }, toolCtx(thread));
    const end = { thread: { id: "T-source" }, message: "p", id: 1, status: "done", messages: [] };
    await Promise.all([emit(fake, "agent.end", end, eventCtx(thread)), emit(fake, "agent.end", end, eventCtx(thread))]);
    assert.equal(agent.createCalls.length, 1);
    assert.equal(agent.appendCalls.length, 1);
  });
  it("a prior claim blocks repeats without creating, even across instances", async () => {
    const dir = testDir();
    const fakeA = createFakeAmp("T-source");
    createAmpHandoverPlugin(fakeA.api, { dir, soft: 150000 });
    const agent = createFakeAgent();
    const thread = createFakeThread({ id: "T-source", agent });
    thread.agent = async () => agent.handle;
    await fakeA.tools.get(TOOL_NAME)!.execute({ handover: "b", summary: "s" }, toolCtx(thread));
    // A second instance sees the same storage: its writer loses first-wins.
    const fakeB = createFakeAmp("T-source");
    createAmpHandoverPlugin(fakeB.api, { dir, soft: 150000 });
    await assert.rejects(() => fakeB.tools.get(TOOL_NAME)!.execute({ handover: "b2", summary: "s2" }, toolCtx(thread)), /already stored/);
    // A claim planted by another attempt (or process) blocks creation.
    const paths = storedPaths(dir, "T-source");
    writeFileSync(paths.claim, JSON.stringify({ version: 1, sourceThreadID: "T-source", claimedAt: 1, eventId: "0" }));
    await emit(fakeA, "agent.end", { thread: { id: "T-source" }, message: "p", id: 1, status: "done", messages: [] }, eventCtx(thread));
    assert.equal(agent.createCalls.length, 0);
  });
  it("no pending after reload means no continuation, but the handover still reads", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-r");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const agent = createFakeAgent();
    const thread = createFakeThread({ id: "T-r", agent });
    thread.agent = async () => agent.handle;
    await fake.tools.get(TOOL_NAME)!.execute({ handover: "reload body", summary: "s" }, toolCtx(thread));
    const reloaded = createFakeAmp("T-r");
    createAmpHandoverPlugin(reloaded.api, { dir, soft: 150000 });
    const agent2 = createFakeAgent();
    const thread2 = createFakeThread({ id: "T-r", agent: agent2 });
    thread2.agent = async () => agent2.handle;
    await emit(reloaded, "agent.end", { thread: { id: "T-r" }, message: "p", id: 1, status: "done", messages: [] }, eventCtx(thread2));
    assert.equal(agent2.createCalls.length, 0);
    assert.ok(!existsSync(storedPaths(dir, "T-r").claim));
    const text = String(await reloaded.tools.get(READ_TOOL_NAME)!.execute({ threadID: "T-r" }, toolCtx(thread2)));
    assert.ok(text.includes("reload body") && text.includes("No automatic continuation was attempted"));
  });
  it("stays silent on error status and focus change, claiming nothing", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const agent = createFakeAgent();
    const thread = createFakeThread({ id: "T-source", agent });
    thread.agent = async () => agent.handle;
    const writer = fake.tools.get(TOOL_NAME)!;
    await writer.execute({ handover: "body", summary: "s" }, toolCtx(thread));
    await emit(fake, "agent.end", { thread: { id: "T-source" }, message: "p", id: 1, status: "error", messages: [] }, eventCtx(thread));
    assert.equal(agent.createCalls.length, 0);
    assert.ok(!existsSync(storedPaths(dir, "T-source").claim));
    fake.activeThread.current = { id: "T-elsewhere" };
    const pendingThread = createFakeThread({ id: "T-source", agent });
    pendingThread.agent = async () => agent.handle;
    await emit(fake, "agent.end", { thread: { id: "T-source" }, message: "p", id: 2, status: "done", messages: [] }, eventCtx(pendingThread));
    assert.equal(agent.createCalls.length, 0);
    assert.ok(!existsSync(storedPaths(dir, "T-source").claim));
    const reader = fake.tools.get(READ_TOOL_NAME)!;
    const manual = String(await reader.execute({ threadID: "T-source" }, toolCtx(createFakeThread())));
    assert.ok(manual.includes("body"));
    assert.ok(manual.includes("No automatic continuation was attempted"));
  });
  it("rechecks focus after obtaining the agent and skips without creating", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-focus");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const agent = createFakeAgent();
    const thread = createFakeThread({ id: "T-focus", agent });
    thread.agent = async () => {
      fake.activeThread.current = { id: "T-elsewhere" };
      return agent.handle;
    };
    await fake.tools.get(TOOL_NAME)!.execute({ handover: "b", summary: "s" }, toolCtx(thread));
    await emit(fake, "agent.end", { thread: { id: "T-focus" }, message: "p", id: 1, status: "done", messages: [] }, eventCtx(thread));
    assert.equal(agent.createCalls.length, 0);
    assert.equal(JSON.parse(readFileSync(storedPaths(dir, "T-focus").result, "utf8")).status, "skipped-focus-changed");
  });
  it("does not claim or create after a live pending handover loses focus", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-source");
    createAmpHandoverPlugin(fake.api, { dir });
    const agent = createFakeAgent();
    const thread = createFakeThread({ agent });
    await fake.tools.get(TOOL_NAME)!.execute({ handover: "body", summary: "s" }, toolCtx(thread));
    fake.activeThread.current = { id: "T-other" };
    await emit(fake, "agent.end", { thread: { id: "T-source" }, message: "p", id: 1, status: "done", messages: [] }, eventCtx(thread));
    assert.equal(agent.createCalls.length, 0);
    assert.ok(!existsSync(storedPaths(dir, "T-source").claim));
  });
  it("a rejected create is uncertain, never a confirmed no-side-effect failure", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-c");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const failingAgent = createFakeAgent();
    failingAgent.createFail = true;
    const logs: string[] = [];
    const thread = createFakeThread({ id: "T-c", agent: failingAgent });
    thread.agent = async () => failingAgent.handle;
    await fake.tools.get(TOOL_NAME)!.execute({ handover: "b", summary: "s" }, toolCtx(thread));
    await emit(fake, "agent.end", { thread: { id: "T-c" }, message: "p", id: 1, status: "done", messages: [] }, eventCtx(thread, { log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); } }));
    assert.equal(failingAgent.createCalls.length, 1);
    assert.equal(JSON.parse(readFileSync(storedPaths(dir, "T-c").result, "utf8")).status, "create-uncertain");
    assert.ok(logs.some((line) => line.includes("uncertain") && line.includes("before creating anything manually")));
    const reader = String(await fake.tools.get(READ_TOOL_NAME)!.execute({ threadID: "T-c" }, toolCtx(thread)));
    assert.ok(reader.includes("create-uncertain"));
  });
  it("never appends after an untracked successor id", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-t");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    // The result path is a directory, so persisting the successor id
    // fails: no seed may be appended to the untracked successor.
    mkdirSync(storedPaths(dir, "T-t").result, { recursive: true });
    const logs: string[] = [];
    const agent = createFakeAgent();
    const thread = createFakeThread({ id: "T-t", agent });
    thread.agent = async () => agent.handle;
    await fake.tools.get(TOOL_NAME)!.execute({ handover: "b", summary: "s" }, toolCtx(thread));
    await emit(fake, "agent.end", { thread: { id: "T-t" }, message: "p", id: 1, status: "done", messages: [] }, eventCtx(thread, { log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); } }));
    assert.equal(agent.createCalls.length, 1);
    const successor = agent.successors[0]!;
    assert.equal(successor.appended.length, 0);
    assert.equal(agent.appendCalls.length, 0);
    assert.ok(logs.some((line) => line.includes(successor.id) && line.includes("No seed was appended")));
    assert.ok(existsSync(storedPaths(dir, "T-t").claim));
  });
  it("an append failure keeps the successor id with recovery guidance", async () => {
    const dir = testDir();
    const fake = createFakeAmp("T-a");
    createAmpHandoverPlugin(fake.api, { dir, soft: 150000 });
    const appendAgent = createFakeAgent();
    appendAgent.failNextAppend = true;
    const logs: string[] = [];
    const thread = createFakeThread({ id: "T-a", agent: appendAgent });
    thread.agent = async () => appendAgent.handle;
    await fake.tools.get(TOOL_NAME)!.execute({ handover: "b", summary: "s" }, toolCtx(thread));
    await emit(fake, "agent.end", { thread: { id: "T-a" }, message: "p", id: 1, status: "done", messages: [] }, eventCtx(thread, { log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); } }));
    const result = JSON.parse(readFileSync(storedPaths(dir, "T-a").result, "utf8"));
    assert.equal(result.status, "append-failed");
    assert.ok(typeof result.successorThreadID === "string" && result.successorThreadID.length > 0);
    assert.ok(logs.some((line) => line.includes("uncertain")));
  });
});
