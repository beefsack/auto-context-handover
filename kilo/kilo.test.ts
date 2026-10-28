// Kilo adapter tests: fake host client, real fs under os.tmpdir.
// No live HOME mutation (storage dir is always injected), no network, no model.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hooks, PluginInput } from "@kilocode/plugin";
import type { Message, Part, UserMessage } from "@kilocode/sdk";
import descriptor, {
  DEFAULT_SOFT,
  ENV_SOFT,
  PLUGIN_NAME,
  READ_TOOL_NAME,
  TOOL_NAME,
} from "./index.ts";

// Every tmpdir this file creates, removed afterwards. Only exact created
// directories are ever removed.
const createdDirs: string[] = [];
after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function trackDir(dir: string): string {
  createdDirs.push(dir);
  return dir;
}

type SessionMode =
  | { readonly kind: "root" }
  | { readonly kind: "child" }
  | { readonly kind: "throw" }
  | { readonly kind: "mismatch" };

interface FakeClientState {
  sessionCalls: string[];
  providerCalls: number;
}

function fakeClient(sessionMode: SessionMode, catalog: unknown, state: FakeClientState) {
  return {
    session: {
      get: async (args: { path: { id: string } }): Promise<{ data?: unknown; error?: unknown }> => {
        state.sessionCalls.push(args.path.id);
        if (sessionMode.kind === "throw") throw new Error("host session store down");
        if (sessionMode.kind === "mismatch") return { data: { id: "someone-else" } };
        return {
          data: {
            id: args.path.id,
            ...(sessionMode.kind === "child" ? { parentID: "parent-1" } : {}),
          },
        };
      },
    },
    provider: {
      list: async (): Promise<{ data?: unknown; error?: unknown }> => {
        state.providerCalls += 1;
        if (catalog === undefined) throw new Error("catalog unavailable");
        return { data: catalog };
      },
    },
  };
}

function catalogWith(context: number, providerID = "acme", modelID = "m1"): unknown {
  return {
    all: [{ id: providerID, models: { [modelID]: { id: modelID, limit: { context } } } }],
    default: {},
    connected: [],
    failed: [],
  };
}

interface Harness {
  readonly dir: string;
  readonly hooks: Hooks;
  readonly state: FakeClientState;
}

async function setupHarness(options: {
  readonly session?: SessionMode;
  readonly catalog?: unknown;
  readonly serverOptions?: Record<string, unknown>;
} = {}): Promise<Harness> {
  const dir = trackDir(mkdtempSync(join(tmpdir(), "kilo-ho-test-")));
  const state: FakeClientState = { sessionCalls: [], providerCalls: 0 };
  const client = fakeClient(options.session ?? { kind: "root" }, options.catalog, state);
  const input = {
    client,
    project: { id: "proj" },
    directory: "/work",
    worktree: "/work",
    experimental_workspace: { register: (): void => undefined },
    serverUrl: new URL("http://127.0.0.1:1412/"),
    $: {},
  } as unknown as PluginInput;
  const hooks = await descriptor.server(input, {
    dir,
    env: {},
    now: () => 1000,
    ...(options.serverOptions ?? {}),
  });
  return { dir, hooks, state };
}

// --- Message builders (well-formed per the SDK Message/Part shapes). ---

function userMessage(id: string, sessionID: string, created = 1): Message {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "main",
    model: { providerID: "acme", modelID: "m1" },
  } as Message;
}

/** The host-assigned message carried on chat.message output. */
function hostUserMessage(id: string, sessionID: string): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "main",
    model: { providerID: "acme", modelID: "m1" },
  } as UserMessage;
}

function assistantMessage(
  id: string,
  sessionID: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  created = 2,
): Message {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created, completed: created + 1 },
    parentID: "u1",
    modelID: "m1",
    providerID: "acme",
    mode: "default",
    agent: "main",
    path: { cwd: "/work", root: "/work" },
    cost: 0,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.read, write: tokens.write },
    },
  } as Message;
}

function textPart(id: string, sessionID: string, messageID: string, text: string): Part {
  return { id, sessionID, messageID, type: "text", text } as Part;
}

function filePart(id: string, sessionID: string, messageID: string): Part {
  return { id, sessionID, messageID, type: "file", mime: "image/png", url: "file:///img.png" } as Part;
}

function toolPart(
  id: string,
  sessionID: string,
  messageID: string,
  state: Record<string, unknown>,
): Part {
  return { id, sessionID, messageID, type: "tool", callID: "c1", tool: "read", state } as Part;
}

type Msg = { info: Message; parts: Part[] };
type TransformFn = (input: {}, output: { messages: Msg[] }) => Promise<void>;
type ChatMessageFn = (
  input: { sessionID?: string },
  output: { message: UserMessage; parts: Part[] },
) => Promise<void>;
type CompactingFn = (
  input: { sessionID: string },
  output: { context: string[]; prompt?: string },
) => Promise<void>;
type EventFn = (input: { event: unknown }) => Promise<void>;
type ExecuteFn = (args: unknown, context: unknown) => Promise<string>;

function toolsOf(hooks: Hooks): Map<string, { execute: ExecuteFn }> {
  const map = new Map<string, { execute: ExecuteFn }>();
  const tool = hooks.tool ?? {};
  for (const name of Object.keys(tool)) {
    map.set(name, tool[name] as unknown as { execute: ExecuteFn });
  }
  return map;
}

function exec(
  tools: Map<string, { execute: ExecuteFn }>,
  name: string,
  args: unknown,
  context: unknown,
): Promise<string> {
  const tool = tools.get(name);
  assert.ok(tool, `expected tool ${name} to be registered`);
  return tool.execute(args, context);
}

function storedDir(dir: string, sessionID: string): string {
  return join(dir, createHash("sha256").update(sessionID, "utf8").digest("hex"));
}

function storedFile(dir: string, sessionID: string): string {
  return join(storedDir(dir, sessionID), "handover.json");
}

/** Read back the persisted writer diagnostics (reason/stage/estimate/soft). */
function readStoredDiag(dir: string, sessionID: string): Record<string, unknown> {
  const raw = readFileSync(storedFile(dir, sessionID), "utf8");
  return (JSON.parse(raw) as Record<string, unknown>).diag as Record<string, unknown>;
}

describe("kilo plugin registration", () => {
  it("exports a default descriptor with id and server, and nothing else callable", async () => {
    assert.equal(descriptor.id, PLUGIN_NAME);
    assert.equal(typeof descriptor.server, "function");
    assert.equal((descriptor as Record<string, unknown>).tui, undefined);
  });

  it("server returns the shipped Hooks contract with exactly two tools", async () => {
    const { hooks } = await setupHarness();
    assert.ok(hooks.tool);
    assert.deepEqual(Object.keys(hooks.tool).sort(), [READ_TOOL_NAME, TOOL_NAME].sort());
    assert.equal(typeof hooks["chat.message"], "function");
    assert.equal(typeof hooks["experimental.chat.messages.transform"], "function");
    assert.equal(typeof hooks["experimental.session.compacting"], "function");
    assert.equal(typeof hooks.event, "function");
    assert.equal(typeof hooks.dispose, "function");
    // No session creation, no compaction autocontinue, no hard gate surface.
    assert.equal(hooks["experimental.compaction.autocontinue"], undefined);
  });

  it("compacting hook is observation-only and never mutates prompt/context", async () => {
    const { hooks } = await setupHarness();
    const compacting = hooks["experimental.session.compacting"] as unknown as CompactingFn;
    const output = { context: ["keep"], prompt: undefined as string | undefined };
    await compacting({ sessionID: "s1" }, output);
    assert.deepEqual(output, { context: ["keep"], prompt: undefined });
  });
});

describe("intro via chat.message", () => {
  it("appends one intro part bound to output.message.id and never duplicates", async () => {
    const { hooks } = await setupHarness();
    const chat = hooks["chat.message"] as unknown as ChatMessageFn;
    const output = { message: hostUserMessage("msg_m1", "s1"), parts: [] as Part[] };
    await chat({ sessionID: "s1" }, output);
    assert.equal(output.parts.length, 1);
    const part = output.parts[0] as unknown as Record<string, unknown>;
    assert.equal(part.type, "text");
    assert.match(part.text as string, /auto-context-handover is active/);
    assert.equal(part.sessionID, "s1");
    assert.equal(part.messageID, "msg_m1");
    assert.match(part.id as string, /^prt_/);
    await chat({ sessionID: "s1" }, output);
    assert.equal(output.parts.length, 1);
  });

  it("binds each intro to the current output.message.id, never input.messageID", async () => {
    const { hooks } = await setupHarness();
    const chat = hooks["chat.message"] as unknown as ChatMessageFn;
    const event = hooks["event"] as unknown as EventFn;
    const first = { message: hostUserMessage("msg_mA", "s1"), parts: [] as Part[] };
    await chat({ sessionID: "s1" }, first);
    assert.equal((first.parts[0] as unknown as Record<string, unknown>).messageID, "msg_mA");
    await event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
    // No messageID on input at all: the part still binds output.message.id.
    const second = { message: hostUserMessage("msg_mB", "s1"), parts: [] as Part[] };
    await chat({ sessionID: "s1" }, second);
    assert.equal((second.parts[0] as unknown as Record<string, unknown>).messageID, "msg_mB");
  });

  it("skips when the assigned message is missing or names another session", async () => {
    const { hooks } = await setupHarness();
    const chat = hooks["chat.message"] as unknown as ChatMessageFn;
    const missing = { parts: [] as Part[] } as unknown as { message: UserMessage; parts: Part[] };
    await chat({ sessionID: "s1" }, missing);
    assert.equal(missing.parts.length, 0);
    const mismatch = { message: hostUserMessage("msg_x", "other"), parts: [] as Part[] };
    await chat({ sessionID: "s1" }, mismatch);
    assert.equal(mismatch.parts.length, 0);
  });

  it("skips when the marker is already present in the current output parts", async () => {
    const { hooks } = await setupHarness();
    const chat = hooks["chat.message"] as unknown as ChatMessageFn;
    const output = {
      message: hostUserMessage("msg_m1", "s1"),
      parts: [textPart("p", "s1", "msg_m1", "prefix auto-context-handover is active for this root session. suffix")],
    };
    await chat({ sessionID: "s1" }, output);
    assert.equal(output.parts.length, 1);
  });

  it("re-sends the intro after a server reload with a new user message", async () => {
    const first = await setupHarness();
    const out1 = { message: hostUserMessage("msg_a", "s1"), parts: [] as Part[] };
    await (first.hooks["chat.message"] as unknown as ChatMessageFn)({ sessionID: "s1" }, out1);
    assert.equal(out1.parts.length, 1);
    // Reload: brand-new server instance, fresh user message, no marker. The
    // marker only covers current output parts, so the intro is re-sent; no
    // history is fetched to prevent it.
    const second = await setupHarness();
    const out2 = { message: hostUserMessage("msg_b", "s1"), parts: [] as Part[] };
    await (second.hooks["chat.message"] as unknown as ChatMessageFn)({ sessionID: "s1" }, out2);
    assert.equal(out2.parts.length, 1);
  });

  it("stays silent for child sessions and unavailable hosts", async () => {
    const child = await setupHarness({ session: { kind: "child" } });
    const out1 = { message: hostUserMessage("msg_m1", "s1"), parts: [] as Part[] };
    await (child.hooks["chat.message"] as unknown as ChatMessageFn)({ sessionID: "s1" }, out1);
    assert.equal(out1.parts.length, 0);
    const down = await setupHarness({ session: { kind: "throw" } });
    const out2 = { message: hostUserMessage("msg_m1", "s1"), parts: [] as Part[] };
    await (down.hooks["chat.message"] as unknown as ChatMessageFn)({ sessionID: "s1" }, out2);
    assert.equal(out2.parts.length, 0);
  });
});

describe("measurement mapping", () => {
  it("sums the five normalized fields once and adds settled tool results plus trailing chars/4", async () => {
    // Anchor: 100+20+10+5+5 = 140. Anchor tool output 10 chars + error
    // text 7 chars + trailing user 4 chars = 21 chars -> ceil(21/4) = 6.
    // Estimate 140 + 6 = 146. The anchor's own text/input is never counted.
    const { hooks, dir } = await setupHarness({ serverOptions: { soft: 140 } });
    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [textPart("p1", "s1", "u1", "hello")] },
      {
        info: assistantMessage("a1", "s1", { input: 100, output: 20, reasoning: 10, read: 5, write: 5 }),
        parts: [
          textPart("p2", "s1", "a1", "xx"),
          toolPart("t1", "s1", "a1", { status: "completed", input: { a: 1 }, output: "0123456789", title: "t", metadata: {}, time: { start: 1, end: 2 } }),
          toolPart("t2", "s1", "a1", { status: "error", input: {}, error: "oopsie!", time: { start: 1, end: 2 } }),
        ],
      },
      { info: userMessage("u2", "s1", 3), parts: [textPart("p3", "s1", "u2", "abcd")] },
    ];
    const before = JSON.stringify(messages);
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    assert.equal(messages.length, 4);
    assert.equal(JSON.stringify(messages.slice(0, 3)), before);
    const notice = messages[3] as Msg;
    const noticeInfo = notice.info as unknown as Record<string, unknown>;
    assert.equal(noticeInfo.role, "user");
    assert.equal(noticeInfo.sessionID, "s1");
    assert.match(noticeInfo.id as string, /^msg_/);
    const noticePart = notice.parts[0] as unknown as Record<string, unknown>;
    assert.match(noticePart.id as string, /^prt_/);
    assert.equal(noticePart.messageID, noticeInfo.id);
    const text = noticePart.text as string;
    assert.match(text, /Context is filling/);
    assert.ok(!text.includes("Diagnostics:"), "notice text is stable per stage, no live diagnostics");
    await exec(toolsOf(hooks), TOOL_NAME, { handover: "full handover text", summary: "s" }, { sessionID: "s1", agent: "main" });
    const diag = readStoredDiag(dir, "s1");
    assert.equal(diag.estimate, 146);
    assert.equal(diag.stage, "warn1");
    assert.equal(diag.reason, "nudged");
    assert.equal(diag.soft, 140);
  });

  it("skips all-zero anchors (the empty current assistant) and omits file parts", async () => {
    const { hooks, dir } = await setupHarness({ serverOptions: { soft: 100 } });
    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [textPart("p1", "s1", "u1", "hi")] },
      {
        info: assistantMessage("a1", "s1", { input: 100, output: 20, reasoning: 10, read: 5, write: 5 }),
        parts: [],
      },
      {
        info: userMessage("u2", "s1", 3),
        parts: [textPart("p3", "s1", "u2", ""), filePart("f1", "s1", "u2")],
      },
      {
        info: assistantMessage("a2", "s1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 4),
        parts: [toolPart("t9", "s1", "a2", { status: "running", input: {}, time: { start: 1 } })],
      },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    // Anchor a1 (140) + trailing user (0: empty text, file omitted) + a2
    // running tool (input {} -> 2 own chars -> ceil(2/4) = 1) = 141.
    assert.equal(messages.length, 5);
    await exec(toolsOf(hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
    assert.equal(readStoredDiag(dir, "s1").estimate, 141);
  });

  it("refuses mixed sessions and empty input without host calls", async () => {
    const { hooks, state } = await setupHarness({ serverOptions: { soft: 1 } });
    const mixed: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      { info: userMessage("u2", "s2"), parts: [] },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages: mixed });
    assert.equal(mixed.length, 2);
    assert.equal(state.sessionCalls.length, 0);
    const empty: Msg[] = [];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages: empty });
    assert.equal(empty.length, 0);
    assert.equal(state.sessionCalls.length, 0);
  });

  it("stays silent for child sessions and requires no model window for integer soft", async () => {
    const child = await setupHarness({ session: { kind: "child" }, serverOptions: { soft: 1 } });
    const messages: Msg[] = [
      {
        info: assistantMessage("a1", "s9", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await (child.hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    assert.equal(messages.length, 1);
  });
});

describe("compaction-summary skip", () => {
  it("skips the paired transform with no notice and no diagnostic overwrite", async () => {
    const { hooks, dir } = await setupHarness({ serverOptions: { soft: 1000 } });
    const transform = hooks["experimental.chat.messages.transform"] as unknown as TransformFn;
    const compacting = hooks["experimental.session.compacting"] as unknown as CompactingFn;
    // Ordinary nudged pass first: estimate 1000 -> warn1 diagnostics.
    const ordinary: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      {
        info: assistantMessage("a1", "s1", { input: 1000, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await transform({}, { messages: ordinary });
    assert.equal(ordinary.length, 3);
    // Real paired hook sequence on a head WITHOUT any compaction part (the
    // parent compaction part is already sliced off upstream): even a huge
    // estimate must not append or overwrite diagnostics.
    const head: Msg[] = [
      { info: userMessage("u9", "s1", 9), parts: [textPart("p9", "s1", "u9", "history")] },
      {
        info: assistantMessage("a9", "s1", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }, 10),
        parts: [],
      },
    ];
    await compacting({ sessionID: "s1" }, { context: [], prompt: undefined });
    const before = JSON.stringify(head);
    await transform({}, { messages: head });
    assert.equal(JSON.stringify(head), before);
    await exec(toolsOf(hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
    const diag = readStoredDiag(dir, "s1");
    assert.equal(diag.stage, "warn1");
    assert.equal(diag.estimate, 1000);
    assert.equal(diag.reason, "nudged");
  });

  it("keeps working for the next ordinary transform and isolates other sessions", async () => {
    const { hooks } = await setupHarness({ serverOptions: { soft: 1000 } });
    const transform = hooks["experimental.chat.messages.transform"] as unknown as TransformFn;
    const compacting = hooks["experimental.session.compacting"] as unknown as CompactingFn;
    await compacting({ sessionID: "sX" }, { context: [], prompt: undefined });
    // Another session's ordinary nudged transform is unaffected by sX's flag.
    const other: Msg[] = [
      { info: userMessage("u1", "s2"), parts: [] },
      {
        info: assistantMessage("a1", "s2", { input: 1000, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await transform({}, { messages: other });
    assert.equal(other.length, 3);
    // sX's own next transform consumes its flag: skipped, not nudged.
    const flagged: Msg[] = [
      { info: userMessage("u2", "sX"), parts: [] },
      {
        info: assistantMessage("a2", "sX", { input: 1000, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await transform({}, { messages: flagged });
    assert.equal(flagged.length, 2);
    // And the ordinary transform after that works again.
    const next: Msg[] = [
      { info: userMessage("u3", "sX"), parts: [] },
      {
        info: assistantMessage("a3", "sX", { input: 1000, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await transform({}, { messages: next });
    assert.equal(next.length, 3);
  });
});

describe("post-compaction anchor policy", () => {
  function summaryMessage(
    id: string,
    sessionID: string,
    tokens: { input: number; output: number; reasoning: number; read: number; write: number },
    created: unknown = 10,
  ): Message {
    const info = assistantMessage("x", "y", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }) as unknown as Record<string, unknown>;
    Object.assign(info, {
      id,
      sessionID,
      summary: true,
      finish: "stop",
      agent: "compaction",
      mode: "compaction",
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.read, write: tokens.write },
      },
      time: { created, completed: 11 },
    });
    return info as unknown as Message;
  }

  it("high-token summary alone never nudges and stores unknown", async () => {
    const { hooks, dir } = await setupHarness({ serverOptions: { soft: 100 } });
    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      { info: summaryMessage("a-sum", "s1", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }), parts: [] },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    assert.equal(messages.length, 2);
    await exec(toolsOf(hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
    const diag = readStoredDiag(dir, "s1");
    assert.equal(diag.estimate, "unknown");
    assert.equal(diag.stage, "unknown");
    assert.equal(diag.reason, "unknown");
  });

  it("retained-tail old assistant positioned after summary must not anchor", async () => {
    // Array order mimics filterCompacted ([compaction-user, summary, ...old
    // tail..., new user]) but the old assistant (created 2) predates the
    // summary (created 10), so chronology forbids the anchor.
    const { hooks, dir } = await setupHarness({ serverOptions: { soft: 100 } });
    const messages: Msg[] = [
      { info: userMessage("u0", "s1"), parts: [] },
      { info: summaryMessage("a-sum", "s1", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }), parts: [] },
      {
        info: assistantMessage("a-old", "s1", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }, 2),
        parts: [],
      },
      { info: userMessage("u1", "s1", 11), parts: [] },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    assert.equal(messages.length, 4);
    await exec(toolsOf(hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
    const diag = readStoredDiag(dir, "s1");
    assert.equal(diag.estimate, "unknown");
    assert.equal(diag.stage, "unknown");
  });

  it("fresh ordinary response after summary resumes measurement with no double count", async () => {
    const { hooks, dir } = await setupHarness({ serverOptions: { soft: 1000 } });
    const messages: Msg[] = [
      { info: userMessage("u0", "s1"), parts: [] },
      { info: summaryMessage("a-sum", "s1", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }), parts: [] },
      {
        info: assistantMessage("a-old", "s1", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }, 2),
        parts: [],
      },
      {
        info: assistantMessage("a-new", "s1", { input: 1000, output: 0, reasoning: 0, read: 0, write: 0 }, 12),
        parts: [],
      },
      { info: userMessage("u2", "s1", 13), parts: [textPart("p9", "s1", "u2", "abcd")] },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    // Anchor a-new (1000) + trailing user 4 chars -> 1000 + 1 = 1001 (warn1).
    // Summary/old-tail tokens (5000 each) are excluded, never re-added.
    assert.equal(messages.length, 6);
    await exec(toolsOf(hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
    const diag = readStoredDiag(dir, "s1");
    assert.equal(diag.estimate, 1001);
    assert.equal(diag.stage, "warn1");
    assert.equal(diag.reason, "nudged");
  });

  it("malformed timestamps stay conservative unknown", async () => {
    // Case A: summary with a non-numeric created poisons ordering even when
    // a fresh ordinary assistant carries huge usage.
    const first = await setupHarness({ serverOptions: { soft: 100 } });
    const badSummary: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      { info: summaryMessage("a-sum", "s1", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }, "bad"), parts: [] },
      {
        info: assistantMessage("a-new", "s1", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }, 12),
        parts: [],
      },
    ];
    await (first.hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages: badSummary });
    assert.equal(badSummary.length, 3);
    await exec(toolsOf(first.hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
    assert.equal(readStoredDiag(first.dir, "s1").estimate, "unknown");

    // Case B: valid summary but an ordinary assistant with no usable created
    // cannot prove it is post-compaction.
    const second = await setupHarness({ serverOptions: { soft: 100 } });
    const fresh = assistantMessage("a-new", "s1", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }, 12) as unknown as Record<string, unknown>;
    fresh.time = {};
    const noTime: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      { info: summaryMessage("a-sum", "s1", { input: 5000, output: 0, reasoning: 0, read: 0, write: 0 }), parts: [] },
      { info: fresh as unknown as Message, parts: [] },
    ];
    await (second.hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages: noTime });
    assert.equal(noTime.length, 3);
    await exec(toolsOf(second.hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
    assert.equal(readStoredDiag(second.dir, "s1").estimate, "unknown");
  });
});

describe("model window and soft plumbing", () => {
  it("caps integer soft at 70% of the catalog context limit", async () => {
    const { hooks, dir } = await setupHarness({
      catalog: catalogWith(100000),
      serverOptions: { soft: 150000 },
    });
    // Capped soft = 70000; anchor 70000 -> warn1.
    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      {
        info: assistantMessage("a1", "s1", { input: 70000, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    assert.equal(messages.length, 3);
    await exec(toolsOf(hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
    assert.equal(readStoredDiag(dir, "s1").soft, 70000);
  });

  it("resolves percent soft against the catalog and stays silent without a window", async () => {
    const withWindow = await setupHarness({
      catalog: catalogWith(200000),
      serverOptions: { env: { [ENV_SOFT]: "50%" } },
    });
    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      {
        info: assistantMessage("a1", "s1", { input: 100000, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await (withWindow.hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    assert.equal(messages.length, 3);
    await exec(toolsOf(withWindow.hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
    assert.equal(readStoredDiag(withWindow.dir, "s1").soft, 100000);

    const noWindow = await setupHarness({
      catalog: undefined,
      serverOptions: { env: { [ENV_SOFT]: "50%" } },
    });
    const messages2: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      {
        info: assistantMessage("a1", "s1", { input: 900000, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await (noWindow.hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages: messages2 });
    assert.equal(messages2.length, 2);
  });

  it("uses the default soft uncapped when the catalog is unavailable", async () => {
    const { hooks } = await setupHarness({ catalog: undefined });
    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      {
        info: assistantMessage("a1", "s1", { input: DEFAULT_SOFT, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    assert.equal(messages.length, 3);
  });

  it("disables advisories on invalid soft but keeps the tools working", async () => {
    const { hooks } = await setupHarness({
      serverOptions: { env: { [ENV_SOFT]: "bogus" } },
    });
    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      {
        info: assistantMessage("a1", "s1", { input: 999999, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    assert.equal(messages.length, 2);
    const confirmation = await exec(toolsOf(hooks), TOOL_NAME,
      { handover: "full handover text here", summary: "did things, next steps" },
      { sessionID: "s1", agent: "main" },
    );
    assert.match(confirmation ?? "", /Handover stored for session s1/);
  });

  it("escalates warn1/warn2/warn3 at soft, soft*1.1, soft*1.2", async () => {
    const leads = ["Context is filling", "Wrap up now", "final warning"] as const;
    const cases = [[1000, "warn1"], [1100, "warn2"], [1200, "warn3"]] as const;
    for (let i = 0; i < cases.length; i++) {
      const [input, stage] = cases[i] as readonly [number, string];
      const { hooks, dir } = await setupHarness({ serverOptions: { soft: 1000 } });
      const messages: Msg[] = [
        { info: userMessage("u1", "s1"), parts: [] },
        {
          info: assistantMessage("a1", "s1", { input, output: 0, reasoning: 0, read: 0, write: 0 }),
          parts: [],
        },
      ];
      await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
      assert.equal(messages.length, 3);
      const text = (messages[2]?.parts[0] as unknown as Record<string, unknown>).text as string;
      assert.ok(text.includes(leads[i] as string), `expected lead for ${stage}`);
      await exec(toolsOf(hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
      assert.equal(readStoredDiag(dir, "s1").stage, stage);
    }
    const { hooks } = await setupHarness({ serverOptions: { soft: 1000 } });
    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      {
        info: assistantMessage("a1", "s1", { input: 999, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    assert.equal(messages.length, 2);
  });
});

describe("host tool conversion", () => {
  // Mirrors the host registry path (packages/opencode/src/tool/registry.ts):
  // z.object(def.args) with the HOST's zod copy, then safeParse per call and
  // toJSONSchema for the provider. Resolves the host zod the same way the
  // host module graph does: via @kilocode/plugin.
  async function hostZod(): Promise<{
    object: (shape: Record<string, unknown>) => {
      safeParse: (value: unknown) => { success: boolean };
    };
    toJSONSchema: (schema: unknown, options: unknown) => Record<string, unknown>;
  }> {
    const toolUrl = await import.meta.resolve("@kilocode/plugin/tool");
    const hostRequire = createRequire(fileURLToPath(toolUrl));
    const zod = hostRequire("zod") as {
      object: (shape: Record<string, unknown>) => {
        safeParse: (value: unknown) => { success: boolean };
      };
      toJSONSchema: (schema: unknown, options: unknown) => Record<string, unknown>;
    };
    return zod;
  }

  function shippedArgs(hooks: Hooks, name: string): Record<string, unknown> {
    const tool = (hooks.tool ?? {})[name] as unknown as { args: Record<string, unknown> };
    assert.ok(tool, `expected tool ${name} to be registered`);
    return tool.args;
  }

  it("accepts good writer args and rejects blank/mistyped ones through host zod", async () => {
    const { hooks } = await setupHarness();
    const zod = await hostZod();
    const schema = zod.object(shippedArgs(hooks, TOOL_NAME));
    assert.equal(schema.safeParse({ handover: "full text", summary: "short" }).success, true);
    assert.equal(schema.safeParse({}).success, false);
    assert.equal(schema.safeParse({ handover: 42, summary: "s" }).success, false);
    assert.equal(schema.safeParse({ handover: "  ", summary: "s" }).success, true);
  });

  it("accepts good reader args and rejects blank ones through host zod", async () => {
    const { hooks } = await setupHarness();
    const zod = await hostZod();
    const schema = zod.object(shippedArgs(hooks, READ_TOOL_NAME));
    assert.equal(schema.safeParse({ sessionID: "s1" }).success, true);
    assert.equal(schema.safeParse({}).success, false);
  });

  it("converts to provider JSON Schema with properties/required intact", async () => {
    const { hooks } = await setupHarness();
    const zod = await hostZod();
    const writerSchema = zod.toJSONSchema(zod.object(shippedArgs(hooks, TOOL_NAME)), { io: "input" });
    const properties = writerSchema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(properties).sort(), ["handover", "summary"]);
    assert.deepEqual((writerSchema.required as string[]).sort(), ["handover", "summary"]);
    assert.equal(properties.handover?.type, "string");
    // Known loss under the pinned cross-version pair (repo zod 4.6 schemas
    // converted by host zod 4.1): descriptions do not survive conversion.
    assert.ok(!("description" in (properties.handover ?? {})));
    const readerSchema = zod.toJSONSchema(zod.object(shippedArgs(hooks, READ_TOOL_NAME)), { io: "input" });
    assert.deepEqual(Object.keys((readerSchema.properties as Record<string, unknown>)).sort(), ["sessionID"]);
  });
});

describe("writer authorization and storage", () => {
  it("rejects blank input, children, and unverifiable sessions without touching storage", async () => {
    const { hooks, dir } = await setupHarness();
    const tools = toolsOf(hooks);
    await assert.rejects(exec(tools, TOOL_NAME, { handover: "  ", summary: "s" }, { sessionID: "s1", agent: "main" }), /verbatim and non-empty/);
    await assert.rejects(exec(tools, TOOL_NAME, { handover: "h", summary: " " }, { sessionID: "s1", agent: "main" }), /non-empty/);
    await assert.rejects(exec(tools, TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "", agent: "main" }), /no session id/);
    await assert.rejects(exec(tools, TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "" }), /no agent identity/);
    assert.deepEqual(readdirSync(dir), []);

    const child = await setupHarness({ session: { kind: "child" } });
    await assert.rejects(
      exec(toolsOf(child.hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" }),
      /not a root session/,
    );

    const down = await setupHarness({ session: { kind: "throw" } });
    await assert.rejects(
      exec(toolsOf(down.hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" }),
      /unable to verify/,
    );

    const mismatch = await setupHarness({ session: { kind: "mismatch" } });
    await assert.rejects(
      exec(toolsOf(mismatch.hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" }),
      /unable to verify/,
    );
  });

  it("stores atomically with locked-down modes and lets the first writer win", async () => {
    const { hooks, dir } = await setupHarness({ serverOptions: { soft: 100 } });
    // Nudge first so the stored entry carries real pre-call diagnostics.
    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      {
        info: assistantMessage("a1", "s1", { input: 100, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    const tools = toolsOf(hooks);
    const [first, second] = await Promise.allSettled([
      exec(tools, TOOL_NAME, { handover: "handover one", summary: "done one" }, { sessionID: "s1", agent: "main" }),
      exec(tools, TOOL_NAME, { handover: "handover two", summary: "done two" }, { sessionID: "s1", agent: "main" }),
    ]);
    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String((rejected[0] as PromiseRejectedResult).reason), /already stored/);
    assert.match(String((fulfilled[0] as PromiseFulfilledResult<unknown>).value), /No automatic rollover/);

    const stored = JSON.parse(readFileSync(storedFile(dir, "s1"), "utf8")) as Record<string, unknown>;
    assert.ok(["handover one", "handover two"].includes(stored.handover as string));
    assert.equal(stored.sourceSessionId, "s1");
    assert.equal(stored.agentId, "main");
    assert.equal((stored.diag as Record<string, unknown>).stage, "warn1");
    assert.equal(statSync(storedFile(dir, "s1")).mode & 0o777, 0o600);
    assert.equal(statSync(storedDir(dir, "s1")).mode & 0o777, 0o700);
  });

  it("fails plainly when storage cannot be prepared", async () => {
    const dir = trackDir(mkdtempSync(join(tmpdir(), "kilo-ho-file-")));
    const filePath = join(dir, "not-a-dir");
    writeFileSync(filePath, "x");
    const state: FakeClientState = { sessionCalls: [], providerCalls: 0 };
    const input = {
      client: fakeClient({ kind: "root" }, catalogWith(100), state),
      project: { id: "p" },
      directory: "/w",
      worktree: "/w",
      experimental_workspace: { register: (): void => undefined },
      serverUrl: new URL("http://127.0.0.1:1412/"),
      $: {},
    } as unknown as PluginInput;
    const hooks = await descriptor.server(input, { dir: filePath, env: {}, now: () => 1 });
    await assert.rejects(
      exec(toolsOf(hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" }),
      /failed to prepare storage/,
    );
  });
});

describe("reader", () => {
  it("reports missing entries, replays verbatim text with framing, and warns past 50% seed", async () => {
    const { hooks } = await setupHarness({ serverOptions: { soft: 1000 } });
    const tools = toolsOf(hooks);
    assert.match(await exec(tools, READ_TOOL_NAME, { sessionID: "nobody" }, {}), /No handover stored/);
    await assert.rejects(exec(tools, READ_TOOL_NAME, { sessionID: " " }, {}), /non-empty string/);

    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      {
        info: assistantMessage("a1", "s1", { input: 1000, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await (hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    const big = `section body ${"x".repeat(3000)}`;
    await exec(tools, TOOL_NAME, { handover: big, summary: "s" }, { sessionID: "s1", agent: "main" });
    const replay = await exec(tools, READ_TOOL_NAME, { sessionID: "s1" }, {});
    assert.ok(replay.includes(big));
    assert.match(replay, /Handover from session s1 \(agent main/);
    assert.match(replay, /stage=warn1/);
    assert.match(replay, /Continue from 'Prioritized next steps'/);
    assert.match(replay, /over 50% of the soft threshold/);

    // A short handover from another session carries no seed warning, and any
    // equipped caller (even for a child id) may read any retained id.
    await exec(tools, TOOL_NAME, { handover: "tiny", summary: "s" }, { sessionID: "s2", agent: "kid" });
    const small = await exec(tools, READ_TOOL_NAME, { sessionID: "s2" }, {});
    assert.ok(!small.includes("over 50%"));
  });

  it("never overwrites corrupt or invalid entries", async () => {
    const { hooks, dir } = await setupHarness();
    const tools = toolsOf(hooks);
    await exec(tools, TOOL_NAME, { handover: "real handover", summary: "s" }, { sessionID: "s1", agent: "main" });
    const target = join(storedFile(dir, "s1"));
    const good = readFileSync(target, "utf8");
    writeFileSync(target, "{not json");
    await assert.rejects(exec(toolsOf(hooks), READ_TOOL_NAME, { sessionID: "s1" }, {}), /corrupt/);
    assert.equal(readFileSync(target, "utf8"), "{not json");
    writeFileSync(target, JSON.stringify({ handover: 42, summary: "s" }));
    await assert.rejects(exec(toolsOf(hooks), READ_TOOL_NAME, { sessionID: "s1" }, {}), /invalid/);
    writeFileSync(target, good);
    assert.ok((await exec(toolsOf(hooks), READ_TOOL_NAME, { sessionID: "s1" }, {})).includes("real handover"));
  });

  it("stores unknown diagnostics after a reload with no hook observations", async () => {
    const first = await setupHarness({ serverOptions: { soft: 100 } });
    const messages: Msg[] = [
      { info: userMessage("u1", "s1"), parts: [] },
      {
        info: assistantMessage("a1", "s1", { input: 100, output: 0, reasoning: 0, read: 0, write: 0 }),
        parts: [],
      },
    ];
    await (first.hooks["experimental.chat.messages.transform"] as unknown as TransformFn)({}, { messages });
    await exec(toolsOf(first.hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });

    // A fresh server() instance (host reload) has no in-memory diagnostics.
    const state: FakeClientState = { sessionCalls: [], providerCalls: 0 };
    const input = {
      client: fakeClient({ kind: "root" }, catalogWith(100), state),
      project: { id: "p" },
      directory: "/w",
      worktree: "/w",
      experimental_workspace: { register: (): void => undefined },
      serverUrl: new URL("http://127.0.0.1:1412/"),
      $: {},
    } as unknown as PluginInput;
    const reloaded = await descriptor.server(input, { dir: first.dir, env: {}, now: () => 1 });
    await exec(toolsOf(reloaded), TOOL_NAME, { handover: "h2", summary: "s2" }, { sessionID: "s9", agent: "main" });
    const replay = await exec(toolsOf(reloaded), READ_TOOL_NAME, { sessionID: "s9" }, {});
    assert.match(replay ?? "", /stage=unknown/);
  });
});

describe("session lifecycle", () => {
  it("clears in-memory state on session.deleted and dispose", async () => {
    const { hooks } = await setupHarness();
    const chat = hooks["chat.message"] as unknown as ChatMessageFn;
    const event = hooks["event"] as unknown as EventFn;
    const compacting = hooks["experimental.session.compacting"] as unknown as CompactingFn;
    const out = { message: hostUserMessage("msg_m1", "s1"), parts: [] as Part[] };
    await chat({ sessionID: "s1" }, out);
    assert.equal(out.parts.length, 1);
    await compacting({ sessionID: "s1" }, { context: [], prompt: undefined });
    await event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
    const out2 = { message: hostUserMessage("msg_m2", "s1"), parts: [] as Part[] };
    await chat({ sessionID: "s1" }, out2);
    assert.equal(out2.parts.length, 1);
    await event({ event: { type: "session.compacted", properties: { sessionID: "s1" } } });
    const out3 = { message: hostUserMessage("msg_m3", "s1"), parts: [] as Part[] };
    await chat({ sessionID: "s1" }, out3);
    assert.equal(out3.parts.length, 0);
    await hooks.dispose?.();
  });

  it("creates its storage dir on demand", async () => {
    const base = trackDir(mkdtempSync(join(tmpdir(), "kilo-ho-base-")));
    const nested = join(base, "sub", "store");
    const state: FakeClientState = { sessionCalls: [], providerCalls: 0 };
    const input = {
      client: fakeClient({ kind: "root" }, catalogWith(100), state),
      project: { id: "p" },
      directory: "/w",
      worktree: "/w",
      experimental_workspace: { register: (): void => undefined },
      serverUrl: new URL("http://127.0.0.1:1412/"),
      $: {},
    } as unknown as PluginInput;
    const hooks = await descriptor.server(input, { dir: nested, env: {}, now: () => 1 });
    await exec(toolsOf(hooks), TOOL_NAME, { handover: "h", summary: "s" }, { sessionID: "s1", agent: "main" });
    mkdirSync(nested, { recursive: true });
    assert.ok((await exec(toolsOf(hooks), READ_TOOL_NAME, { sessionID: "s1" }, {})).includes("h"));
  });
});
