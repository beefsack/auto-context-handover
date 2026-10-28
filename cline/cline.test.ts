// Cline adapter tests: fake typed plugin API, real fs under os.tmpdir.
// No live HOME mutation (storage dir is always injected), no network, no model.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPlugin } from "@cline/sdk";
import defaultPlugin, {
  createClineHandoverPlugin,
  parseClineSoftEnv,
  DEFAULT_SOFT,
  ENV_SOFT,
  PLUGIN_NAME,
  READ_TOOL_NAME,
  TOOL_NAME,
  type ClineHandoverSnapshot,
  type ClineHandoverTool,
  type ClineHandoverToolContext,
  type ClineModelRequest,
} from "./index.ts";
import { openCodeStageText, SEED_FRAMING } from "../source/shared/handover-text.ts";

type BeforeRunFn = (context: { readonly snapshot: ClineHandoverSnapshot }) =>
  | { readonly appendContext: string }
  | undefined;
type BeforeModelFn = (context: { readonly snapshot: ClineHandoverSnapshot; readonly request: ClineModelRequest }) =>
  | { readonly messages: readonly unknown[] }
  | undefined;

interface Harness {
  readonly dir: string;
  readonly plugin: AgentPlugin;
  readonly tools: Map<string, ClineHandoverTool>;
  readonly errors: string[];
  readonly logs: string[];
  readonly beforeRun: BeforeRunFn;
  readonly beforeModel: BeforeModelFn;
  readonly dispose: () => void;
}

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

function createFakeApi(target: Map<string, ClineHandoverTool>) {
  const noop = (..._args: Array<unknown>): undefined => undefined;
  return {
    registerTool: (tool: ClineHandoverTool): void => {
      target.set(tool.name, tool);
    },
    registerCommand: noop,
    registerRule: noop,
    registerMessageBuilder: noop,
    registerProvider: noop,
    registerAutomationEventType: noop,
    registerMcpServer: noop,
  };
}

function setupHarness(options: {
  readonly soft?: number;
  readonly env?: Record<string, string | undefined>;
  readonly bound?: string | null;
  readonly now?: () => number;
  readonly dirOverride?: string;
} = {}): Harness {
  const dir = options.dirOverride ?? trackDir(mkdtempSync(join(tmpdir(), "cline-ho-test-")));
  const errors: string[] = [];
  const logs: string[] = [];
  const logger = {
    debug(_message: string): void {},
    log(message: string): void {
      logs.push(message);
    },
    error(message: string): void {
      errors.push(message);
    },
  };
  const tools = new Map<string, ClineHandoverTool>();
  const api = createFakeApi(tools);
  const bound = options.bound === null ? undefined : (options.bound ?? "sess-source");
  const plugin = createClineHandoverPlugin({
    dir,
    soft: options.soft,
    env: options.env,
    sourceSessionId: bound,
    now: options.now,
  });
  const setup = plugin.setup;
  assert.ok(setup);
  let disposed: Array<() => void | Promise<void>> = [];
  setup(api, {
    session: bound === undefined ? undefined : { sessionId: bound },
    logger,
    onDispose: (cleanup: () => void | Promise<void>) => {
      disposed.push(cleanup);
    },
  });
  const hooks = plugin.hooks;
  assert.ok(hooks?.beforeRun);
  assert.ok(hooks?.beforeModel);
  return {
    dir,
    plugin,
    tools,
    errors,
    logs,
    beforeRun: hooks.beforeRun as unknown as BeforeRunFn,
    beforeModel: hooks.beforeModel as unknown as BeforeModelFn,
    dispose: () => {
      for (const cleanup of disposed) void cleanup();
      disposed = [];
    },
  };
}

const rootSnap = (overrides: Partial<ClineHandoverSnapshot> = {}): ClineHandoverSnapshot => ({
  agentId: "agent-root",
  parentAgentId: null,
  conversationId: "conv-1",
  runId: "run-1",
  iteration: 2,
  ...overrides,
});

const toolCtx = (
  snapshot: ClineHandoverSnapshot | undefined,
  overrides: Partial<ClineHandoverToolContext> = {},
): ClineHandoverToolContext => ({
  agentId: snapshot?.agentId ?? "agent-root",
  conversationId: "conv-1",
  runId: snapshot?.runId,
  iteration: 2,
  snapshot,
  ...overrides,
});

const req = (overrides: Partial<ClineModelRequest> = {}): ClineModelRequest => ({
  messages: [],
  tools: [],
  ...overrides,
});

const bigText = (chars: number): string => "x".repeat(chars);

/** Independent reimplementation of the documented heuristic for expectations. */
const heuristic = (request: ClineModelRequest): number =>
  Math.ceil(
    JSON.stringify({
      systemPrompt: request.systemPrompt,
      messages: request.messages,
      tools: request.tools,
      modelTools: request.modelTools,
    }).length / 4,
  );

const storedPath = (dir: string, sessionId: string): string =>
  join(dir, createHash("sha256").update(sessionId, "utf8").digest("hex"), "handover.json");

async function writeHandover(
  harness: Harness,
  handover: string,
  summary = "did the step, next do the other step",
  snapshot: ClineHandoverSnapshot | undefined = rootSnap(),
): Promise<string> {
  const tool = harness.tools.get(TOOL_NAME);
  assert.ok(tool);
  return callTool(tool, { handover, summary }, toolCtx(snapshot));
}

function callTool(tool: ClineHandoverTool, input: unknown, ctx: ClineHandoverToolContext): Promise<string> {
  return (async () => (await tool.execute(input, ctx)) as string)();
}

async function errorText(promise: Promise<string>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  assert.fail("expected the call to throw");
}

describe("cline plugin registration", () => {
  it("registers writer and reader tools with plain JSON schemas", () => {
    const harness = setupHarness();
    const writer = harness.tools.get(TOOL_NAME);
    const reader = harness.tools.get(READ_TOOL_NAME);
    assert.ok(writer);
    assert.ok(reader);
    for (const tool of [writer, reader]) {
      assert.equal(typeof tool.description, "string");
      assert.ok(tool.description.length > 0);
      // Plain JSON schema: must survive a JSON round-trip (no functions/refs).
      assert.deepEqual(JSON.parse(JSON.stringify(tool.inputSchema)), tool.inputSchema);
    }
    assert.deepEqual((writer.inputSchema as { required: string[] }).required, ["handover", "summary"]);
    assert.deepEqual((reader.inputSchema as { required: string[] }).required, ["sessionID"]);
  });

  it("exposes the advisory root-only plugin shape and a default instance", () => {
    const plugin = createClineHandoverPlugin({ dir: trackDir(mkdtempSync(join(tmpdir(), "cline-ho-shape-"))) });
    assert.equal(plugin.name, PLUGIN_NAME);
    assert.deepEqual(plugin.manifest.capabilities, ["tools", "hooks"]);
    assert.equal(defaultPlugin.name, PLUGIN_NAME);
    assert.deepEqual(defaultPlugin.manifest.capabilities, ["tools", "hooks"]);
  });
});

describe("parseClineSoftEnv", () => {
  it("defaults when unset and accepts positive integers", () => {
    assert.equal(parseClineSoftEnv(undefined).soft, DEFAULT_SOFT);
    assert.equal(DEFAULT_SOFT, 150000);
    assert.equal(parseClineSoftEnv("200000").soft, 200000);
    assert.equal(parseClineSoftEnv("  42 ").soft, 42);
  });

  it("rejects empty, non-numeric, percent, and non-positive values (integer-only)", () => {
    for (const raw of ["", "   ", "abc", "70%", "0", "-3", "1.5", "12px"]) {
      const parsed = parseClineSoftEnv(raw);
      assert.equal(parsed.soft, undefined);
      assert.ok(parsed.error?.includes(ENV_SOFT), raw);
    }
  });
});

describe("intro and root-only hooks", () => {
  it("beforeRun returns the intro for roots and stays silent for children", () => {
    const harness = setupHarness();
    const intro = harness.beforeRun({ snapshot: rootSnap() });
    assert.ok(intro?.appendContext.includes(TOOL_NAME));
    assert.ok(intro?.appendContext.includes(READ_TOOL_NAME));
    assert.ok(intro?.appendContext.toLowerCase().includes("manual"));
    assert.equal(harness.beforeRun({ snapshot: rootSnap({ parentAgentId: "agent-root" }) }), undefined);
  });

  it("beforeModel stays silent for children", () => {
    const harness = setupHarness({ soft: 10 });
    const request = req({ messages: [{ role: "user", content: [{ type: "text", text: bigText(5000) }] }] });
    assert.equal(
      harness.beforeModel({ snapshot: rootSnap({ parentAgentId: "agent-root" }), request }),
      undefined,
    );
  });
});

describe("estimator and advisories", () => {
  it("stays silent below soft and warns at soft, 1.1x, 1.2x with stable text", () => {
    const harness = setupHarness({ soft: 1000 });
    assert.equal(harness.beforeModel({ snapshot: rootSnap(), request: req() }), undefined);
    const at = (chars: number): ClineModelRequest =>
      req({ messages: [{ role: "user", content: [{ type: "text", text: bigText(chars) }] }] });
    // Find payloads landing in each stage via the documented heuristic.
    const cases: Array<{ readonly chars: number; readonly lead: string }> = [];
    for (const chars of [3900, 4100, 4400, 4700, 5000]) {
      const estimate = heuristic(at(chars));
      const lead = estimate >= 1200 ? "warn3" : estimate >= 1100 ? "warn2" : estimate >= 1000 ? "warn1" : "ok";
      cases.push({ chars, lead });
    }
    assert.ok(cases.some((c) => c.lead === "warn1"));
    assert.ok(cases.some((c) => c.lead === "warn2"));
    assert.ok(cases.some((c) => c.lead === "warn3"));
    for (const { chars, lead } of cases) {
      if (lead === "ok") continue;
      const first = harness.beforeModel({ snapshot: rootSnap(), request: at(chars) });
      const second = harness.beforeModel({ snapshot: rootSnap(), request: at(chars) });
      assert.ok(first && second);
      assert.equal(first.messages.length, 1 + 1);
      assert.equal(second.messages.length, 1 + 1);
      const firstNotice = (first.messages[1] as { content: Array<{ text: string }> }).content[0]?.text;
      const secondNotice = (second.messages[1] as { content: Array<{ text: string }> }).content[0]?.text;
      assert.equal(firstNotice, secondNotice);
      assert.ok(firstNotice?.startsWith(openCodeStageText(lead as "warn1" | "warn2" | "warn3")));
      assert.ok(firstNotice?.includes("heuristic"));
    }
  });

  it("covers systemPrompt/tools/modelTools, excludes options/signal, never mutates input", () => {
    const harness = setupHarness({ soft: 100 });
    const via = (request: ClineModelRequest) =>
      harness.beforeModel({ snapshot: rootSnap(), request });
    assert.ok(via(req({ systemPrompt: bigText(2000) })));
    assert.ok(via(req({ tools: [{ name: "t", blob: bigText(2000) }] })));
    assert.ok(via(req({ modelTools: [{ name: "m", blob: bigText(2000) }] })));
    // A huge options/signal payload must not move the estimate.
    const ignored = req({ options: undefined, signal: undefined } as unknown as Partial<ClineModelRequest>);
    (ignored as unknown as Record<string, unknown>).options = { blob: bigText(20000) };
    (ignored as unknown as Record<string, unknown>).signal = { blob: bigText(20000) };
    assert.equal(via(ignored), undefined);

    const frozen = req({ messages: [{ role: "user", content: [{ type: "text", text: bigText(5000) }] }] });
    const before = JSON.stringify(frozen);
    Object.freeze(frozen.messages);
    const result = via(frozen);
    assert.ok(result);
    assert.equal(JSON.stringify(frozen), before);
    assert.equal(frozen.messages.length, 1);
    assert.equal(result.messages.length, 2);
  });

  it("fails open to unknown on unserializable requests", () => {
    const harness = setupHarness({ soft: 10 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(
      harness.beforeModel({ snapshot: rootSnap(), request: req({ messages: [circular] }) }),
      undefined,
    );
  });

  it("invalid or empty env disables advisories with setup logging but keeps tools working", async () => {
    for (const raw of ["bogus", ""]) {
      const harness = setupHarness({ env: { [ENV_SOFT]: raw } });
      assert.equal(harness.errors.length, 1);
      assert.ok(harness.errors[0]?.includes(ENV_SOFT));
      assert.ok(harness.errors[0]?.includes("disabled"));
      assert.ok(harness.errors[0]?.includes("still work"));
      const huge = req({ messages: [{ role: "user", content: [{ type: "text", text: bigText(20000) }] }] });
      assert.equal(harness.beforeModel({ snapshot: rootSnap(), request: huge }), undefined);
      harness.beforeRun({ snapshot: rootSnap() });
      const confirmation = await writeHandover(harness, "full handover text verbatim");
      assert.ok(confirmation.includes("Handover stored"));
      const reader = harness.tools.get(READ_TOOL_NAME);
      assert.ok(reader);
      const text = (await reader.execute({ sessionID: "sess-source" }, toolCtx(rootSnap()))) as string;
      assert.ok(text.includes("full handover text verbatim"));
      assert.ok(text.includes("reason=unknown"));
    }
  });

  it("treats a provided env object as authoritative, never falling back to process.env", () => {
    const saved = process.env[ENV_SOFT];
    process.env[ENV_SOFT] = "bogus";
    try {
      const harness = setupHarness({ env: {} });
      assert.equal(harness.errors.length, 0);
      const huge = req({ messages: [{ role: "user", content: [{ type: "text", text: bigText(700000) }] }] });
      assert.ok(harness.beforeModel({ snapshot: rootSnap(), request: huge }));
    } finally {
      if (saved === undefined) delete process.env[ENV_SOFT];
      else process.env[ENV_SOFT] = saved;
    }
  });
});

describe("writer authorization and binding", () => {
  it("denies child snapshots, unattributed calls, identity mismatch, and empty text", async () => {
    const harness = setupHarness();
    await assert.rejects(writeHandover(harness, "text", "summary", rootSnap({ parentAgentId: "agent-root" })), /root-session snapshot/);
    const unattributed = harness.tools.get(TOOL_NAME);
    assert.ok(unattributed);
    await assert.rejects(
      callTool(unattributed, { handover: "text", summary: "summary" }, toolCtx(undefined)),
      /root-session snapshot/,
    );
    harness.beforeRun({ snapshot: rootSnap() });
    const snapshot = rootSnap();
    const tool = harness.tools.get(TOOL_NAME);
    assert.ok(tool);
    await assert.rejects(
      callTool(tool, { handover: "text", summary: "summary" }, toolCtx(snapshot, { agentId: "someone-else" })),
      /does not match/,
    );
    await assert.rejects(writeHandover(harness, "   "), /non-empty/);
    await assert.rejects(writeHandover(harness, "text", "   "), /non-empty/);
  });

  it("denies writes with no observed root run and resets stale runs on beforeRun", async () => {
    const harness = setupHarness();
    await assert.rejects(writeHandover(harness, "text"), /no observed root run/);
    harness.beforeRun({ snapshot: rootSnap({ runId: "run-1" }) });
    harness.beforeRun({ snapshot: rootSnap({ runId: "run-2" }) });
    await assert.rejects(
      writeHandover(harness, "text", "summary", rootSnap({ runId: "run-1" })),
      /no observed root run/,
    );
    const confirmation = await writeHandover(harness, "text", "summary", rootSnap({ runId: "run-2" }));
    assert.ok(confirmation.includes("sess-source"));
  });

  it("denies writes without a stable setup session binding", async () => {
    const harness = setupHarness({ bound: null });
    harness.beforeRun({ snapshot: rootSnap() });
    await assert.rejects(writeHandover(harness, "text"), /no stable setup session id/);
  });

  it("refuses a second setup on the same instance and keeps the original binding", async () => {
    const harness = setupHarness();
    harness.beforeRun({ snapshot: rootSnap() });
    const setup = harness.plugin.setup;
    assert.ok(setup);
    const otherTools = new Map<string, ClineHandoverTool>();
    assert.throws(
      () => setup(createFakeApi(otherTools), { session: { sessionId: "sess-B" } }),
      /already set up.*sess-source/,
    );
    assert.equal(otherTools.size, 0);
    const confirmation = await writeHandover(harness, "still A body");
    assert.ok(confirmation.includes("sess-source"));
    const reader = harness.tools.get(READ_TOOL_NAME);
    assert.ok(reader);
    const text = await callTool(reader, { sessionID: "sess-source" }, toolCtx(rootSnap()));
    assert.ok(text.includes("still A body"));
    assert.equal(
      await callTool(reader, { sessionID: "sess-B" }, toolCtx(rootSnap())),
      `No handover stored for session "sess-B" yet.`,
    );
  });

  it("stores handover+summary verbatim with nudged diagnostics and manual-only guidance", async () => {
    const fixedNow = 1700000000000;
    const harness = setupHarness({ soft: 100, now: () => fixedNow });
    const snapshot = rootSnap();
    harness.beforeRun({ snapshot });
    const request = req({ messages: [{ role: "user", content: [{ type: "text", text: bigText(5000) }] }] });
    assert.ok(harness.beforeModel({ snapshot, request }));
    const handover = "  verbatim  text\nwith whitespace  ";
    const confirmation = await writeHandover(harness, handover);
    assert.ok(confirmation.includes("sess-source"));
    assert.ok(confirmation.includes("manual"));
    assert.ok(confirmation.includes("No automatic rollover"));
    assert.ok(confirmation.includes("reason=nudged"));
    const raw = readFileSync(storedPath(harness.dir, "sess-source"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed.handover, handover);
    assert.equal(parsed.sourceSessionId, "sess-source");
    assert.equal(parsed.agentId, "agent-root");
    assert.equal(parsed.storedAt, fixedNow);
    assert.equal((parsed.diag as { reason: string }).reason, "nudged");
  });

  it("rejects duplicates preserving the original and lets the first concurrent writer win", async () => {
    const harness = setupHarness();
    harness.beforeRun({ snapshot: rootSnap() });
    await writeHandover(harness, "original handover");
    const before = readFileSync(storedPath(harness.dir, "sess-source"), "utf8");
    await assert.rejects(writeHandover(harness, "replacement handover"), /already stored.*preserved/);
    assert.equal(readFileSync(storedPath(harness.dir, "sess-source"), "utf8"), before);

    const dir = trackDir(mkdtempSync(join(tmpdir(), "cline-ho-race-")));
    const left = setupHarness({ dirOverride: dir, bound: "sess-race" });
    const right = setupHarness({ dirOverride: dir, bound: "sess-race" });
    left.beforeRun({ snapshot: rootSnap() });
    right.beforeRun({ snapshot: rootSnap() });
    const leftTool = left.tools.get(TOOL_NAME);
    const rightTool = right.tools.get(TOOL_NAME);
    assert.ok(leftTool);
    assert.ok(rightTool);
    const pairs = Array.from({ length: 8 }, (_, index) => ({
      handover: `racer ${index} body`,
      summary: `racer ${index} summary`,
      tool: index % 2 === 0 ? leftTool : rightTool,
    }));
    const outcomes = await Promise.allSettled(
      pairs.map((pair) =>
        callTool(pair.tool, { handover: pair.handover, summary: pair.summary }, toolCtx(rootSnap())),
      ),
    );
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") assert.match(String(outcome.reason), /already stored/);
    }
    // The winner's body and summary stay a coherent pair: no torn writes.
    const winner = JSON.parse(readFileSync(storedPath(dir, "sess-race"), "utf8")) as {
      handover: string;
      summary: string;
    };
    assert.ok(pairs.some((pair) => pair.handover === winner.handover && pair.summary === winner.summary));
  });

  it("uses private modes and refuses to claim success on persistence failure", async () => {
    const harness = setupHarness();
    harness.beforeRun({ snapshot: rootSnap() });
    await writeHandover(harness, "text");
    assert.equal((statSync(storedPath(harness.dir, "sess-source")).mode & 0o777).toString(8), "600");
    const dirStat = statSync(join(harness.dir, createHash("sha256").update("sess-source", "utf8").digest("hex")));
    assert.equal(((dirStat.mode & 0o777) >>> 0).toString(8), "700");

    const broken = setupHarness();
    broken.beforeRun({ snapshot: rootSnap() });
    // Point storage at a file so directory creation fails: no success claims.
    const fileAsDir = join(broken.dir, "file-as-dir");
    writeFileSync(fileAsDir, "x");
    const unusable = setupHarness({ dirOverride: fileAsDir });
    unusable.beforeRun({ snapshot: rootSnap() });
    const writer = unusable.tools.get(TOOL_NAME);
    assert.ok(writer);
    await assert.rejects(
      callTool(writer, { handover: "text", summary: "summary" }, toolCtx(rootSnap())),
      /nothing was handed over/,
    );
  });

  it("clears transient memory on dispose", async () => {
    const harness = setupHarness();
    harness.beforeRun({ snapshot: rootSnap() });
    harness.dispose();
    await assert.rejects(writeHandover(harness, "text"), /no observed root run/);
  });
});

describe("reader", () => {
  it("returns the full text once with metadata, diagnostics, seed framing, and manual guidance", async () => {
    const harness = setupHarness({ soft: 100 });
    harness.beforeRun({ snapshot: rootSnap() });
    await writeHandover(harness, "the full handover body");
    const reader = harness.tools.get(READ_TOOL_NAME);
    assert.ok(reader);
    const text = (await reader.execute({ sessionID: "sess-source" }, toolCtx(rootSnap()))) as string;
    assert.ok(text.includes("Handover from session sess-source (agent agent-root"));
    assert.ok(text.includes("Diagnostics: reason="));
    assert.ok(text.includes("the full handover body"));
    assert.ok(text.includes(SEED_FRAMING));
    assert.ok(text.includes('read_handover with sessionID "sess-source"'));
    assert.ok(text.includes("Nothing rolls over"));
    assert.ok(!text.includes("undefined"));
  });

  it("reads any retained source session id but reports plain absence otherwise", async () => {
    const harness = setupHarness();
    harness.beforeRun({ snapshot: rootSnap() });
    await writeHandover(harness, "source body");
    const reader = harness.tools.get(READ_TOOL_NAME);
    assert.ok(reader);
    const cross = (await reader.execute({ sessionID: "sess-source" }, toolCtx(rootSnap({ agentId: "other" })))) as string;
    assert.ok(cross.includes("source body"));
    assert.equal(
      (await reader.execute({ sessionID: "sess-other" }, toolCtx(rootSnap()))) as string,
      `No handover stored for session "sess-other" yet.`,
    );
    await assert.rejects(callTool(reader, {}, toolCtx(rootSnap())), /"sessionID"/);
    // Path-looking input is hashed, never traversed: plain absence, fulfilled.
    assert.equal(
      (await callTool(reader, { sessionID: "../../etc" }, toolCtx(rootSnap()))) as string,
      `No handover stored for session "../../etc" yet.`,
    );
  });

  it("fails loudly on corrupt, invalid, or unreadable entries", async () => {
    const harness = setupHarness();
    harness.beforeRun({ snapshot: rootSnap() });
    await writeHandover(harness, "good body");
    const reader = harness.tools.get(READ_TOOL_NAME);
    assert.ok(reader);
    const read = (): Promise<string> => callTool(reader, { sessionID: "sess-source" }, toolCtx(rootSnap()));
    const target = storedPath(harness.dir, "sess-source");
    writeFileSync(target, "{not json");
    const corrupt = await errorText(read());
    assert.match(corrupt, /corrupt/);
    assert.ok(corrupt.includes("immutable"));
    assert.ok(!corrupt.includes("Store a fresh handover with the context_handover tool"));
    writeFileSync(target, JSON.stringify({ handover: 42 }));
    const invalid = await errorText(read());
    assert.match(invalid, /invalid/);
    assert.ok(invalid.includes("immutable"));
    assert.ok(!invalid.includes("Store a fresh handover with the context_handover tool"));
  });

  it("warns exactly above half the soft threshold on the stored handover alone", async () => {
    // soft=100: the boundary is 50 tokens. A 200-char handover estimates
    // exactly 50 (no warning) while 201 chars estimates 51 (warning), even
    // though the full reader reply is far longer in both cases.
    const dir = trackDir(mkdtempSync(join(tmpdir(), "cline-ho-seed-")));
    const exact = setupHarness({ soft: 100, dirOverride: dir, bound: "sess-exact" });
    exact.beforeRun({ snapshot: rootSnap() });
    await writeHandover(exact, bigText(200));
    const exactReader = exact.tools.get(READ_TOOL_NAME);
    assert.ok(exactReader);
    const plain = await callTool(exactReader, { sessionID: "sess-exact" }, toolCtx(rootSnap()));
    // The full reply estimates well over half the threshold, but only the
    // stored handover counts: no warning.
    assert.ok(Math.ceil(plain.length / 4) > 50);
    assert.ok(!plain.includes("over 50%"));

    const over = setupHarness({ soft: 100, dirOverride: dir, bound: "sess-over" });
    over.beforeRun({ snapshot: rootSnap() });
    await writeHandover(over, bigText(201));
    const overReader = over.tools.get(READ_TOOL_NAME);
    assert.ok(overReader);
    const warned = await callTool(overReader, { sessionID: "sess-over" }, toolCtx(rootSnap()));
    assert.ok(warned.includes("the stored handover text alone is over 50%"));
    assert.ok(warned.includes("compress carried-over completed notes"));

    const small = setupHarness({ soft: 100000 });
    small.beforeRun({ snapshot: rootSnap() });
    await writeHandover(small, "tiny");
    const smallReader = small.tools.get(READ_TOOL_NAME);
    assert.ok(smallReader);
    const tiny = (await smallReader.execute({ sessionID: "sess-source" }, toolCtx(rootSnap()))) as string;
    assert.ok(!tiny.includes("over 50%"));
  });

  it("reports unknown diagnostics when the write followed no model observation", async () => {
    const harness = setupHarness();
    harness.beforeRun({ snapshot: rootSnap() });
    await writeHandover(harness, "body without estimate");
    const reader = harness.tools.get(READ_TOOL_NAME);
    assert.ok(reader);
    const text = (await reader.execute({ sessionID: "sess-source" }, toolCtx(rootSnap()))) as string;
    assert.ok(text.includes("reason=unknown"));
    assert.ok(text.includes("estimated-context-tokens=unknown"));
  });

  it("reads back across factory reloads with per-session isolation", async () => {
    const dir = trackDir(mkdtempSync(join(tmpdir(), "cline-ho-reload-")));
    const first = setupHarness({ soft: 100, dirOverride: dir, bound: "sess-one" });
    first.beforeRun({ snapshot: rootSnap() });
    const request = req({ messages: [{ role: "user", content: [{ type: "text", text: bigText(5000) }] }] });
    assert.ok(first.beforeModel({ snapshot: rootSnap(), request }));
    await writeHandover(first, "one body");
    // A new factory instance over the same directory replays the earlier entry.
    const second = setupHarness({ soft: 100, dirOverride: dir, bound: "sess-two" });
    const reader = second.tools.get(READ_TOOL_NAME);
    assert.ok(reader);
    const reloaded = await callTool(reader, { sessionID: "sess-one" }, toolCtx(rootSnap()));
    assert.ok(reloaded.includes("one body"));
    assert.ok(reloaded.includes("reason=nudged"));
    // The new instance starts unobserved: its own write carries unknown diagnostics.
    second.beforeRun({ snapshot: rootSnap() });
    await writeHandover(second, "two body");
    const own = await callTool(reader, { sessionID: "sess-two" }, toolCtx(rootSnap()));
    assert.ok(own.includes("two body"));
    assert.ok(own.includes("reason=unknown"));
  });
});
