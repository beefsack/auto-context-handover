// Credit-free Node fixtures: drive the actually exported register() wiring
// with a fake $/on harness. No models, no network, no filesystem.
import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import type { AgentInfo, CatchNext, ClassicSubagentStopResult, Engine, On, PlainCatchHook, ToolCallResult } from "./claude-types.ts"
import { register, reclaimForWrite, resolveChainOf } from "./register.ts"
import {
  activityKey,
  buildChildShortReply,
  buildChildTombstone,
  buildClaudeChildIntro,
  buildClaudeChildNudge,
  buildClaudeRootIntro,
  buildClaudeSuccessorSeed,
  buildExpiredReadback,
  buildGenerationLine,
  buildHandoverStoredInstruction,
  buildLockedChildReply,
  buildProvenanceReadback,
  buildSuccessorMarker,
  buildSuccessorPointer,
  CHILD_HANDOVER_DESCRIPTION,
  CHILD_READ_DESCRIPTION,
  CHILD_SUMMARY_PREFIX,
  classifyChain,
  classifySuccessorMarker,
  countNextSteps,
  estimateSeedTokens,
  estimateStoreBytes,
  formatHandbackDelivered,
  groupChains,
  HANDOVER_FULL,
  isChainPin,
  isChildTombstone,
  isSeedTooLarge,
  mergeProvenance,
  orderEvictableChains,
  originalRecordKey,
  parseSuccessorMarker,
  pinKey,
  READ_BEFORE_DECISION,
  READ_FULL,
  shortReplyOf,
  spawnRecordKey,
  childRecordKey,
  STORE_BUDGET_BYTES,
  SUCCESSOR_MARKER_TAG,
  utf8ByteLength,
  type ChildRecord,
  type ChildTombstone,
  type OriginalRecord,
  type SpawnProvenance,
} from "./child.ts"
import { HANDOVER_SECTIONS } from "../source/shared/handover-text.ts"
import { HANDOVER_DESCRIPTION } from "../source/text.ts"
import { SEED_FRAMING } from "../source/shared/handover-text.ts"
import { seedTooLarge } from "../source/measure.ts"
import { seedTooLarge as sharedSeedTooLarge } from "../source/shared/seed-size.ts"

type HookFn = (...args: never[]) => unknown

interface Fake {
  handlers: Map<string, HookFn[]>
  catches: Map<string, PlainCatchHook<Record<string, unknown>, unknown>>
  tools: Map<string, { description: unknown; inputSchema: unknown }>
  store: Map<string, unknown>
  readFailKeys: Set<string>
  writeFailKeys: Set<string>
  deleteFailKeys: Set<string>
  agents: AgentInfo[]
  listFails: boolean
  keysFails: boolean
  sessionID: string
  sessionsFails: boolean
  $: Engine
}

const makeFake = (options?: { soft?: unknown }): Fake & { registerOptions: { soft?: unknown } } => {
  const handlers = new Map<string, HookFn[]>()
  const tools = new Map<string, { description: unknown; inputSchema: unknown }>()
  const store = new Map<string, unknown>()
  const readFailKeys = new Set<string>()
  const writeFailKeys = new Set<string>()
  const deleteFailKeys = new Set<string>()
  const fake = {
    handlers,
    catches: new Map<string, PlainCatchHook<Record<string, unknown>, unknown>>(),
    tools,
    store,
    readFailKeys,
    writeFailKeys,
    deleteFailKeys,
    agents: [] as AgentInfo[],
    listFails: false,
    keysFails: false,
    sessionID: "ses_host",
    sessionsFails: false,
    registerOptions: options ?? {},
  } as Fake & { registerOptions: { soft?: unknown } }
  const engine = {
    tool: {
      register: async (tool: { name: string; description: string; inputSchema?: Record<string, unknown> }) => {
        tools.set(`mcp__auto-context-handover__${tool.name}`, {
          description: tool.description,
          inputSchema: tool.inputSchema,
        })
        return { tool: `mcp__auto-context-handover__${tool.name}` }
      },
    },
    store: {
      get: async (key: string) => {
        if (readFailKeys.has(key)) throw new Error(`injected store read failure for ${key}`)
        return store.get(key)
      },
      set: async (key: string, value: unknown) => {
        if (writeFailKeys.has(key)) throw new Error(`injected store write failure for ${key}`)
        store.set(key, value)
      },
      delete: async (key: string) => {
        if (deleteFailKeys.has(key)) throw new Error(`injected store delete failure for ${key}`)
        store.delete(key)
      },
      keys: async () => {
        if (fake.keysFails) throw new Error("injected store keys failure")
        return [...store.keys()]
      },
    },
    agent: {
      list: async () => {
        if (fake.listFails) throw new Error("agent list down")
        return fake.agents
      },
    },
    session: {
      id: async () => {
        if (fake.sessionsFails) throw new Error("session id down")
        return fake.sessionID
      },
    },
  } as unknown as Engine
  fake.$ = engine
  return fake
}

const setup = (fake: Fake & { registerOptions: { soft?: unknown } }): void => {
  const on = ((event: string, ...rest: unknown[]) => {
    const list = fake.handlers.get(event) ?? []
    list.push(rest[rest.length - 1] as HookFn)
    fake.handlers.set(event, list)
    return {
      catch: (handler: PlainCatchHook<Record<string, unknown>, unknown>) => {
        assert.ok(!fake.catches.has(event), `duplicate ${event} catch`)
        fake.catches.set(event, handler)
      },
    }
  }) as On
  register(on, fake.registerOptions)
}

const only = (fake: Fake, event: string): HookFn => {
  const list = fake.handlers.get(event) ?? []
  assert.equal(list.length, 1, `expected one ${event} hook`)
  return list[0] as HookFn
}

const nextPassthrough = async (event: unknown): Promise<unknown> => event

interface StepResult {
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string } | null
}

const runStep = async (
  fake: Fake,
  event: Record<string, unknown>,
  usage: StepResult["usage"],
): Promise<StepResult> => {
  const hook = only(fake, "turn.step") as unknown as (
    $: Engine,
    event: Record<string, unknown>,
    next: (event: Record<string, unknown>) => AsyncGenerator<unknown, StepResult, StepResult | undefined>,
  ) => AsyncGenerator<unknown, StepResult, StepResult | undefined>
  async function* fakeNext(): AsyncGenerator<unknown, StepResult, StepResult | undefined> {
    yield { kind: "text", text: "chunk" }
    return { usage }
  }
  const stream = hook(fake.$, event, fakeNext as never)
  let value: StepResult | undefined
  for (;;) {
    const item = await stream.next()
    if (item.done === true) {
      value = item.value as StepResult
      break
    }
  }
  assert.ok(value)
  return value
}

const batch = async (
  fake: Fake,
  event: Record<string, unknown>,
  prior: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
  const hook = only(fake, "classic.PostToolBatch") as unknown as (
    $: Engine,
    event: Record<string, unknown>,
    next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>
  return hook(fake.$, event, async () => ({ ...prior }))
}

type CallOutcome = { deny?: string; result?: unknown; isError?: boolean }

const toolCall = async (
  fake: Fake,
  event: Record<string, unknown>,
  next?: (event: Record<string, unknown>) => Promise<ToolCallResult>,
): Promise<CallOutcome> => {
  const hook = only(fake, "tool.call") as unknown as (
    $: Engine,
    event: Record<string, unknown>,
    next: (event: Record<string, unknown>) => Promise<ToolCallResult>,
  ) => Promise<ToolCallResult>
  const respond = next ?? (async (input) => ({ result: `passed:${String((input as Record<string, unknown>).tool)}` }))
  return (await hook(fake.$, event, respond as never)) as CallOutcome
}

const stopHook = async (
  fake: Fake,
  event: Record<string, unknown>,
  next?: (event: Record<string, unknown>) => Promise<ClassicSubagentStopResult>,
): Promise<ClassicSubagentStopResult> => {
  const hook = only(fake, "classic.SubagentStop") as unknown as (
    $: Engine,
    event: Record<string, unknown>,
    next: (event: Record<string, unknown>) => Promise<ClassicSubagentStopResult>,
  ) => Promise<ClassicSubagentStopResult>
  const respond = next ?? (async (input) => input as ClassicSubagentStopResult)
  return hook(fake.$, event, respond as never)
}

const childAgents = (id: string): AgentInfo[] => [{ id, type: "general-purpose", status: "running" }]

const handOver = async (fake: Fake, agentId: string, text: string): Promise<CallOutcome> => {
  fake.agents = childAgents(agentId)
  return toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId, handover: text, summary: "did work" })
}

// Model only the documented catch contract: once called, next replays the
// settled outcome, including a rewritten event, without downstream effects.
const runCatch = async (
  fake: Fake,
  name: string,
  event: Record<string, unknown>,
  kind: CatchNext<unknown, unknown>["error"]["kind"],
  prior: unknown,
  alreadyCalledWith?: Record<string, unknown>,
): Promise<{ result: unknown; seen: Record<string, unknown>[] }> => {
  const handler = fake.catches.get(name)
  assert.ok(handler, `missing ${name} catch`)
  const seen: Record<string, unknown>[] = []
  const downstream = async (input: Record<string, unknown>): Promise<unknown> => {
    seen.push(input)
    return prior
  }
  let settled = alreadyCalledWith === undefined ? undefined : downstream(alreadyCalledWith)
  if (settled) await settled
  const next = Object.assign(
    (input: Record<string, unknown>) => settled ??= downstream(input),
    { called: alreadyCalledWith !== undefined, error: { kind } },
  )
  const noHostCalls = new Proxy(fake.$, {
    get: () => { throw new Error("catch handlers must not access the host") },
  })
  return { result: await handler(noHostCalls, event, next), seen }
}

describe("hook catch policies", () => {
  it("attaches catches to all plain hooks, not the streaming usage observer", () => {
    const fake = makeFake()
    setup(fake)
    assert.deepEqual([...fake.catches.keys()].sort(), [
      "agent.spawn", "classic.PostToolBatch", "classic.SessionStart", "classic.SubagentStart", "classic.SubagentStop", "session.end", "session.start", "tool.call", "turn.complete",
    ])
  })

  for (const kind of ["throw", "timeout", "re-entry"] as const) {
    for (const name of ["session.start", "classic.PostToolBatch", "classic.SessionStart", "classic.SubagentStart", "classic.SubagentStop", "agent.spawn"]) {
      it(`${name} fails open on ${kind} and replays an already-called next`, async () => {
        const fake = makeFake()
        setup(fake)
        const event = { agent_id: "a1", stop_hook_active: true }
        const prior = { block: "other hook", preventContinuation: true, additionalContext: ["kept"] }
        for (const calledWith of [undefined, event]) {
          const { result, seen } = await runCatch(fake, name, event, kind, prior, calledWith)
          assert.equal(result, prior)
          assert.deepEqual(seen, [event])
        }
      })
    }

    it(`tool.call refuses pre-dispatch ${kind} for loop-scoped and adapter calls only`, async () => {
      const fake = makeFake()
      setup(fake)
      await handOver(fake, "a1", "accepted verbatim")
      const stored = fake.store.get("child:a1")
      for (const event of [
        { tool: "Bash", agentId: "a1" },
        { tool: "Bash", agentId: "open-child" },
        { tool: "Bash", agentId: "unknown-or-teammate" },
        { tool: "SubagentHandback", agentId: "a1", message: "full report" },
        { tool: HANDOVER_FULL, agentId: "a1", handover: "do not overwrite" },
        { tool: HANDOVER_FULL },
        { tool: READ_FULL, childId: "a1" },
      ]) {
        const { result, seen } = await runCatch(fake, "tool.call", event, kind, { result: "must not run" })
        assert.match(String((result as CallOutcome).deny), new RegExp(`before dispatch \\(${kind}\\)`))
        assert.deepEqual(seen, [])
        assert.equal(fake.store.get("child:a1"), stored)
      }
      for (const event of [{ tool: "Bash" }, { tool: "Read", agentId: "" }]) {
        const prior = { result: "root unaffected" }
        const { result, seen } = await runCatch(fake, "tool.call", event, kind, prior)
        assert.equal(result, prior)
        assert.deepEqual(seen, [event])
      }
    })

    it(`tool.call preserves prior results after ${kind}, never rerunning native handback`, async () => {
      const fake = makeFake()
      setup(fake)
      await handOver(fake, "a1", "accepted verbatim")
      const stored = fake.store.get("child:a1") as ChildRecord
      const event = { tool: "SubagentHandback", agentId: "a1", message: "original report" }
      const rewritten = { ...event, message: shortReplyOf(stored) }
      for (const prior of [{ result: "native success" }, { deny: "classifier refusal" }, { result: "native failure", isError: true }]) {
        const { result, seen } = await runCatch(fake, "tool.call", event, kind, prior, rewritten)
        assert.equal(result, prior)
        assert.deepEqual(seen, [rewritten])
      }
    })
  }

  it("handles a real uncaught handover error without persistence or downstream dispatch", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const event = { tool: HANDOVER_FULL, agentId: "a1", handover: "body", summary: "summary" }
    const clock = mock.method(Date, "now", () => { throw new Error("injected clock failure") })
    try {
      await assert.rejects(toolCall(fake, event), /injected clock failure/)
      const { result, seen } = await runCatch(fake, "tool.call", event, "throw", { result: "must not run" })
      assert.match(String((result as CallOutcome).deny), /this call was not run/)
      assert.deepEqual(seen, [])
      assert.equal(fake.store.get("child:a1"), undefined)
    } finally {
      clock.mock.restore()
    }
    // The original hook's finally also released its in-flight latch.
    assert.match(String((await toolCall(fake, event)).result), /summary/)
  })
})

describe("claude child adapter registration", () => {
  it("registers both tools in session.start with MCP full names and schemas", async () => {
    const fake = makeFake()
    setup(fake)
    const start = only(fake, "session.start") as unknown as (
      $: Engine,
      event: unknown,
      next: (event: unknown) => Promise<unknown>,
    ) => Promise<unknown>
    const event = { phase: "start" }
    assert.equal(await start(fake.$, event, nextPassthrough), event)
    assert.ok(fake.tools.has(HANDOVER_FULL))
    assert.ok(fake.tools.has(READ_FULL))
    const handover = fake.tools.get(HANDOVER_FULL)
    assert.ok(typeof handover?.description === "string" && handover.description.includes("subagent"))
    assert.ok(!handover?.description.includes("primary root"))
    assert.ok(!handover?.description.includes("onHandover"))
    assert.ok(!handover?.description.includes("sessionID"))
    const schema = handover?.inputSchema as { required?: string[] }
    assert.deepEqual(schema.required, ["handover", "summary"])
    const read = fake.tools.get(READ_FULL)
    assert.deepEqual((read?.inputSchema as { required?: string[] }).required, ["childId"])
    assert.ok(String(read?.description).includes("childId"))
  })

  it("shares the six-section handover text exact, with no OpenCode policy", async () => {
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes(HANDOVER_SECTIONS))
    for (const banned of ["primary root", "onHandover", "sessionID", "locked session", "lock mode", "new-session"]) {
      assert.ok(!CHILD_HANDOVER_DESCRIPTION.includes(banned), `child description must not include ${banned}`)
    }
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes("Context handover (incomplete):"))
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes("rollover, not task completion"))
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes("normally continues in a successor"))
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes("same agent type"))
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes("short successor prompt VERBATIM"))
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes("preserve verification distinctions"))
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes("Prioritized next steps"))
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes("reference only"))
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes("never turn context size"))
    assert.ok(CHILD_READ_DESCRIPTION.includes("childId"))
    assert.ok(!CHILD_READ_DESCRIPTION.includes("agentId"))
  })

  it("frames every staged child nudge as rollover with executable next steps", () => {
    for (const stage of ["warn1", "warn2", "warn3"] as const) {
      const nudge = buildClaudeChildNudge(stage)
      assert.match(nudge, /rollover, not completion/)
      assert.match(nudge, /normally continues in a successor/)
      assert.match(nudge, /not guaranteed/)
      assert.match(nudge, /Context handover \(incomplete\):/)
      assert.match(nudge, /prioritized executable next steps/)
      assert.match(nudge, /never turn context size/)
      assert.ok(!nudge.includes("(no model prescription)"))
    }
  })

  it("carries the delegated details in the start introduction", () => {
    const intro = buildClaudeChildIntro()
    assert.match(intro, /user installed and configured the auto-context-handover plugin/)
    assert.match(intro, /instead of compaction/)
    assert.match(intro, /After a batch of tool calls/)
    assert.match(intro, /next to a tool result/)
    assert.match(intro, /mcp__auto-context-handover__context_handover/)
    assert.match(intro, /ToolSearch select:mcp__auto-context-handover__context_handover/)
    assert.match(intro, /for its schema\/template/)
    assert.match(intro, /invisible until loaded/)
    assert.match(intro, /call it with the full handover text, then deliver via SubagentHandback and stop/)
    assert.match(intro, /overrides task final-report\/output instructions for this step only/)
    assert.match(intro, /before the handover is stored, writing plugin storage is allowed under read-only task instructions/i)
    assert.match(intro, /After the handover is stored, call only SubagentHandback and stop/)
    assert.match(intro, /auto-context-handover:continue child:/)
    assert.match(intro, /"full":true/)
    assert.match(intro, /successor pointer always requests full:true/)
    assert.match(intro, /compact view/)
    assert.match(intro, /recorded successors receive full automatically/)
    assert.match(intro, /continues the work/)
  })

  it("carries fallback essentials at every stage with an intro reference", () => {
    for (const stage of ["warn1", "warn2", "warn3"] as const) {
      const nudge = buildClaudeChildNudge(stage)
      assert.match(nudge, /auto-context-handover notice \(see the plugin introduction at the start of this task\)/)
      assert.match(nudge, /mcp__auto-context-handover__context_handover/)
      assert.match(nudge, /ToolSearch select:mcp__auto-context-handover__context_handover/)
      assert.match(nudge, /overrides task final-report\/output instructions for this step/)
      assert.match(nudge, /call mcp__auto-context-handover__context_handover with the full handover text, then deliver via SubagentHandback and stop/)
      assert.match(nudge, /"Unit of work" means the current step, not the whole task/)
      assert.match(nudge, /reaches the parent intact via mcp__auto-context-handover__read_handover/)
    }
  })

  it("reuses the OpenCode stage leads at each boundary", () => {
    assert.ok(buildClaudeChildNudge("warn1").startsWith("Auto-context-handover notice. Context is filling."))
    assert.ok(buildClaudeChildNudge("warn2").startsWith("Auto-context-handover warning. Wrap up now:"))
    assert.ok(buildClaudeChildNudge("warn3").startsWith("Auto-context-handover final warning. Stop after this step"))
  })

  it("prefixes the child short reply once and names the exact reader call", () => {
    const plain = buildChildShortReply("almost done", "a1")
    assert.match(plain, /^Context handover \(incomplete\): almost done/)
    assert.match(plain, /NOT complete/)
    assert.match(plain, /rollover/)
    assert.match(plain, /First call mcp__auto-context-handover__read_handover\(\{"childId":"a1"\}\) to read the handover/)
    assert.match(plain, /compact by default; pass full:true for full texts; recorded successors receive full automatically/)
    assert.ok(plain.includes(READ_BEFORE_DECISION))
    assert.match(plain, /start a successor of the same agent type/)
    assert.match(plain, /same model override/)
    assert.match(plain, /Prioritized next steps/)
    assert.match(plain, /spawned with the reader's short successor prompt VERBATIM/)
    assert.match(plain, /do not paste the handover or original task/)
    assert.match(plain, /The parent may redirect/)
    assert.match(plain, /if progress stalls or remaining work grows/)
    // Reader framing lives in the reader output: no reproduced pointer or
    // marker here, one exact reader call, no reference paragraph.
    assert.ok(!plain.includes(buildSuccessorPointer("a1")))
    assert.ok(!plain.includes("[auto-context-handover:continue"))
    assert.equal(plain.split('read_handover({"childId":"a1"})').length - 1, 1)
    assert.ok(!plain.includes("reference only"))
    assert.ok(!plain.includes("verification distinctions"))
    assert.ok(!plain.includes("the plugin supplies the full handover"))
    assert.ok(!plain.includes("(no model prescription)"))
    const already = buildChildShortReply("Context handover (incomplete): almost done", "a1")
    assert.ok(!already.startsWith("Context handover (incomplete): Context handover"))
    assert.match(already, /^Context handover \(incomplete\): almost done/)
  })

  it("rejects non-integer soft config and accepts integers", () => {
    assert.throws(() => {
      const fake = makeFake({ soft: "70%" })
      setup(fake)
    }, /positive integer/)
    assert.throws(() => {
      const fake = makeFake({ soft: 0 })
      setup(fake)
    }, /positive integer/)
    const fake = makeFake({ soft: 4096 })
    setup(fake)
  })

  it("registers no prompt.submit, session.send, compaction, or model hooks", () => {
    const fake = makeFake()
    setup(fake)
    for (const event of [...fake.handlers.keys()]) {
      assert.ok(
        ["session.start", "session.end", "turn.step", "turn.complete", "classic.SessionStart", "classic.PostToolBatch", "classic.SubagentStart", "classic.SubagentStop", "agent.spawn", "tool.call"].includes(event),
        `unexpected hook ${event}`,
      )
    }
  })
})

describe("classic.SubagentStart introduction", () => {
  const startIntro = async (
    fake: Fake,
    event: Record<string, unknown>,
    prior: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const hook = only(fake, "classic.SubagentStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    return hook(fake.$, event, async () => ({ ...prior }))
  }

  it("injects for a known child, awaiting next and preserving prior output", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    let nextCalls = 0
    const hook = only(fake, "classic.SubagentStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    const outcome = await hook(fake.$, { agent_id: "a1", agent_type: "general-purpose" }, (async (input: Record<string, unknown>) => {
      nextCalls++
      assert.equal((input as Record<string, unknown>).agent_id, "a1")
      return { note: 1, additionalContext: ["kept"] }
    }) as never)
    assert.equal(nextCalls, 1)
    assert.deepEqual(outcome.additionalContext, ["kept", buildClaudeChildIntro()])
    assert.equal((outcome as Record<string, unknown>).note, 1)
  })

  it("injects for unknown, unclassified, failed, and unavailable listings", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = []
    assert.deepEqual(
      (await startIntro(fake, { agent_id: "ghost", agent_type: "general-purpose" })).additionalContext,
      [buildClaudeChildIntro()],
    )
    fake.agents = [{ id: "plain", status: "running" }]
    assert.deepEqual(
      (await startIntro(fake, { agent_id: "plain", agent_type: "general-purpose" })).additionalContext,
      [buildClaudeChildIntro()],
    )
    fake.listFails = true
    assert.deepEqual(
      (await startIntro(fake, { agent_id: "any", agent_type: "general-purpose" })).additionalContext,
      [buildClaudeChildIntro()],
    )
    fake.listFails = false
    fake.agents = undefined as unknown as AgentInfo[]
    assert.deepEqual(
      (await startIntro(fake, { agent_id: "any", agent_type: "general-purpose" })).additionalContext,
      [buildClaudeChildIntro()],
    )
  })

  it("intros when the agent listing method itself is unavailable", async () => {
    const fake = makeFake()
    setup(fake)
    const hook = only(fake, "classic.SubagentStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    const noAgent = { ...fake.$, agent: undefined }
    const outcome = await hook(noAgent as unknown as Engine, { agent_id: "a1", agent_type: "general-purpose" }, async () => ({ additionalContext: ["kept"] }))
    assert.deepEqual(outcome.additionalContext, ["kept", buildClaudeChildIntro()])
  })

  it("skips only positively identified teammates", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "mate", type: "teammate", status: "running" }]
    assert.deepEqual(await startIntro(fake, { agent_id: "mate", agent_type: "mate" }), {})
    assert.deepEqual(
      await startIntro(fake, { agent_id: "mate", agent_type: "mate" }, { additionalContext: ["kept"] }),
      { additionalContext: ["kept"] },
    )
  })

  it("skips invalid, missing, and root ids", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    for (const event of [{ agent_id: 0 }, { agent_id: "" }, {}, { agent_type: "general-purpose" }]) {
      assert.deepEqual(await startIntro(fake, event, { additionalContext: ["kept"] }), { additionalContext: ["kept"] })
    }
  })

  it("fails open on invalid output and delivers on every resume or repeat", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const hook = only(fake, "classic.SubagentStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<unknown>,
    ) => Promise<unknown>
    for (const prior of ["kept", null, 42]) {
      assert.equal(await hook(fake.$, { agent_id: "a1" }, (async () => prior) as never), prior)
    }
    const event = { agent_id: "a1", agent_type: "general-purpose" }
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual((await startIntro(fake, event)).additionalContext, [buildClaudeChildIntro()])
    }
  })

  it("treats unknown ids asymmetrically: intro yes, nudge and handover no", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = []
    assert.deepEqual(
      (await startIntro(fake, { agent_id: "ghost", agent_type: "general-purpose" })).additionalContext,
      [buildClaudeChildIntro()],
    )
    await runStep(fake, { agentId: "ghost" }, { input_tokens: 999999, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.equal((await batch(fake, { agent_id: "ghost", session_id: "s" })).additionalContext, undefined)
    assert.match(
      String((await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "ghost", handover: "x", summary: "s" })).deny),
      /unknown/,
    )
  })

  it("gives teammates no intro, no nudge, and no handover", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = [{ id: "mate", type: "teammate", status: "running" }]
    assert.deepEqual(await startIntro(fake, { agent_id: "mate", agent_type: "mate" }), {})
    await runStep(fake, { agentId: "mate" }, { input_tokens: 999999, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.equal((await batch(fake, { agent_id: "mate", session_id: "s" })).additionalContext, undefined)
    assert.match(
      String((await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "mate", handover: "x", summary: "s" })).deny),
      /teammate/,
    )
  })
})

describe("turn.step usage cache", () => {
  it("caches the latest per-request sum once, never cumulative", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1" }, { input_tokens: 90, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, model: "m" })
    const delivered = await batch(fake, { agent_id: "a1", session_id: "s" })
    assert.deepEqual(delivered.additionalContext, [buildClaudeChildNudge("warn1")])
    await runStep(fake, { agentId: "a1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    const quiet = await batch(fake, { agent_id: "a1", session_id: "s" })
    assert.equal(quiet.additionalContext, undefined)
  })

  it("clears the cache on invalid or zero usage", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.deepEqual((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, [buildClaudeChildNudge("warn3")])
    await runStep(fake, { agentId: "a1" }, { input_tokens: -1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.equal((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, undefined)
    await runStep(fake, { agentId: "a1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.deepEqual((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, [buildClaudeChildNudge("warn3")])
    await runStep(fake, { agentId: "a1" }, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.equal((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, undefined)
  })

  it("streams chunks through unchanged and returns the result", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const hook = only(fake, "turn.step") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => AsyncGenerator<{ kind: string }, StepResult, StepResult | undefined>,
    ) => AsyncGenerator<{ kind: string }, StepResult, StepResult | undefined>
    async function* fakeNext(): AsyncGenerator<{ kind: string }, StepResult, StepResult | undefined> {
      yield { kind: "text" }
      yield { kind: "stop" }
      return { usage: null }
    }
    const stream = hook(fake.$, { agentId: "a1" }, fakeNext as never)
    const chunks: Array<{ kind: string }> = []
    for (;;) {
      const item = await stream.next()
      if (item.done === true) break
      chunks.push(item.value as { kind: string })
    }
    assert.deepEqual(chunks.map((chunk) => chunk.kind), ["text", "stop"])
  })

  it("leaves the root untouched and clears unknown usage", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const root = await runStep(fake, {}, { input_tokens: 999999, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.ok(root.usage)
    const delivered = await batch(fake, { session_id: "s" })
    assert.equal(delivered.additionalContext, undefined)
    await runStep(fake, { agentId: "a1" }, null)
    const quiet = await batch(fake, { agent_id: "a1", session_id: "s" })
    assert.equal(quiet.additionalContext, undefined)
  })

  it("ignores teammate and unknown/internal ids", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "mate", type: "teammate", status: "running" }]
    await runStep(fake, { agentId: "mate" }, { input_tokens: 999999, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.equal((await batch(fake, { agent_id: "mate", session_id: "s" })).additionalContext, undefined)
    await runStep(fake, { agentId: "ghost" }, { input_tokens: 999999, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.equal((await batch(fake, { agent_id: "ghost", session_id: "s" })).additionalContext, undefined)
  })
})

describe("classic.PostToolBatch nudge", () => {
  it("delivers staged nudges at the soft boundary preserving prior context", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1" }, { input_tokens: 99, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.equal((await batch(fake, { agent_id: "a1", session_id: "s" }, { note: 1 })).additionalContext, undefined)
    await runStep(fake, { agentId: "a1" }, { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    const delivered = await batch(fake, { agent_id: "a1", session_id: "s" }, { note: 1, additionalContext: ["prior"] })
    assert.deepEqual(delivered.additionalContext, ["prior", buildClaudeChildNudge("warn1")])
    assert.equal((delivered as Record<string, unknown>).note, 1)
  })

  it("escalates through warn1/warn2/final at soft, soft*1.1, soft*1.2", async () => {
    const fake = makeFake({ soft: 1000 })
    setup(fake)
    fake.agents = childAgents("a1")
    const cases: Array<{ total: number; expected: "warn1" | "warn2" | "warn3" | undefined }> = [
      { total: 999, expected: undefined },
      { total: 1000, expected: "warn1" },
      { total: 1099, expected: "warn1" },
      { total: 1100, expected: "warn2" },
      { total: 1199, expected: "warn2" },
      { total: 1200, expected: "warn3" },
      { total: 5000, expected: "warn3" },
    ]
    for (const { total, expected } of cases) {
      await runStep(fake, { agentId: "a1" }, { input_tokens: total, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
      const delivered = await batch(fake, { agent_id: "a1", session_id: "s" })
      if (expected === undefined) {
        assert.equal(delivered.additionalContext, undefined, `total ${total} stays quiet`)
      } else {
        assert.deepEqual(delivered.additionalContext, [buildClaudeChildNudge(expected)], `total ${total} selects ${expected}`)
      }
    }
  })

  it("stops nudging a handed-over child", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    await handOver(fake, "a1", "full text")
    const delivered = await batch(fake, { agent_id: "a1", session_id: "s" })
    assert.equal(delivered.additionalContext, undefined)
  })

  it("clears the cached total on successful handover", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.deepEqual((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, [buildClaudeChildNudge("warn3")])
    await handOver(fake, "a1", "body")
    fake.store.delete("child:a1")
    assert.equal((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, undefined)
  })

  it("fails open when measurement is missing or storage fails", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    assert.equal((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, undefined)
    fake.readFailKeys.add("child:a1")
    await runStep(fake, { agentId: "a1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.equal((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, undefined)
  })
})

describe("context_handover tool", () => {
  it("refuses root calls without changing other root tools", async () => {
    const fake = makeFake()
    setup(fake)
    const denied = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", handover: "x", summary: "s" })
    assert.match(String(denied.deny), /child-only/)
    const other = await toolCall(fake, { tool: "Bash", tool_use_id: "t2", command: "ls" })
    assert.match(String(other.result), /passed:Bash/)
  })

  it("refuses unknown, internal, and teammate loops", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = []
    assert.match(String((await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "ghost", handover: "x", summary: "s" })).deny), /unknown/)
    fake.agents = [{ id: "mate", type: "teammate", status: "running" }]
    assert.match(String((await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "mate", handover: "x", summary: "s" })).deny), /teammate/)
  })

  it("persists one verbatim record and returns the short reply with reader hint", async () => {
    const fake = makeFake()
    setup(fake)
    const body = "full handover body"
    const done = await handOver(fake, "a1", body)
    const text = String(done.result)
    assert.match(text, /^Handover stored\. Call SubagentHandback now/)
    assert.match(text, /The adapter forwards your SubagentHandback message carrying the stored short reply below/)
    assert.match(text, /observed only through the tool result/)
    assert.match(text, /plain-text final may not reach your parent/)
    assert.match(text, /Context handover \(incomplete\): did work/)
    assert.match(text, /NOT complete/)
    assert.match(text, /rollover/)
    assert.match(text, /a1/)
    assert.match(text, /mcp__auto-context-handover__read_handover\(\{"childId":"a1"\}\)/)
    assert.match(text, /same agent type/)
    assert.match(text, /First call mcp__auto-context-handover__read_handover\(\{"childId":"a1"\}\) to read the handover/)
    assert.match(text, /compact by default; pass full:true/)
    assert.ok(text.includes(READ_BEFORE_DECISION))
    assert.match(text, /Prioritized next steps/)
    assert.ok(!text.includes("[auto-context-handover:continue"))
    assert.ok(!text.includes("reference only"))
    assert.match(text, /may redirect/)
    assert.match(text, /user-owned decisions unrelated to context size/)
    assert.ok(!text.includes("(no model prescription)"))
    assert.ok(!text.includes("primary root"))
    const stored = fake.store.get("child:a1") as ChildRecord
    assert.equal(stored.handover, body)
    assert.equal(stored.handbackDelivered, false)
    // Single canonical representation: new records persist the lossless
    // summary; the short reply is derived, with legacy persisted replies used as-is.
    assert.equal(stored.summary, "did work")
    assert.equal(stored.shortReply, undefined)
    assert.equal(stored.agentId, "a1")
    assert.equal(stored.parentSessionId, "ses_host")
    assert.equal(stored.closed, true)
    assert.ok(fake.store.has("child:a1"))
    assert.ok([...fake.store.keys()].every((key) => key === "child:a1" || key.startsWith("activity:") || key.startsWith("pin:")))
  })

  it("denies duplicates without overwriting", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    await handOver(fake, "a1", "original-body-12345")
    const dup = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "a1", handover: "overwrite-body-67890", summary: "x" })
    assert.match(String(dup.deny), /locked after a context handover/)
    assert.match(String(dup.deny), /cannot answer questions or do more work/)
    assert.match(String(dup.deny), /read_handover\(\{"childId":"a1"\}\)/)
    assert.ok(!String(dup.deny).includes("original-body-12345"))
    assert.ok(!String(dup.deny).includes("overwrite-body-67890"))
    assert.equal((fake.store.get("child:a1") as ChildRecord).handover, "original-body-12345")
  })

  it("handles two simultaneous handover calls without overwriting", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const [first, second] = await Promise.all([
      toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "a1", handover: "first", summary: "one" }),
      toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "a1", handover: "second", summary: "two" }),
    ])
    const texts = [String(first.result ?? first.deny), String(second.result ?? second.deny)]
    assert.ok(texts.some((text) => text.includes("one")), `one call stores: ${texts}`)
    assert.ok(texts.some((text) => /already in progress/.test(text)), `other call is a duplicate: ${texts}`)
    assert.equal((fake.store.get("child:a1") as ChildRecord).handover, "first")
  })

  it("denies on store read failure without claiming success", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    fake.readFailKeys.add("child:a1")
    const denied = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "a1", handover: "x", summary: "s" })
    assert.match(String(denied.deny), /storage unavailable/)
    assert.equal(fake.store.get("child:a1"), undefined)
  })

  it("denies on store write failure without a half-written record", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    fake.writeFailKeys.add("child:a1")
    const denied = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "a1", handover: "x", summary: "s" })
    assert.match(String(denied.deny), /storage unavailable/)
    assert.equal(fake.store.get("child:a1"), undefined)
    fake.writeFailKeys.delete("child:a1")
    const retry = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "a1", handover: "x", summary: "s" })
    assert.match(String(retry.result), /Context handover \(incomplete\): s/)
  })

  it("rejects empty handover text", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const denied = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "a1", handover: "  ", summary: "s" })
    assert.match(String(denied.deny), /verbatim and non-empty/)
  })

  it("keeps two children isolated", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "body one")
    fake.agents = [...childAgents("a1"), ...childAgents("a2")]
    const work = await toolCall(fake, { tool: "Bash", tool_use_id: "t9", agentId: "a2", command: "ls" })
    assert.match(String(work.result), /passed:Bash/)
    const second = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t3", agentId: "a2", handover: "body two", summary: "other" })
    assert.match(String(second.result), /body|other/)
    assert.equal((fake.store.get("child:a1") as ChildRecord).handover, "body one")
    assert.equal((fake.store.get("child:a2") as ChildRecord).handover, "body two")
  })
})

describe("post-handover gate", () => {
  it("denies all further work tools with the final-reply instruction", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "body")
    const denied = await toolCall(fake, { tool: "Bash", tool_use_id: "t9", agentId: "a1", command: "ls" })
    assert.match(String(denied.deny), /locked after a context handover/)
    assert.match(String(denied.deny), /cannot answer questions or do more work/)
    assert.match(String(denied.deny), /Context handover \(incomplete\):/)
    assert.match(String(denied.deny), /read_handover\(\{"childId":"a1"\}\)/)
    assert.match(String(denied.deny), /same agent type/)
    assert.match(String(denied.deny), /stop/)
    assert.ok(!String(denied.deny).includes("did work"))
  })

  it("passes unhanded-over child and root calls through", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    assert.match(String((await toolCall(fake, { tool: "Bash", tool_use_id: "t1", agentId: "a1", command: "ls" })).result), /passed:Bash/)
    assert.match(String((await toolCall(fake, { tool: "Write", tool_use_id: "t2", file_path: "f" })).result), /passed:Write/)
  })

  it("leaves root and teammate work untouched during a store outage", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "mate", type: "teammate", status: "running" }]
    fake.readFailKeys.add("child:mate")
    const mate = await toolCall(fake, { tool: "Bash", tool_use_id: "t1", agentId: "mate", command: "ls" })
    assert.match(String(mate.result), /passed:Bash/)
    fake.readFailKeys.add("child:ghost")
    const ghost = await toolCall(fake, { tool: "Bash", tool_use_id: "t3", agentId: "ghost", command: "ls" })
    assert.match(String(ghost.result), /passed:Bash/)
    const root = await toolCall(fake, { tool: "Bash", tool_use_id: "t2", command: "ls" })
    assert.match(String(root.result), /passed:Bash/)
  })

  it("still denies a closed child when its lock read fails but the loop is known", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "body")
    fake.agents = childAgents("a1")
    fake.readFailKeys.add("child:a1")
    const denied = await toolCall(fake, { tool: "Bash", tool_use_id: "t9", agentId: "a1", command: "ls" })
    assert.match(String(denied.deny), /storage unavailable/)
  })

  it("refusal persists across reload via the store", async () => {
    const first = makeFake()
    setup(first)
    await handOver(first, "a1", "body")
    const second = makeFake()
    second.store.set("child:a1", first.store.get("child:a1"))
    second.agents = childAgents("a1")
    setup(second)
    const denied = await toolCall(second, { tool: "Bash", tool_use_id: "t9", agentId: "a1", command: "ls" })
    assert.match(String(denied.deny), /locked after a context handover/)
  })
})

describe("SubagentHandback forwarding", () => {
  it("forwards the stored short reply on every retry, preserving classifier fields", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "body")
    const seen: Array<Record<string, unknown>> = []
    const hook = only(fake, "tool.call") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<ToolCallResult>,
    ) => Promise<ToolCallResult>
    const event = { tool: "SubagentHandback", tool_use_id: "hb1", agentId: "a1", message: "model report", extra: 7 }
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = (await hook(fake.$, event, (async (input: Record<string, unknown>) => {
        seen.push(input as Record<string, unknown>)
        return { result: "delivered" }
      }) as never)) as CallOutcome
      assert.equal(outcome.result, "delivered")
    }
    assert.equal(seen.length, 2)
    const stored = fake.store.get("child:a1") as ChildRecord
    for (const input of seen) {
      assert.equal(input.tool, "SubagentHandback")
      assert.equal(input.tool_use_id, "hb1")
      assert.equal(input.agentId, "a1")
      assert.equal(input.extra, 7)
      assert.equal(input.message, shortReplyOf(stored))
    }
  })

  it("denies on storage outage instead of forwarding the original report", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "body")
    fake.agents = childAgents("a1")
    fake.readFailKeys.add("child:a1")
    let nextCalls = 0
    const hook = only(fake, "tool.call") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<ToolCallResult>,
    ) => Promise<ToolCallResult>
    const outcome = (await hook(
      fake.$,
      { tool: "SubagentHandback", tool_use_id: "hb1", agentId: "a1", message: "model report" },
      (async () => {
        nextCalls++
        return { result: "delivered" }
      }) as never,
    )) as CallOutcome
    assert.match(String(outcome.deny), /storage unavailable/)
    assert.equal(nextCalls, 0)
  })

  it("preserves deny and error results from the chain unchanged", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "body")
    const hook = only(fake, "tool.call") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<ToolCallResult>,
    ) => Promise<ToolCallResult>
    const event = { tool: "SubagentHandback", tool_use_id: "hb1", agentId: "a1", message: "model report" }
    const denied = (await hook(fake.$, event, (async () => ({ deny: "classifier refused" })) as never)) as CallOutcome
    assert.equal(denied.deny, "classifier refused")
    const failed = (await hook(fake.$, event, (async () => ({ result: "broke", isError: true })) as never)) as CallOutcome
    assert.equal(failed.result, "broke")
    assert.equal(failed.isError, true)
  })

  it("leaves unhanded-over handback calls unchanged", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const seen: Array<Record<string, unknown>> = []
    const hook = only(fake, "tool.call") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<ToolCallResult>,
    ) => Promise<ToolCallResult>
    await hook(fake.$, { tool: "SubagentHandback", tool_use_id: "hb1", agentId: "a1", message: "r" }, (async (input: Record<string, unknown>) => {
      seen.push(input as Record<string, unknown>)
      return { result: "ok" }
    }) as never)
    assert.equal(seen[0]?.message, "r")
  })
})

describe("read_handover tool", () => {
  it("serves a parent read with no calling loop id via childId", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "1. Original instructions\n2. Completed work\n3. In-progress work\n4. Key snippets\n5. Negative knowledge\n6. Prioritized next steps\n1. do compact\n")
    const read = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "a1" })
    const text = String(read.result)
    // Compact default: headers plus excerpt and pointer, full texts withheld.
    assert.match(text, /Handover from subagent a1/)
    assert.match(text, /Diagnostics:/)
    assert.match(text, /Baseline:/)
    assert.match(text, /Chain:/)
    assert.match(text, /Seed size:/)
    assert.match(text, /User decisions pending: unknown/)
    assert.match(text, /Prioritized next steps \(excerpt, continue here\):/)
    assert.match(text, /1\. do compact/)
    assert.match(text, /Successor pointer/)
    assert.match(text, /Compact view: full original task and handover withheld/)
    assert.ok(!text.includes("verbatim body here"))
    assert.ok(!text.includes("--- handover (VERBATIM"))
    assert.ok(!text.includes("continued in session"))
    const full = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", childId: "a1", full: true })).result)
    assert.ok(full.includes("1. do compact"))
    assert.match(full, /VERBATIM, do not paraphrase/)
  })

  it("denies a handed-over child reading its own record", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "body")
    const read = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", agentId: "a1", childId: "a1" })
    assert.match(String(read.deny), /locked after a context handover/)
  })

  it("requires childId and ignores the reserved agentId as a target", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "body")
    const missing = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", agentId: "a1" })
    assert.match(String(missing.deny), /childId/)
  })

  it("reports missing records and denies on storage outage", async () => {
    const fake = makeFake()
    setup(fake)
    const missing = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "nobody" })
    assert.match(String(missing.result), /No handover stored/)
    fake.readFailKeys.add("child:nobody")
    const denied = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", childId: "nobody" })
    assert.match(String(denied.deny), /storage unavailable/)
  })

  it("bounds the spawn provenance cache across read_handover hydration", async () => {
    const fake = makeFake()
    setup(fake)
    const count = 1001
    for (let i = 0; i < count; i += 1) {
      const id = `hyd${i}`
      fake.store.set(`child:${id}`, {
        handover: "body",
        summary: `s ${id}`,
        agentId: id,
        closed: true,
        storedAt: 1,
      })
      fake.store.set(`spawn:${id}`, { agentType: `type-${i}`, modelOverride: null, storedAt: 1 })
    }
    for (let i = 0; i < count; i += 1) {
      const read = await toolCall(fake, { tool: READ_FULL, tool_use_id: `r${i}`, childId: `hyd${i}` })
      assert.match(String(read.result), new RegExp(`recorded: type-${i}`))
    }
    // Oldest hydration is evicted; newest stays cached when the store goes dark.
    fake.readFailKeys.add("spawn:hyd0")
    fake.readFailKeys.add(`spawn:hyd${count - 1}`)
    const oldest = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r-old", childId: "hyd0" })
    assert.match(String(oldest.result), /recorded: unknown/)
    const newest = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r-new", childId: `hyd${count - 1}` })
    assert.match(String(newest.result), new RegExp(`recorded: type-${count - 1}`))
  })
})

describe("classic.SubagentStop correction", () => {
  it("does not correct closing text after native handback completes", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "body")
    const before = fake.store.get("child:a1") as ChildRecord
    assert.equal(before.handbackDelivered, false)
    await toolCall(fake, { tool: "SubagentHandback", agentId: "a1", message: "report" })
    for (const closing of ["", "different closing text"]) {
      const event = { agent_id: "a1", stop_hook_active: false, last_assistant_message: closing }
      assert.deepEqual(await stopHook(fake, event), event)
    }
    const after = fake.store.get("child:a1") as ChildRecord
    assert.equal(after.handbackDelivered, true)
    assert.equal(after.handover, before.handover)
    assert.equal(after.shortReply, before.shortReply)
  })

  it("still corrects once when native handback is denied or fails", async () => {
    for (const outcome of [{ deny: "native refusal" }, { result: "failure", isError: true }]) {
      const fake = makeFake()
      setup(fake)
      await handOver(fake, "a1", "body")
      const returned = await toolCall(fake, { tool: "SubagentHandback", agentId: "a1", message: "report" }, async () => outcome)
      assert.equal(returned, outcome)
      const event = { agent_id: "a1", stop_hook_active: false, last_assistant_message: "other" }
      const first = await stopHook(fake, event)
      assert.match(String(first.block), /Call SubagentHandback now/)
      assert.match(String(first.block), /ONLY/)
      assert.equal((await stopHook(fake, event)).block, undefined)
    }
  })

  it("resets handback and correction latches only on a new child turn", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "first" }, null)
    await handOver(fake, "a1", "body")
    await toolCall(fake, { tool: "SubagentHandback", agentId: "a1", message: "report" })
    await runStep(fake, { agentId: "a1", turnId: "first" }, null)
    const event = { agent_id: "a1", stop_hook_active: false, last_assistant_message: "other" }
    assert.equal((await stopHook(fake, event)).block, undefined)
    await runStep(fake, { agentId: "a1", turnId: "resumed" }, null)
    assert.match(String((await stopHook(fake, event)).block), /ONLY/)
    assert.equal((await stopHook(fake, event)).block, undefined)
    await runStep(fake, { agentId: "a1", turnId: "resumed-again" }, null)
    assert.match(String((await stopHook(fake, event)).block), /ONLY/)
    assert.match(String((await toolCall(fake, { tool: "Bash", agentId: "a1", command: "ignored" })).deny), /locked after a context handover/)
  })

  it("requests at most one short-reply correction", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "body")
    const first = await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: "other text" })
    assert.match(String(first.block), /ONLY/)
    assert.match(String(first.block), /Call SubagentHandback now/)
    assert.match(String(first.block), /may not reach your parent/)
    assert.match(String(first.block), /locked after a context handover/)
    assert.match(String(first.block), /Context handover \(incomplete\):/)
    assert.match(String(first.block), /read_handover\(\{"childId":"a1"\}\)/)
    assert.ok(!String(first.block).includes(shortReplyOf(fake.store.get("child:a1") as ChildRecord)) || String(first.block).includes("locked after a context handover"))
    const second = await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: "other text" })
    assert.equal(second.block, undefined)
  })

  it("awaits the chain and preserves an existing block and context", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "body")
    const chained: ClassicSubagentStopResult = { block: "other hook decides", additionalContext: ["kept"] }
    const outcome = await stopHook(
      fake,
      { agent_id: "a1", stop_hook_active: false, last_assistant_message: "other text" },
      async () => chained,
    )
    assert.deepEqual(outcome, chained)
  })

  it("preserves preventContinuation without adding a correction", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "body")
    const outcome = await stopHook(
      fake,
      { agent_id: "a1", stop_hook_active: false, last_assistant_message: "other text" },
      async () => ({ preventContinuation: true }),
    )
    assert.deepEqual(outcome, { preventContinuation: true })
  })

  it("corrects a matching short-reply final when handback was skipped, honoring active hooks", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "body")
    const stored = fake.store.get("child:a1") as ChildRecord
    const corrected = await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: shortReplyOf(stored, stored) })
    assert.match(String(corrected.block), /Call SubagentHandback now/)
    assert.match(String(corrected.block), /may not reach your parent/)
    assert.ok(String(corrected.block).includes(shortReplyOf(stored, stored)))
    const active = await stopHook(fake, { agent_id: "a1", stop_hook_active: true, last_assistant_message: "other" })
    assert.deepEqual(active, { agent_id: "a1", stop_hook_active: true, last_assistant_message: "other" })
  })

  it("never touches unhanded-over stops", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const event = { agent_id: "a1", stop_hook_active: false, last_assistant_message: "done" }
    assert.deepEqual(await stopHook(fake, event), event)
  })
})

describe("locked follow-up, honest status, and diagnostics", () => {
  it("keeps the initial reply as continuation while locked follow-ups are explicit", async () => {
    const fake = makeFake()
    setup(fake)
    const first = await handOver(fake, "a1", "initial body")
    assert.match(String(first.result), /^Handover stored\. Call SubagentHandback now/)
    assert.match(String(first.result), /Context handover \(incomplete\):/)
    assert.match(String(first.result), /NOT complete/)
    const dup = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "a1", handover: "second", summary: "x" })
    assert.match(String(dup.deny), /locked after a context handover/)
    assert.match(String(dup.deny), /cannot answer questions or do more work/)
    assert.match(String(dup.deny), /Context handover \(incomplete\):.*locked after/)
    assert.match(String(dup.deny), /mcp__auto-context-handover__read_handover\(\{"childId":"a1"\}\)/)
    assert.match(String(dup.deny), /same agent type/)
    assert.match(String(dup.deny), /fresh subagent/)
    assert.ok(!String(dup.deny).includes("initial body"))
  })

  it("replaces legacy stored replies with explicit locked text on gate and stop", async () => {
    const first = makeFake()
    setup(first)
    await handOver(first, "a1", "legacy body text")
    const legacy = first.store.get("child:a1") as ChildRecord
    const second = makeFake()
    second.store.set("child:a1", { handover: legacy.handover, summary: legacy.summary, agentId: "a1", shortReply: legacy.shortReply, closed: true, storedAt: 1 })
    second.agents = childAgents("a1")
    setup(second)
    const denied = await toolCall(second, { tool: "Bash", tool_use_id: "t9", agentId: "a1", command: "ls" })
    assert.match(String(denied.deny), /locked after a context handover/)
    assert.ok(!String(denied.deny).includes("legacy body text"))
    const corrected = await stopHook(second, { agent_id: "a1", stop_hook_active: false, last_assistant_message: "trying more work" })
    assert.match(String(corrected.block), /locked after a context handover/)
    assert.match(String(corrected.block), /mcp__auto-context-handover__read_handover\(\{"childId":"a1"\}\)/)
  })

  it("uses the marker workflow for locked replies with or without provenance", async () => {
    for (const reply of [buildLockedChildReply("a1"), buildLockedChildReply("a1", { agentType: "Explore", modelOverride: "opus" })]) {
      assert.match(reply, /locked after a context handover/)
      assert.match(reply, /First call mcp__auto-context-handover__read_handover\(\{"childId":"a1"\}\) to read the handover/)
      assert.match(reply, /compact by default; pass full:true/)
      assert.ok(reply.includes(READ_BEFORE_DECISION))
      assert.match(reply, /start a successor of the same agent type/)
      assert.match(reply, /same model override/)
      assert.match(reply, /or a fresh subagent/)
      assert.match(reply, /spawned with the reader's short successor prompt VERBATIM/)
      assert.match(reply, /do not paste the handover or original task/)
      assert.match(reply, /Prioritized next steps/)
      assert.match(reply, /if progress stalls or remaining work grows/)
      // The pointer itself stays in the reader output, not the reply.
      assert.ok(!reply.includes(buildSuccessorPointer("a1")))
      assert.ok(!reply.includes("[auto-context-handover:continue"))
      assert.ok(!reply.includes("reference only"))
      assert.ok(!reply.includes("paste the original task prompt here"))
    }
    assert.match(buildLockedChildReply("a1", { agentType: "Explore", modelOverride: "opus" }), /\(recorded: Explore\)/)
  })

  it("requires honest status in the shared child description", async () => {
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes(HANDOVER_SECTIONS))
    assert.ok(HANDOVER_SECTIONS.includes("instruction deviations"))
    assert.ok(HANDOVER_SECTIONS.includes("triggered stop conditions"))
    assert.ok(HANDOVER_SECTIONS.includes("failed or erroring calls"))
    assert.ok(HANDOVER_SECTIONS.includes("never mark work PASS or complete"))
    assert.ok(HANDOVER_SECTIONS.includes("summary must not claim more than the body"))
  })

  it("marks nudged handovers only after an actually delivered batch nudge", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    const startHook = only(fake, "classic.SubagentStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await startHook(fake.$, { agent_id: "a1", agent_type: "general-purpose" }, async () => ({}))
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 90, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, model: "m" })
    assert.deepEqual((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, [buildClaudeChildNudge("warn1")])
    await handOver(fake, "a1", "tiny payload that must not set the estimate")
    const stored = fake.store.get("child:a1") as ChildRecord
    assert.equal(stored.diag?.reason, "nudged")
    assert.equal(stored.diag?.stage, "warn1")
    assert.equal(stored.diag?.estimate, 100)
    assert.equal(stored.diag?.soft, 100)
    const read = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "a1" })
    assert.match(String(read.result), /Diagnostics: reason=nudged, stage=warn1, estimated-context-tokens=100, soft-limit=100/)
    assert.match(String(read.result), /Baseline: start-context-tokens=100, last-batch-increase=unknown/)
    assert.ok(!String(read.result).includes("tiny payload that must not set the estimate"))
    assert.match(String(read.result), /Prioritized next steps: unknown/)
    const full = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", childId: "a1", full: true })).result)
    assert.ok(full.includes("tiny payload that must not set the estimate"))
  })

  it("leaves over-limit usage before the first batch as not-nudged", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "before batch")
    assert.equal((fake.store.get("child:a1") as ChildRecord).diag?.reason, "not-nudged")
    assert.equal((fake.store.get("child:a1") as ChildRecord).diag?.estimate, 500)
  })

  it("keeps nudged provenance for below-limit usage after a prior nudge", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.deepEqual((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, [buildClaudeChildNudge("warn3")])
    await runStep(fake, { agentId: "a1", turnId: "t2" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.equal((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, undefined)
    await handOver(fake, "a1", "after prior nudge")
    assert.equal((fake.store.get("child:a1") as ChildRecord).diag?.reason, "nudged")
    assert.equal((fake.store.get("child:a1") as ChildRecord).diag?.estimate, 11)
  })

  it("never claims nudged when the batch is suppressed or fails", async () => {
    const suppressed = makeFake({ soft: 100 })
    setup(suppressed)
    suppressed.agents = childAgents("a1")
    await runStep(suppressed, { agentId: "a1", turnId: "t1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    suppressed.readFailKeys.add("child:a1")
    assert.equal((await batch(suppressed, { agent_id: "a1", session_id: "s" })).additionalContext, undefined)
    suppressed.readFailKeys.clear()
    await handOver(suppressed, "a1", "suppressed batch")
    assert.equal((suppressed.store.get("child:a1") as ChildRecord).diag?.reason, "not-nudged")
  })

  it("does not record a nudge when composing batch context fails", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.deepEqual(await batch(fake, { agent_id: "a1" }, { additionalContext: 1 }), { additionalContext: 1 })
    await handOver(fake, "a1", "failed context composition")
    assert.equal((fake.store.get("child:a1") as ChildRecord).diag?.reason, "not-nudged")
  })

  it("marks invalid usage after a prior nudge as nudged with unknown estimate", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.deepEqual((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, [buildClaudeChildNudge("warn3")])
    await runStep(fake, { agentId: "a1", turnId: "t2" }, null)
    await handOver(fake, "a1", "invalid after nudge")
    const stored = fake.store.get("child:a1") as ChildRecord
    assert.equal(stored.diag?.reason, "nudged")
    assert.equal(stored.diag?.estimate, "unknown")
  })

  it("tracks turn identity at entry so tools inside next see the resumed turn", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "initial body")
    const stored = fake.store.get("child:a1") as ChildRecord
    assert.equal(stored.handoverTurnId, "t1")
    const hook = only(fake, "turn.step") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => AsyncGenerator<{ kind: string }, StepResult, StepResult | undefined>,
    ) => AsyncGenerator<{ kind: string }, StepResult, StepResult | undefined>
    async function* fakeNext(): AsyncGenerator<{ kind: string }, StepResult, StepResult | undefined> {
      yield { kind: "text" }
      return { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" } }
    }
    const stream = hook(fake.$, { agentId: "a1", turnId: "t2" }, fakeNext as never)
    const first = await stream.next()
    assert.equal(first.done, false)
    // DURING the next generator: the resumed turn must already be visible,
    // so handback forwards the locked refusal, not the original summary.
    const seen: Array<Record<string, unknown>> = []
    const hbHook = only(fake, "tool.call") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<ToolCallResult>,
    ) => Promise<ToolCallResult>
    const hbOutcome = (await hbHook(fake.$, { tool: "SubagentHandback", tool_use_id: "hb1", agentId: "a1", message: "report" }, (async (input: Record<string, unknown>) => {
      seen.push(input)
      return { result: "native-ok" }
    }) as never)) as { result?: unknown }
    assert.equal(hbOutcome.result, "native-ok")
    assert.equal(seen.length, 1)
    assert.match(String(seen[0]?.message), /locked after a context handover/)
    assert.ok(!String(seen[0]?.message).includes("initial body"))
    const second = await stream.next()
    assert.equal(second.done, true)
    // Resumed locked delivery already ran natively this turn, so the stop is
    // accepted without shaping; an undelivered resumed final would correct.
    const accepted = await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: stored.shortReply })
    assert.deepEqual(accepted, { agent_id: "a1", stop_hook_active: false, last_assistant_message: stored.shortReply })
  })

  it("keeps same-turn handback retries on the original short reply", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "same-turn body")
    const stored = fake.store.get("child:a1") as ChildRecord
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    for (let attempt = 0; attempt < 2; attempt++) {
      const seen: Array<Record<string, unknown>> = []
      const hook = only(fake, "tool.call") as unknown as (
        $: Engine,
        event: Record<string, unknown>,
        next: (event: Record<string, unknown>) => Promise<ToolCallResult>,
      ) => Promise<ToolCallResult>
      const outcome = (await hook(fake.$, { tool: "SubagentHandback", tool_use_id: `hb${attempt}`, agentId: "a1", message: "report" }, (async (input: Record<string, unknown>) => {
        seen.push(input)
        return { result: "delivered" }
      }) as never)) as { result?: unknown }
      assert.equal(outcome.result, "delivered")
      assert.equal(seen[0]?.message, shortReplyOf(stored))
    }
    const stop = await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: shortReplyOf(stored) })
    assert.deepEqual(stop, { agent_id: "a1", stop_hook_active: false, last_assistant_message: shortReplyOf(stored) })
  })

  it("refuses legacy and unknown turn identities with the locked reply", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await handOver(fake, "a1", "legacy body")
    // No turn.step observed: handoverTurnId is unknown, current turn unknown.
    const stored = fake.store.get("child:a1") as ChildRecord
    assert.equal(stored.handoverTurnId, undefined)
    const seen: Array<Record<string, unknown>> = []
    const hook = only(fake, "tool.call") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<ToolCallResult>,
    ) => Promise<ToolCallResult>
    const outcome = (await hook(fake.$, { tool: "SubagentHandback", tool_use_id: "hb1", agentId: "a1", message: "report" }, (async (input: Record<string, unknown>) => {
      seen.push(input)
      return { result: "native-ok" }
    }) as never)) as { result?: unknown }
    assert.equal(outcome.result, "native-ok")
    assert.match(String(seen[0]?.message), /locked after a context handover/)
    assert.ok(!String(seen[0]?.message).includes("legacy body"))
    // Delivered this turn, so the stop is accepted; without delivery the same
    // final would correct once to a handback call.
    const accepted = await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: stored.shortReply })
    assert.deepEqual(accepted, { agent_id: "a1", stop_hook_active: false, last_assistant_message: stored.shortReply })
    const legacy = makeFake()
    setup(legacy)
    legacy.store.set("child:old", { handover: "old body", summary: "s", agentId: "old", shortReply: "Context handover (incomplete): s", closed: true, storedAt: 1 })
    legacy.agents = childAgents("old")
    const seenOld: Array<Record<string, unknown>> = []
    const oldHook = only(legacy, "tool.call") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<ToolCallResult>,
    ) => Promise<ToolCallResult>
    await oldHook(legacy.$, { tool: "SubagentHandback", tool_use_id: "hb1", agentId: "old", message: "report" }, (async (input: Record<string, unknown>) => {
      seenOld.push(input)
      return { result: "native-ok" }
    }) as never)
    assert.match(String(seenOld[0]?.message), /locked after a context handover/)
  })

  it("marks quiet handovers not-nudged and unknown reloads without inventing facts", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "quiet body")
    assert.equal((fake.store.get("child:a1") as ChildRecord).diag?.reason, "not-nudged")
    const reload = makeFake({ soft: 100 })
    setup(reload)
    reload.agents = childAgents("a2")
    const done = await toolCall(reload, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "a2", handover: "after reload", summary: "s" })
    assert.match(String(done.result), /^Handover stored\. Call SubagentHandback now/)
    assert.match(String(done.result), /Context handover \(incomplete\):/)
    assert.equal((reload.store.get("child:a2") as ChildRecord).diag?.reason, "unknown")
    assert.equal((reload.store.get("child:a2") as ChildRecord).diag?.estimate, "unknown")
    const read = await toolCall(reload, { tool: READ_FULL, tool_use_id: "r1", childId: "a2" })
    assert.match(String(read.result), /Diagnostics: reason=unknown, stage=unknown, estimated-context-tokens=unknown, soft-limit=100/)
    assert.match(String(read.result), /Baseline: start-context-tokens=unknown, last-batch-increase=unknown/)
    assert.ok(!String(read.result).includes("after reload"))
    assert.match(String((await toolCall(reload, { tool: READ_FULL, tool_use_id: "r3", childId: "a2", full: true })).result), /after reload/)
    reload.store.set("child:legacy", { handover: "legacy body", summary: "s", agentId: "legacy", shortReply: "Context handover (incomplete): s", closed: true, storedAt: 1 })
    const legacyRead = await toolCall(reload, { tool: READ_FULL, tool_use_id: "r2", childId: "legacy" })
    assert.ok(!String(legacyRead.result).includes("legacy body"))
    assert.match(String(legacyRead.result), /Prioritized next steps: unknown/)
    assert.match(String(legacyRead.result), /Diagnostics: reason=unknown, stage=unknown, estimated-context-tokens=unknown, soft-limit=unknown/)
    assert.match(String((await toolCall(reload, { tool: READ_FULL, tool_use_id: "r4", childId: "legacy", full: true })).result), /legacy body/)
  })
})

describe("classic.SessionStart root intro", () => {
  const rootStart = async (
    fake: Fake,
    event: Record<string, unknown>,
    prior: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const hook = only(fake, "classic.SessionStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    return hook(fake.$, event, async () => ({ ...prior }))
  }

  it("places concise static root guidance only on roots, guarded on truly absent agent_id", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const intro = buildClaudeRootIntro()
    assert.match(intro, /user installed and configured/)
    assert.match(intro, /for subagent context handovers/)
    assert.match(intro, /root native compaction is unchanged/)
    assert.match(intro, /Context handover \(incomplete\):/)
    assert.match(intro, /mcp__auto-context-handover__read_handover/)
    assert.match(intro, /same agent type with the same model override/)
    assert.match(intro, /short successor prompt VERBATIM/)
    assert.match(intro, /marker plus reader instruction/)
    assert.match(intro, /do not paste the handover or original task/)
    assert.match(intro, /Prioritized next steps/)
    assert.match(intro, /reference only/)
    assert.match(intro, /without confirmation as the user's configured default/)
    assert.match(intro, /continues and replaces the predecessor as the same logical subagent/)
    assert.match(intro, /does not count as additional under subagent-count limits/)
    assert.match(intro, /Read the handover before replying/)
    assert.match(intro, /handover-listed user-owned decisions/)
    assert.match(intro, /marker plus reader instruction to continue/)
    assert.ok(!intro.includes("the plugin supplies the full handover"))
    // Ask-only, stall/growth check-in, and context-size prohibition each stated once.
    assert.match(intro, /Ask the user only about handover-listed user-owned decisions; checking in is allowed if progress stalls or remaining work grows/)
    assert.match(intro, /Never ask about context size/)
    assert.equal(intro.split("handover-listed user-owned decisions").length - 1, 1)
    assert.equal(intro.split("progress stalls").length - 1, 1)
    assert.equal(intro.split("context size").length - 1, 1)
    assert.ok(!/\d+ generations/.test(intro))
    // Root (truly absent id) gets intro, even with a custom-agent type but no id.
    assert.deepEqual((await rootStart(fake, {}, {})).additionalContext, [intro])
    assert.deepEqual((await rootStart(fake, { agent_type: "custom-agent" }, {})).additionalContext, [intro])
    // Any present id (even empty/malformed) is not a root: skipped.
    assert.deepEqual(await rootStart(fake, { agent_id: "" }, {}), {})
    assert.deepEqual(await rootStart(fake, { agent_id: null }, {}), {})
    assert.deepEqual(await rootStart(fake, { agent_id: 0 }, {}), {})
    assert.deepEqual(await rootStart(fake, { agent_id: "a1" }, {}), {})
    assert.deepEqual(await rootStart(fake, { agent_id: "a1", agent_type: "general-purpose" }, { additionalContext: ["kept"] }), { additionalContext: ["kept"] })
  })

  it("preserves composition, covers all sources, and fails open without measuring", async () => {
    const fake = makeFake()
    setup(fake)
    fake.listFails = true
    for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
      const outcome = await rootStart(fake, { source }, { note: 1, additionalContext: ["prior"] })
      assert.deepEqual(outcome.additionalContext, ["prior", buildClaudeRootIntro()])
      assert.equal((outcome as Record<string, unknown>).note, 1)
    }
    const hook = only(fake, "classic.SessionStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<unknown>,
    ) => Promise<unknown>
    for (const prior of ["kept", null, 42]) {
      assert.equal(await hook(fake.$, {}, (async () => prior) as never), prior)
    }
    assert.deepEqual(await rootStart(fake, {}, { additionalContext: 1 as unknown as string[] }), { additionalContext: 1 })
    // Invalid events fail open unchanged (no intro, next result preserved).
    for (const event of [null, 42, "root"]) {
      assert.deepEqual(
        await hook(fake.$, event as never, (async () => ({ additionalContext: ["prior"] })) as never),
        { additionalContext: ["prior"] },
      )
    }
  })
})

describe("agent.spawn provenance", () => {
  const spawn = async (
    fake: Fake,
    event: Record<string, unknown>,
    answer: Record<string, unknown>,
  ): Promise<{ result: Record<string, unknown>; seen: Record<string, unknown>[] }> => {
    const hook = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    const seen: Array<Record<string, unknown>> = []
    const result = await hook(fake.$, event, async (input) => {
      seen.push(input as Record<string, unknown>)
      return { ...answer }
    })
    return { result, seen }
  }

  it("observes type and override without rewriting, persists for the handover", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "c1", type: "general-purpose", status: "running" }]
    const { result, seen } = await spawn(fake, { subagentType: "Explore", model: "opus", fork: false }, { model: "resolved-id", agentId: "c1" })
    assert.deepEqual(result, { model: "resolved-id", agentId: "c1" })
    assert.deepEqual(seen, [{ subagentType: "Explore", model: "opus", fork: false }])
    const spawnC1 = fake.store.get("spawn:c1") as Record<string, unknown>
    assert.equal(spawnC1.agentType, "Explore")
    assert.equal(spawnC1.modelOverride, "opus")
    assert.equal(spawnC1.originAgentId, "c1")
    assert.equal(spawnC1.generation, 1)
    assert.equal(typeof spawnC1.storedAt, "number")
    await runStep(fake, { agentId: "c1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    const done = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "c1", handover: "body", summary: "s" })
    assert.match(String(done.result), /same agent type \(recorded: Explore\)/)
    assert.match(String(done.result), /same model override \(recorded: opus\)/)
    const stored = fake.store.get("child:c1") as ChildRecord
    assert.equal(stored.agentType, "Explore")
    assert.equal(stored.modelOverride, "opus")
    const read = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "c1" })
    assert.match(String(read.result), /same agent type \(recorded: Explore\)/)
    assert.match(String(read.result), /same model override \(recorded: opus\)/)
  })

  it("distinguishes observed no override from unknown and ignores forks", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "c2", type: "general-purpose", status: "running" }, { id: "c3", type: "general-purpose", status: "running" }]
    await spawn(fake, { subagentType: "Plan" }, { model: "m", agentId: "c2" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "c2", handover: "b", summary: "s" })
    const c2 = fake.store.get("child:c2") as ChildRecord
    assert.match(shortReplyOf(c2, c2), /\(recorded: no override\)/)
    assert.ok(!shortReplyOf(c2, c2).includes("unknown"))
    await spawn(fake, { subagentType: "Plan", model: "opus", fork: true }, { model: "parent-model", agentId: "c3" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "c3", handover: "b", summary: "s" })
    assert.match(shortReplyOf(fake.store.get("child:c3") as ChildRecord, fake.store.get("child:c3") as ChildRecord), /\(recorded: no override\)/)
    // Reload without spawn metadata stays unknown and honest.
    const reload = makeFake()
    setup(reload)
    reload.agents = [{ id: "c4", type: "general-purpose", status: "running" }]
    await toolCall(reload, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "c4", handover: "b", summary: "s" })
    assert.match(shortReplyOf(reload.store.get("child:c4") as ChildRecord), /\(recorded: unknown, use predecessor spawn params\)/)
  })

  it("handles denied/malformed spawns, teammates, and legacy records without enabling handovers", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    assert.deepEqual((await spawn(fake, { subagentType: "Explore", model: "opus" }, { deny: "nope" })).result, { deny: "nope" })
    assert.equal(fake.store.get("spawn:a1"), undefined)
    assert.deepEqual((await spawn(fake, { subagentType: 42, model: 7 }, { model: "m", agentId: "" })).result, { model: "m", agentId: "" })
    fake.agents = [{ id: "mate", type: "teammate", status: "running" }]
    await spawn(fake, { subagentType: "mate" }, { model: "m", agentId: "mate" })
    assert.match(String((await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "mate", handover: "x", summary: "s" })).deny), /teammate/)
    // Legacy record without provenance still locks and reads honestly.
    const legacy = makeFake()
    setup(legacy)
    legacy.store.set("child:old", { handover: "old body", summary: "s", agentId: "old", shortReply: "Context handover (incomplete): s", closed: true, storedAt: 1 })
    legacy.agents = childAgents("old")
    assert.match(String((await toolCall(legacy, { tool: "Bash", tool_use_id: "t1", agentId: "old" })).deny), /locked after a context handover/)
    assert.match(String((await toolCall(legacy, { tool: READ_FULL, tool_use_id: "r1", childId: "old" })).result), /\(recorded: unknown, use predecessor spawn params\)/)
    // Spawn after closure persists standalone metadata without overwriting the closed handover.
    const after = makeFake()
    setup(after)
    after.agents = childAgents("a1")
    await toolCall(after, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "a1", handover: "first", summary: "s" })
    await spawn(after, { subagentType: "Other", model: "other" }, { model: "m", agentId: "a1" })
    assert.equal((after.store.get("child:a1") as ChildRecord).handover, "first")
    assert.equal((after.store.get("child:a1") as ChildRecord).agentType, undefined)
    const spawnA1 = after.store.get("spawn:a1") as Record<string, unknown>
    assert.equal(spawnA1.agentType, "Other")
    assert.equal(spawnA1.modelOverride, "other")
    assert.equal(spawnA1.originAgentId, "a1")
    assert.equal(spawnA1.generation, 1)
    assert.equal(typeof spawnA1.storedAt, "number")
    const mergedRead = String((await toolCall(after, { tool: READ_FULL, tool_use_id: "r1", childId: "a1" })).result)
    assert.match(mergedRead, /same agent type \(recorded: Other\)/)
    assert.match(mergedRead, /generation 1/)
  })

  it("falls back to SubagentStart type without inventing an override", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a9")
    const hook = only(fake, "classic.SubagentStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await hook(fake.$, { agent_id: "a9", agent_type: "Explore" }, async () => ({}))
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "a9", handover: "b", summary: "s" })
    const stored = fake.store.get("child:a9") as ChildRecord
    assert.equal(stored.agentType, "Explore")
    assert.equal(stored.modelOverride, undefined)
    assert.match(shortReplyOf(stored, stored), /same agent type \(recorded: Explore\)/)
    assert.match(shortReplyOf(stored, stored), /same model override \(recorded: unknown, use predecessor spawn params\)/)
  })

  it("preserves spawn lineage when SubagentStart fills a missing type", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "g1", type: "general-purpose", status: "running" }]
    await spawn(fake, { subagentType: "general-purpose", prompt: "origin task" }, { model: "m", agentId: "g1" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "g1", handover: "body", summary: "s" })
    fake.agents = [...fake.agents, { id: "g2", type: "general-purpose", status: "running" }]
    // Spawn without a type but with a successor marker: lineage observed, type missing.
    await spawn(fake, { prompt: `${buildSuccessorMarker("g1")} go` }, { model: "m", agentId: "g2" })
    const hook = only(fake, "classic.SubagentStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await hook(fake.$, { agent_id: "g2", agent_type: "Explore" }, async () => ({}))
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "g2", handover: "body", summary: "s" })
    const stored = fake.store.get("child:g2") as ChildRecord
    assert.equal(stored.agentType, "Explore")
    assert.equal(stored.predecessorAgentId, "g1")
    assert.equal(stored.originAgentId, "g1")
    assert.equal(stored.generation, 2)
    assert.equal(stored.modelOverride, null)
  })

  it("merges record and spawn provenance with record fields winning", () => {
    assert.deepEqual(
      mergeProvenance({ agentType: "Record" }, { agentType: "Spawn", predecessorAgentId: "p", originAgentId: "o", generation: 2 }),
      { agentType: "Record", predecessorAgentId: "p", originAgentId: "o", generation: 2 },
    )
    assert.deepEqual(mergeProvenance(undefined, { generation: 1 }), { generation: 1 })
    assert.equal(mergeProvenance(undefined, undefined), undefined)
    assert.equal(mergeProvenance({ agentType: 42 } as unknown as { agentType: string }, undefined), undefined)
  })

  it("survives a real re-registration with the same store and keeps absence unknown", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "r1", type: "general-purpose", status: "running" }, { id: "r2", type: "general-purpose", status: "running" }]
    await spawn(fake, { subagentType: "Explore", model: "opus" }, { model: "resolved", agentId: "r1" })
    const spawnR1 = fake.store.get("spawn:r1") as Record<string, unknown>
    assert.equal(spawnR1.agentType, "Explore")
    assert.equal(spawnR1.modelOverride, "opus")
    assert.equal(spawnR1.originAgentId, "r1")
    assert.equal(spawnR1.generation, 1)
    assert.equal(typeof spawnR1.storedAt, "number")
    // New registration sharing the same store content: persisted metadata is found.
    const reloaded = makeFake()
    for (const [key, value] of fake.store) reloaded.store.set(key, value)
    reloaded.agents = fake.agents
    setup(reloaded)
    await toolCall(reloaded, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "r1", handover: "b", summary: "s" })
    assert.equal((reloaded.store.get("child:r1") as ChildRecord).agentType, "Explore")
    assert.equal((reloaded.store.get("child:r1") as ChildRecord).modelOverride, "opus")
    // A child with no spawn entry stays honestly unknown after the same reload.
    await toolCall(reloaded, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "r2", handover: "b", summary: "s" })
    assert.equal((reloaded.store.get("child:r2") as ChildRecord).agentType, undefined)
    assert.match(shortReplyOf(reloaded.store.get("child:r2") as ChildRecord), /\(recorded: unknown, use predecessor spawn params\)/)
  })

  it("degrades honestly when spawn persistence fails, preserving the spawn result", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "w1", type: "general-purpose", status: "running" }]
    fake.writeFailKeys.add("spawn:w1")
    const { result } = await spawn(fake, { subagentType: "Explore", model: "opus" }, { model: "resolved", agentId: "w1" })
    assert.deepEqual(result, { model: "resolved", agentId: "w1" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "w1", handover: "b", summary: "s" })
    // Write failed but in-memory provenance still serves this session's handover.
    assert.equal((fake.store.get("child:w1") as ChildRecord).agentType, "Explore")
    // After a reload (memory lost, store write failed) the record stays unknown.
    const reloaded = makeFake()
    setup(reloaded)
    reloaded.agents = [{ id: "w1", type: "general-purpose", status: "running" }]
    await toolCall(reloaded, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "w1", handover: "b", summary: "s" })
    assert.match(shortReplyOf(reloaded.store.get("child:w1") as ChildRecord), /\(recorded: unknown, use predecessor spawn params\)/)
    // A spawn-meta read outage at handover time leaves the retention scan
    // incomplete, so the write is refused explicitly (retryable): nothing is
    // stored and the child is not locked. Clearing the outage and retrying
    // the same call then succeeds with the persisted provenance.
    const outage = makeFake()
    setup(outage)
    outage.agents = [{ id: "w2", type: "general-purpose", status: "running" }]
    outage.store.set("spawn:w2", { agentType: "Explore", modelOverride: "opus" })
    outage.readFailKeys.add("spawn:w2")
    const done = await toolCall(outage, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "w2", handover: "b", summary: "s" })
    assert.equal(done.result, undefined)
    assert.match(String(done.deny), /storage budget refuses the write/)
    assert.match(String(done.deny), /Retry the same call/)
    assert.match(String(done.deny), /nothing was stored and the child is not locked/)
    assert.equal(outage.store.get("child:w2"), undefined)
    // No lock was taken: an ordinary tool still passes through to next.
    const passthrough = await toolCall(outage, { tool: "Bash", tool_use_id: "t2", agentId: "w2" })
    assert.match(String(passthrough.result), /^passed:Bash$/)
    outage.readFailKeys.delete("spawn:w2")
    const retried = await toolCall(outage, { tool: HANDOVER_FULL, tool_use_id: "t3", agentId: "w2", handover: "b", summary: "s" })
    assert.match(String(retried.result), /same agent type \(recorded: Explore\)/)
    assert.match(String(retried.result), /same model override \(recorded: opus\)/)
  })

  it("tolerates malformed provenance on stored records without throwing", async () => {
    const fake = makeFake()
    setup(fake)
    fake.store.set("child:bad", { handover: "b", summary: "s", agentId: "bad", shortReply: "Context handover (incomplete): s", closed: true, storedAt: 1, agentType: 42, modelOverride: 7 })
    fake.agents = childAgents("bad")
    const denied = await toolCall(fake, { tool: "Bash", tool_use_id: "t1", agentId: "bad" })
    assert.match(String(denied.deny), /locked after a context handover/)
    const read = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "bad" })
    assert.match(String(read.result), /\(recorded: unknown, use predecessor spawn params\)/)
  })
})

describe("claude short reply and summary rule", () => {
  it("requires the exact read-before-decision sentence and provenance readback", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const done = await handOver(fake, "a1", "body text")
    const text = String(done.result)
    assert.ok(text.includes(READ_BEFORE_DECISION))
    assert.equal(READ_BEFORE_DECISION, "Read the handover before replying to the user or making any decision about the task.")
    assert.match(text, /start a successor of the same agent type .* with the same model override/)
    assert.match(text, /same agent type \(recorded: unknown, use predecessor spawn params\)/)
    assert.match(text, /same model override \(recorded: unknown, use predecessor spawn params\)/)
    const direct = buildChildShortReply("s", "a1", { agentType: "Explore", modelOverride: "opus" })
    assert.match(direct, /\(recorded: Explore\)/)
    assert.match(direct, /\(recorded: opus\)/)
    const none = buildChildShortReply("s", "a1", { agentType: "Explore", modelOverride: null })
    assert.match(none, /\(recorded: no override\)/)
    assert.ok(!none.includes("(recorded: unknown"))
  })

  it("adds a Claude-only pending-decisions summary rule without touching shared text", async () => {
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes('User decisions pending: none'))
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes('User decisions pending: <list>'))
    assert.ok(!CHILD_HANDOVER_DESCRIPTION.includes('never fabricate'))
    assert.ok(!HANDOVER_SECTIONS.includes('User decisions pending'))
    // Code never synthesizes a pending-none line for missing/legacy summaries:
    // the compact view reports an honest unknown with a full:true pointer.
    const legacy = makeFake()
    setup(legacy)
    legacy.store.set("child:old", { handover: "old body", summary: "", agentId: "old", shortReply: "Context handover (incomplete): handover stored.", closed: true, storedAt: 1 })
    legacy.agents = childAgents("old")
    const read = await toolCall(legacy, { tool: READ_FULL, tool_use_id: "r1", childId: "old" })
    assert.match(String(read.result), /User decisions pending: unknown \(no pending line in summary; request full:true to check\)/)
    assert.ok(!String(read.result).includes('User decisions pending: none'))
    const pending = makeFake()
    setup(pending)
    pending.store.set("child:p1", { handover: "6. Prioritized next steps\n1. do x\n", summary: "did x\nUser decisions pending: need API choice", agentId: "p1", shortReply: "Context handover (incomplete): did x", closed: true, storedAt: 1 })
    const pendingRead = await toolCall(pending, { tool: READ_FULL, tool_use_id: "r2", childId: "p1" })
    assert.match(String(pendingRead.result), /User decisions pending: need API choice/)
    // Inline single-line marker: pending content is not dropped.
    const inline = makeFake()
    setup(inline)
    inline.store.set("child:i1", { handover: "6. Prioritized next steps\n1. do x\n", summary: "did work; User decisions pending: need API choice", agentId: "i1", shortReply: "Context handover (incomplete): did work", closed: true, storedAt: 1 })
    assert.match(String((await toolCall(inline, { tool: READ_FULL, tool_use_id: "r1", childId: "i1" })).result), /User decisions pending: need API choice/)
    // List continuation under a bare marker: items joined, never invented.
    const listed = makeFake()
    setup(listed)
    listed.store.set("child:l1", { handover: "6. Prioritized next steps\n1. do x\n", summary: "did work\nUser decisions pending:\n- API choice\n- deadline", agentId: "l1", shortReply: "Context handover (incomplete): did work", closed: true, storedAt: 1 })
    const listedRead = String((await toolCall(listed, { tool: READ_FULL, tool_use_id: "r1", childId: "l1" })).result)
    assert.ok(listedRead.includes("API choice"))
    assert.ok(listedRead.includes("deadline"))
    // Hybrid head plus following lines: all preserved, none dropped.
    const hybrid = makeFake()
    setup(hybrid)
    hybrid.store.set("child:h1", { handover: "6. Prioritized next steps\n1. do x\n", summary: "did work\nUser decisions pending: need API choice\n- deadline\n- owner", agentId: "h1", shortReply: "Context handover (incomplete): did work", closed: true, storedAt: 1 })
    const hybridRead = String((await toolCall(hybrid, { tool: READ_FULL, tool_use_id: "r1", childId: "h1" })).result)
    assert.ok(hybridRead.includes("need API choice"))
    assert.ok(hybridRead.includes("deadline"))
    assert.ok(hybridRead.includes("owner"))
  })
})

describe("diagnostics stage boundaries and reload provenance", () => {
  it("derives stage from the last usage via softStage, unknown only when missing", async () => {
    const fake = makeFake({ soft: 1000 })
    setup(fake)
    fake.agents = childAgents("a1")
    const cases: Array<{ total: number; stage: string }> = [
      { total: 999, stage: "ok" },
      { total: 1000, stage: "warn1" },
      { total: 1100, stage: "warn2" },
      { total: 1200, stage: "warn3" },
    ]
    for (const { total, stage } of cases) {
      const id = `s-${total}`
      fake.agents = [...fake.agents, { id, type: "general-purpose", status: "running" }]
      await runStep(fake, { agentId: id }, { input_tokens: total, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
      await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: `t-${total}`, agentId: id, handover: "b", summary: "s" })
      assert.equal((fake.store.get(`child:${id}`) as ChildRecord).diag?.stage, stage)
    }
    const reload = makeFake({ soft: 1000 })
    setup(reload)
    reload.agents = childAgents("z1")
    await toolCall(reload, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "z1", handover: "b", summary: "s" })
    assert.equal((reload.store.get("child:z1") as ChildRecord).diag?.stage, "unknown")
  })

  it("keeps reason independent of stage after nudges and invalid usage", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.deepEqual((await batch(fake, { agent_id: "a1", session_id: "s" })).additionalContext, [buildClaudeChildNudge("warn3")])
    await runStep(fake, { agentId: "a1", turnId: "t2" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "after prior nudge below limit")
    const stored = fake.store.get("child:a1") as ChildRecord
    assert.equal(stored.diag?.reason, "nudged")
    assert.equal(stored.diag?.stage, "ok")
    const second = makeFake({ soft: 100 })
    setup(second)
    second.agents = childAgents("b1")
    await runStep(second, { agentId: "b1", turnId: "t1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.deepEqual((await batch(second, { agent_id: "b1", session_id: "s" })).additionalContext, [buildClaudeChildNudge("warn3")])
    await runStep(second, { agentId: "b1", turnId: "t2" }, null)
    await toolCall(second, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "b1", handover: "invalid after nudge", summary: "s" })
    assert.equal((second.store.get("child:b1") as ChildRecord).diag?.reason, "nudged")
    assert.equal((second.store.get("child:b1") as ChildRecord).diag?.stage, "unknown")
  })
})

describe("handback delivery contract", () => {
  it("addresses the stored-result instruction to the child with the retained short reply", async () => {
    const fake = makeFake()
    setup(fake)
    const done = await handOver(fake, "a1", "verbatim body")
    const text = String(done.result)
    const stored = fake.store.get("child:a1") as ChildRecord
    assert.match(text, /^Handover stored\. Call SubagentHandback now/)
    assert.match(text, /The adapter forwards your SubagentHandback message carrying the stored short reply below/)
    assert.match(text, /observed only through the tool result/)
    assert.match(text, /last resort only when the SubagentHandback tool is absent/)
    assert.ok(text.includes(shortReplyOf(stored)))
    assert.equal(buildHandoverStoredInstruction(shortReplyOf(stored)), text)
  })

  it("mandates handback-then-stop in child guidance with absent-tool-only plain text", async () => {
    assert.match(CHILD_HANDOVER_DESCRIPTION, /call SubagentHandback with the short reply/)
    assert.match(CHILD_HANDOVER_DESCRIPTION, /plain text is a last resort only when the SubagentHandback tool is absent/)
    assert.match(CHILD_HANDOVER_DESCRIPTION, /plain-text final may not reach your parent/)
    assert.match(buildClaudeChildIntro(), /then deliver via SubagentHandback and stop/)
    assert.match(buildClaudeChildNudge("warn1"), /then deliver via SubagentHandback and stop/)
  })

  it("corrects a skipped same-turn handback carrying the short reply", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "body")
    const stored = fake.store.get("child:a1") as ChildRecord
    const corrected = await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: shortReplyOf(stored, stored) })
    assert.match(String(corrected.block), /Call SubagentHandback now/)
    assert.ok(String(corrected.block).includes(shortReplyOf(stored, stored)))
    assert.equal((await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: stored.shortReply })).block, undefined)
  })

  it("corrects a skipped legacy handback carrying the locked reply", async () => {
    const fake = makeFake()
    setup(fake)
    fake.store.set("child:old", { handover: "old body", summary: "s", agentId: "old", shortReply: "Context handover (incomplete): s", closed: true, storedAt: 1 })
    fake.agents = childAgents("old")
    const corrected = await stopHook(fake, { agent_id: "old", stop_hook_active: false, last_assistant_message: "Context handover (incomplete): s" })
    assert.match(String(corrected.block), /Call SubagentHandback now/)
    assert.match(String(corrected.block), /locked after a context handover/)
  })

  it("accepts any closing after successful same-turn delivery and persists yes", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "body")
    await toolCall(fake, { tool: "SubagentHandback", agentId: "a1", message: "report" })
    assert.equal((fake.store.get("child:a1") as ChildRecord).handbackDelivered, true)
    for (const closing of ["", "different closing text"]) {
      assert.deepEqual(await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: closing }), { agent_id: "a1", stop_hook_active: false, last_assistant_message: closing })
    }
    const read = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "a1" })
    assert.match(String(read.result), /handback-delivered=yes/)
  })

  it("tolerates a persist outage on delivery without breaking the native result", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(fake, "a1", "body")
    fake.writeFailKeys.add("child:a1")
    const outcome = await toolCall(fake, { tool: "SubagentHandback", agentId: "a1", message: "report" }, async () => ({ result: "native-ok" }))
    assert.equal(outcome.result, "native-ok")
    // Stored status may stay stale (false) after a persist outage even though
    // delivery succeeded; read diagnostics reflect the stored value.
    assert.equal((fake.store.get("child:a1") as ChildRecord).handbackDelivered, false)
    assert.deepEqual(await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: "other" }), { agent_id: "a1", stop_hook_active: false, last_assistant_message: "other" })
  })

  it("shows no before delivery and unknown for legacy records", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "a1", "fresh body")
    assert.equal(formatHandbackDelivered((fake.store.get("child:a1") as ChildRecord).handbackDelivered), "Handback delivered: no")
    assert.match(String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "a1" })).result), /handback-delivered=no/)
    fake.store.set("child:legacy", { handover: "legacy body", summary: "s", agentId: "legacy", shortReply: "Context handover (incomplete): s", closed: true, storedAt: 1 })
    assert.match(String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", childId: "legacy" })).result), /handback-delivered=unknown/)
    assert.equal(formatHandbackDelivered(undefined), "Handback delivered: unknown")
    assert.equal(formatHandbackDelivered(false), "Handback delivered: no")
    assert.equal(formatHandbackDelivered(true), "Handback delivered: yes")
  })

  it("keeps delivered yes across reload via the store", async () => {
    const first = makeFake()
    setup(first)
    first.agents = childAgents("a1")
    await runStep(first, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await handOver(first, "a1", "reload body")
    await toolCall(first, { tool: "SubagentHandback", agentId: "a1", message: "report" })
    const second = makeFake()
    second.store.set("child:a1", first.store.get("child:a1"))
    setup(second)
    assert.match(String((await toolCall(second, { tool: READ_FULL, tool_use_id: "r1", childId: "a1" })).result), /handback-delivered=yes/)
  })

  it("serves reference readback: original once, handover once, marker pointer", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "c1", type: "general-purpose", status: "running" }]
    const body = "1. Original instructions\n2. Completed work\n6. Prioritized next steps\n1. Read the next file\n2. Build the table\n"
    await runStep(fake, { agentId: "c1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "c1", handover: body, summary: "s" })
    // Compact default withholds the full texts; explicit full:true serves reference.
    const compact = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r0", childId: "c1" })).result)
    assert.ok(!compact.includes(body))
    assert.match(compact, /Compact view: full original task and handover withheld/)
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "c1", full: true })).result)
    assert.match(read, /VERBATIM, do not paraphrase/)
    assert.match(read, /Prioritized next steps/)
    assert.match(read, /same agent type \(recorded: unknown/)
    assert.match(read, /Chain: generation unknown/)
    assert.match(read, /Seed size:/)
    assert.match(read, /Successor pointer/)
    assert.match(read, /spawn with this prompt VERBATIM/)
    assert.match(read, /auto-context-handover:continue child:c1/)
    assert.match(read, /you may append redirection/)
    assert.ok(!read.includes("\nMarker: "))
    // The full handover appears exactly once, byte-for-byte inside the
    // delimited VERBATIM block (no doubled raw copy outside the block).
    const expectedBlock = `--- handover \(VERBATIM, do not paraphrase\) ---\n${body}\n--- end of handover ---`
    assert.ok(read.includes(`--- handover (VERBATIM, do not paraphrase) ---\n${body}\n--- end of handover ---`))
    assert.equal(read.split(body).length - 1, 1)
    assert.ok(!read.includes("paste verbatim"))
    assert.ok(!read.includes("successor seed (paste verbatim)"))
  })

  it("formats seed provenance as clean labels for known, absent, and unknown overrides", () => {
    const cases = [
      { provenance: { agentType: "Explore", modelOverride: "opus" }, expected: "agent type: Explore; model override: opus" },
      { provenance: { agentType: "Explore", modelOverride: null }, expected: "agent type: Explore; model override: no override" },
      { provenance: undefined, expected: "agent type: unknown - use predecessor spawn params; model override: unknown - use predecessor spawn params" },
    ]
    for (const { provenance, expected } of cases) {
      const seed = buildClaudeSuccessorSeed("c1", "body", provenance)
      assert.equal(seed.split("\n")[0], `Continuing work handed over from subagent c1 (${expected}).`)
      assert.match(seed, /Original task: reference only/)
      assert.match(seed, new RegExp(`read_handover\\(\\{"childId":"c1","full":true\\}\\)`))
      assert.ok(!seed.includes("[paste the original task prompt here]"))
      assert.ok(!seed.includes("section 6"))
      assert.match(seed, /--- handover from subagent c1 \(VERBATIM, do not paraphrase\) ---/)
      assert.match(seed, /must not be repeated/)
      assert.match(seed, /trusted unless marked unverified/)
      assert.match(seed, /Prioritized next steps/)
      assert.match(seed, /SubagentHandback/)
    }
  })

  it("keeps the root fallback context-only with read-before-message and marker rules", async () => {
    const intro = buildClaudeRootIntro()
    assert.ok(intro.includes('When a subagent returns a "Context handover (incomplete):" reply, read the handover'))
    assert.ok(intro.includes('compact parent view by default'))
    assert.ok(intro.includes('pass full:true for the full original task and handover verbatim'))
    assert.ok(intro.includes('a stored handover counts as a reply. Never SendMessage'))
    assert.match(intro, /call mcp__auto-context-handover__read_handover with its child id BEFORE messaging or resuming/)
    assert.match(intro, /Never SendMessage to or resume a handed-over subagent/)
    assert.match(intro, /short successor prompt VERBATIM/)
    assert.match(intro, /do not paste the handover or original task/)
    assert.match(intro, /root native compaction is unchanged/)
  })
})

describe("reference lineage: marker, originals, generations", () => {
  const spawn = async (
    fake: Fake,
    event: Record<string, unknown>,
    answer: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const hook = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    return hook(fake.$, event, async (input) => ({ ...answer }))
  }

  const handoverBody = (steps: string[]): string =>
    `1. Original instructions\n2. Completed work\n3. In-progress work\n4. Key snippets\n5. Negative knowledge\n6. Prioritized next steps\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`

  it("parses only a leading marker and distinguishes malformed reserved prefixes", () => {
    assert.equal(parseSuccessorMarker(`[${SUCCESSOR_MARKER_TAG} child:abc123] do more`), "abc123")
    assert.equal(parseSuccessorMarker(`  [${SUCCESSOR_MARKER_TAG} child:a-b_9] suffix`), "a-b_9")
    assert.equal(parseSuccessorMarker(`[${SUCCESSOR_MARKER_TAG} child:${"x".repeat(200)}]`), "x".repeat(200))
    const longPrompt = `[${SUCCESSOR_MARKER_TAG} child:abc]${"x".repeat(300000)}`
    assert.equal(parseSuccessorMarker(longPrompt), "abc")
    assert.equal(buildSuccessorMarker("a1"), `[${SUCCESSOR_MARKER_TAG} child:a1]`)
    // Quoted, mid-text, or otherwise non-leading occurrences are absent.
    for (const absent of [undefined, null, 42, "", "no marker here", `do work then [${SUCCESSOR_MARKER_TAG} child:a1]`, `"[${SUCCESSOR_MARKER_TAG} child:a1]"`, "[other:continue child:a1]", "x".repeat(200001)]) {
      assert.equal(parseSuccessorMarker(absent), undefined)
      assert.equal(classifySuccessorMarker(absent).status, "absent")
    }
    // Broken reserved prefixes are malformed, never valid ids or new origins.
    for (const malformed of [`[${SUCCESSOR_MARKER_TAG} child:]`, `[${SUCCESSOR_MARKER_TAG} child:bad id]`, "[auto-context-handover:continue]", "[auto-context-handover:continue child:]", `[${SUCCESSOR_MARKER_TAG}]`]) {
      assert.equal(parseSuccessorMarker(malformed), undefined)
      assert.equal(classifySuccessorMarker(malformed).status, "malformed")
    }
    assert.equal(classifySuccessorMarker(`[${SUCCESSOR_MARKER_TAG} child:ok]`).predecessor, "ok")
  })

  it("stores the original once for origins and inherits across two generations without duplication", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "g1", type: "general-purpose", status: "running" }]
    const original = "Review the plugin read-only: README first, then every file."
    await spawn(fake, { subagentType: "general-purpose", prompt: original }, { model: "m", agentId: "g1" })
    const storedOriginal = fake.store.get(originalRecordKey("g1")) as OriginalRecord
    assert.equal(storedOriginal.prompt, original)
    assert.equal(storedOriginal.originAgentId, "g1")
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "g1", handover: handoverBody(["read a", "read b"]), summary: "gen1" })
    const gen1 = fake.store.get("child:g1") as ChildRecord
    assert.equal(gen1.generation, 1)
    assert.equal(gen1.originAgentId, "g1")
    assert.equal(gen1.predecessorAgentId, undefined)
    // Successor spawns with only the short marker plus redirection.
    fake.agents = [...fake.agents, { id: "g2", type: "general-purpose", status: "running" }]
    await spawn(fake, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("g1")} focus on risks` }, { model: "m", agentId: "g2" })
    // No duplicate original stored for the successor.
    assert.equal(fake.store.get(originalRecordKey("g2")), undefined)
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "g2", handover: handoverBody(["read c"]), summary: "gen2" })
    const gen2 = fake.store.get("child:g2") as ChildRecord
    assert.equal(gen2.generation, 2)
    assert.equal(gen2.predecessorAgentId, "g1")
    assert.equal(gen2.originAgentId, "g1")
    // Readback supplies the original verbatim once and the handover verbatim once (explicit full:true; compact withholds).
    const compactGen2 = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r0", childId: "g2" })).result)
    assert.ok(!compactGen2.includes(original))
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "g2", full: true })).result)
    assert.match(read, /generation 2/)
    assert.match(read, /predecessor g1/)
    assert.match(read, /\(origin: g1\)/)
    assert.match(read, /next steps: 1/)
    assert.equal(read.split(original).length - 1, 1)
    assert.equal(read.split(handoverBody(["read c"])).length - 1, 1)
    assert.match(read, /auto-context-handover:continue child:g2/)
  })

  it("keeps missing and malformed predecessors honest without resetting the origin", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "orphan", type: "general-purpose", status: "running" }]
    await spawn(fake, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("ghost")} continue` }, { model: "m", agentId: "orphan" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "orphan", handover: handoverBody(["x"]), summary: "s" })
    const stored = fake.store.get("child:orphan") as ChildRecord
    assert.equal(stored.predecessorAgentId, "ghost")
    assert.equal(stored.originAgentId, undefined)
    assert.equal(stored.generation, undefined)
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "orphan" })).result)
    assert.match(read, /generation unknown/)
    assert.match(read, /unknown legacy origin|has no stored original/)
    assert.ok(!read.includes("use predecessor spawn params") || read.includes("recorded: unknown"))
    assert.ok(!read.includes("(origin: ghost)"))
    // Malformed marker text is neither a successor nor a new origin: unknown lineage, no stored original.
    fake.agents = [...fake.agents, { id: "fresh", type: "general-purpose", status: "running" }]
    await spawn(fake, { subagentType: "general-purpose", prompt: "[auto-context-handover:continue child:] do work" }, { model: "m", agentId: "fresh" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "fresh", handover: handoverBody(["y"]), summary: "s" })
    const freshStored = fake.store.get("child:fresh") as ChildRecord
    assert.equal(freshStored.generation, undefined)
    assert.equal(freshStored.originAgentId, undefined)
    assert.equal(freshStored.predecessorAgentId, undefined)
    assert.equal(fake.store.get(originalRecordKey("fresh")), undefined)
    const freshRead = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r3", childId: "fresh" })).result)
    assert.match(freshRead, /generation unknown/)
  })

  it("persists spawn and original metadata for a handover stored inside next (gen1 race)", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "race1", type: "general-purpose", status: "running" }]
    const original = "Review the plugin read-only: README first, then every file."
    const hook = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    const result = await hook(fake.$, { subagentType: "general-purpose", prompt: original }, async () => {
      // The child runs and hands over before the spawn result returns its id.
      await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "race1", handover: handoverBody(["read a"]), summary: "gen1" })
      return { model: "m", agentId: "race1" }
    })
    assert.deepEqual(result, { model: "m", agentId: "race1" })
    const stored = fake.store.get("child:race1") as ChildRecord
    assert.equal(stored.handover, handoverBody(["read a"]))
    // Standalone metadata persisted despite the already-closed record.
    const spawnRace1 = fake.store.get("spawn:race1") as Record<string, unknown>
    assert.equal(spawnRace1.agentType, "general-purpose")
    assert.equal(spawnRace1.modelOverride, null)
    assert.equal(spawnRace1.originAgentId, "race1")
    assert.equal(spawnRace1.generation, 1)
    assert.equal(typeof spawnRace1.storedAt, "number")
    const compactRace = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r0", childId: "race1" })).result)
    assert.ok(!compactRace.includes(original))
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "race1", full: true })).result)
    assert.match(read, /generation 1/)
    assert.match(read, /\(origin: race1\)/)
    assert.equal(read.split(original).length - 1, 1)
    assert.equal(read.split(handoverBody(["read a"])).length - 1, 1)
  })

  it("links a successor handed over inside next to its predecessor (gen2 race)", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "g1", type: "general-purpose", status: "running" }]
    const original = "origin task text"
    await spawn(fake, { subagentType: "general-purpose", prompt: original }, { model: "m", agentId: "g1" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "g1", handover: handoverBody(["read a"]), summary: "gen1" })
    fake.agents = [...fake.agents, { id: "g2", type: "general-purpose", status: "running" }]
    const hook = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await hook(fake.$, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("g1")} focus on risks` }, async () => {
      await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "g2", handover: handoverBody(["read b"]), summary: "gen2" })
      return { model: "m", agentId: "g2" }
    })
    // The handover ran before the spawn persistence, so the record itself lacks lineage.
    assert.equal((fake.store.get("child:g2") as ChildRecord).predecessorAgentId, undefined)
    const compactRace2 = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r0", childId: "g2" })).result)
    assert.ok(!compactRace2.includes(original))
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "g2", full: true })).result)
    assert.match(read, /generation 2/)
    assert.match(read, /predecessor g1/)
    assert.match(read, /\(origin: g1\)/)
    assert.equal(read.split(original).length - 1, 1)
    assert.equal(read.split(handoverBody(["read b"])).length - 1, 1)
  })

  it("reports an explicit capture failure when the original write is quota-rejected", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "q1", type: "general-purpose", status: "running" }]
    const backing = fake.$.store
    fake.$ = {
      ...fake.$,
      store: {
        get: backing.get.bind(backing),
        delete: backing.delete.bind(backing),
        keys: backing.keys.bind(backing),
        set: async (key: string, value: unknown) => {
          if (key === originalRecordKey("q1")) throw new Error("quota exceeded: plugin storage budget exhausted")
          return backing.set(key, value)
        },
      },
    } as Engine
    const hook = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    const result = await hook(fake.$, { subagentType: "Explore", prompt: "quota origin task" }, async () => ({ model: "m", agentId: "q1" }))
    assert.deepEqual(result, { model: "m", agentId: "q1" })
    // Bounded error text persists in spawn provenance when the small metadata write succeeds.
    const spawnMeta = fake.store.get("spawn:q1") as { originalCaptureError?: string }
    assert.match(String(spawnMeta?.originalCaptureError ?? ""), /quota exceeded/)
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "q1", handover: handoverBody(["a"]), summary: "s" })
    const compactQ = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r0", childId: "q1" })).result)
    assert.ok(!compactQ.includes("quota exceeded"))
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "q1", full: true })).result)
    assert.match(read, /original capture failed/)
    assert.match(read, /quota exceeded/)
    assert.match(read, /\(origin: q1\)/)
    // After a reload the persisted spawn error still reports the cause.
    const reloaded = makeFake()
    for (const [key, value] of fake.store) reloaded.store.set(key, value)
    setup(reloaded)
    const reread = String((await toolCall(reloaded, { tool: READ_FULL, tool_use_id: "r2", childId: "q1", full: true })).result)
    assert.match(reread, /original capture failed/)
    assert.match(reread, /quota exceeded/)
    // When every write fails, the readback degrades honestly without the cause.
    const doomed = makeFake()
    setup(doomed)
    doomed.agents = [{ id: "q9", type: "general-purpose", status: "running" }]
    const doomedBacking = doomed.$.store
    doomed.$ = {
      ...doomed.$,
      store: {
        get: doomedBacking.get.bind(doomedBacking),
        delete: doomedBacking.delete.bind(doomedBacking),
        set: async (key: string, value: unknown) => {
          if (key === originalRecordKey("q9") || key === "spawn:q9") throw new Error("quota exceeded")
          return doomedBacking.set(key, value)
        },
      },
    } as Engine
    const doomedHook = only(doomed, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await doomedHook(doomed.$, { subagentType: "Explore", prompt: "quota origin task" }, async () => ({ model: "m", agentId: "q9" }))
    doomed.$ = { ...doomed.$, store: doomedBacking } as Engine
    await toolCall(doomed, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "q9", handover: handoverBody(["a"]), summary: "s" })
    const doomedRead = String((await toolCall(doomed, { tool: READ_FULL, tool_use_id: "r1", childId: "q9", full: true })).result)
    assert.match(doomedRead, /has no stored original/)
  })

  it("serves successor-facing guidance, marker-prefix pointer, and payload-measured seed", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "c1", type: "general-purpose", status: "running" }]
    await spawn(fake, { subagentType: "general-purpose", prompt: "origin task" }, { model: "m", agentId: "c1" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "c1", handover: handoverBody(["do a"]), summary: "s" })
    const compactRef = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r0", childId: "c1" })).result)
    assert.ok(!compactRef.includes("origin task"))
    assert.match(compactRef, /Prioritized next steps \(excerpt/)
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "c1", full: true })).result)
    assert.match(read, /reference only/)
    assert.match(read, /must not be repeated/)
    assert.match(read, /trusted unless marked unverified/)
    assert.match(read, /preserve verification distinctions/)
    assert.match(read, /do not recast predecessor direct evidence as successor direct verification/)
    assert.match(read, /continue from 'Prioritized next steps'/i)
    assert.match(read, /SubagentHandback/)
    const pointer = buildSuccessorPointer("c1")
    assert.ok(pointer.startsWith(buildSuccessorMarker("c1")))
    assert.ok(pointer.includes(`read_handover({"childId":"c1","full":true})`))
    assert.ok(read.includes(pointer))
    assert.ok(read.indexOf(buildSuccessorMarker("c1")) < read.indexOf(`read_handover({"childId":"c1","full":true})`))
    assert.ok(!pointer.includes("You may append"))
    assert.ok(!pointer.includes("Spawn with"))
  })

  it("lets a successor read its predecessor while a locked child cannot read itself", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "p1", type: "general-purpose", status: "running" }]
    await spawn(fake, { subagentType: "general-purpose", prompt: "original task" }, { model: "m", agentId: "p1" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "p1", handover: handoverBody(["a"]), summary: "s" })
    fake.agents = [...fake.agents, { id: "p2", type: "general-purpose", status: "running" }]
    await spawn(fake, { subagentType: "general-purpose", prompt: buildSuccessorMarker("p1") }, { model: "m", agentId: "p2" })
    const pred = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", agentId: "p2", childId: "p1" })
    assert.match(String(pred.result), /Handover from subagent p1/)
    const self = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", agentId: "p1", childId: "p1" })
    assert.match(String(self.deny), /locked after a context handover/)
  })

  it("survives reload with persisted lineage and original, and degrades honestly on storage outage", async () => {
    const first = makeFake()
    setup(first)
    first.agents = [{ id: "r1", type: "general-purpose", status: "running" }]
    await spawn(first, { subagentType: "Explore", model: "opus", prompt: "origin prompt text" }, { model: "m", agentId: "r1" })
    await toolCall(first, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "r1", handover: handoverBody(["a", "b"]), summary: "s" })
    const second = makeFake()
    for (const [key, value] of first.store) second.store.set(key, value)
    second.agents = [{ id: "r2", type: "general-purpose", status: "running" }]
    setup(second)
    await spawn(second, { subagentType: "Explore", model: "opus", prompt: `${buildSuccessorMarker("r1")} go` }, { model: "m", agentId: "r2" })
    await toolCall(second, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "r2", handover: handoverBody(["c"]), summary: "s" })
    const gen2 = second.store.get("child:r2") as ChildRecord
    assert.equal(gen2.generation, 2)
    assert.equal(gen2.originAgentId, "r1")
    const read = String((await toolCall(second, { tool: READ_FULL, tool_use_id: "r1", childId: "r2", full: true })).result)
    assert.ok(read.includes("origin prompt text"))
    assert.match(read, /generation 2/)
    // Original read outage degrades honestly with quota wording, never fabricated.
    second.readFailKeys.add(originalRecordKey("r1"))
    const outage = String((await toolCall(second, { tool: READ_FULL, tool_use_id: "r2", childId: "r2", full: true })).result)
    assert.match(outage, /unknown/)
    assert.ok(!outage.includes("origin prompt text"))
  })

  it("never rewrites the model override across generations", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "m1", type: "general-purpose", status: "running" }]
    const { result, seen } = await (async () => {
      const hook = only(fake, "agent.spawn") as unknown as (
        $: Engine,
        event: Record<string, unknown>,
        next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
      ) => Promise<Record<string, unknown>>
      const seen: Array<Record<string, unknown>> = []
      const out = await hook(fake.$, { subagentType: "Explore", model: "opus", prompt: "orig" }, async (input) => {
        seen.push(input as Record<string, unknown>)
        return { model: "resolved-other", agentId: "m1" }
      })
      return { result: out, seen }
    })()
    assert.deepEqual(result, { model: "resolved-other", agentId: "m1" })
    assert.deepEqual(seen, [{ subagentType: "Explore", model: "opus", prompt: "orig" }])
    fake.agents = [...fake.agents, { id: "m2", type: "general-purpose", status: "running" }]
    await spawnFor(fake, { subagentType: "Explore", model: "opus", prompt: `${buildSuccessorMarker("m1")} go` }, { model: "resolved-other", agentId: "m2" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "m1", handover: handoverBody(["a"]), summary: "s" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "m2", handover: handoverBody(["b"]), summary: "s" })
    assert.equal((fake.store.get("child:m1") as ChildRecord).modelOverride, "opus")
    assert.equal((fake.store.get("child:m2") as ChildRecord).modelOverride, "opus")
    async function spawnFor(f: Fake, event: Record<string, unknown>, answer: Record<string, unknown>): Promise<void> {
      const hook = only(f, "agent.spawn") as unknown as (
        $: Engine,
        event: Record<string, unknown>,
        next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
      ) => Promise<Record<string, unknown>>
      await hook(f.$, event, async () => ({ ...answer }))
    }
  })
})

describe("next-step count, seed size, and generation lines", () => {
  it("counts steps by title across 6- and 7-section layouts, unknown when absent", () => {
    const six = "1. Original\n2. Done\n3. In-progress\n4. Snippets\n5. Negative\n6. Prioritized next steps\n1. do a\n2. do b\n"
    assert.equal(countNextSteps(six), 2)
    const seven = "1. Original\n2. Done\n3. In-progress\n4. Snippets\n5. Negative\n6. Extra\n7. Prioritized next steps\n1. only step\n"
    assert.equal(countNextSteps(seven), 1)
    assert.equal(countNextSteps("no headings here"), undefined)
    assert.equal(countNextSteps(""), undefined)
  })

  it("counts markdown, bullet, and short-final steps; unknown on ambiguity or truncation", () => {
    assert.equal(countNextSteps("## 6. Prioritized next steps\n1. do a\n2. do b\n"), 2)
    assert.equal(countNextSteps("**Prioritized next steps**\n- do a\n- do b\n"), 2)
    assert.equal(countNextSteps("6. **Prioritized next steps**\n1) do a\n"), 1)
    assert.equal(countNextSteps("# Prioritized next steps:\n1. do a\n"), 1)
    // A short final step still counts; it is never a section boundary.
    assert.equal(countNextSteps("6. Prioritized next steps\n1. Read the next file\n2. Fix\n"), 2)
    // Nested details do not double-count.
    assert.equal(countNextSteps("6. Prioritized next steps\n1. Do A\n   - detail\n   - more\n2. Do B\n"), 2)
    // A clear heading boundary stops the count cleanly.
    assert.equal(countNextSteps("6. Prioritized next steps\n1. Do A\n## Notes\n"), 1)
    // Ambiguous prose or an item after a boundary is unknown, not a partial count.
    assert.equal(countNextSteps("6. Prioritized next steps\n1. Do A\nSome prose\n2. Do B\n"), undefined)
    assert.equal(countNextSteps("6. Prioritized next steps\n1. Do A\n## Notes\n2. Do B\n"), undefined)
    // A heading with nothing after it is truncated.
    assert.equal(countNextSteps("6. Prioritized next steps\n"), undefined)
    assert.equal(countNextSteps("6. Prioritized next steps"), undefined)
  })

  it("matches the shared seedTooLarge boundary exactly", () => {
    for (const [estimate, soft] of [[51, 100], [500001, 1000000], [1, 1]] as Array<[number, number]>) {
      assert.equal(isSeedTooLarge(estimate, soft), seedTooLarge(estimate, soft))
      assert.equal(isSeedTooLarge(estimate, soft), sharedSeedTooLarge(estimate, soft))
    }
    assert.equal(isSeedTooLarge(50, 100), seedTooLarge(50, 100))
    assert.equal(isSeedTooLarge(50, 100), sharedSeedTooLarge(50, 100))
    assert.equal(estimateSeedTokens("abcd"), 1)
  })

  it("warns above 50% of soft and asks to compress finished notes", async () => {
    const fake = makeFake({ soft: 100 })
    setup(fake)
    fake.agents = childAgents("big")
    const big = `${"6. Prioritized next steps\n"}${Array.from({ length: 30 }, (_, i) => `${i + 1}. carry note number ${i} with padding text to grow the seed`).join("\n")}\n`
    await runStep(fake, { agentId: "big" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "big", handover: big, summary: "s" })
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "big" })).result)
    assert.match(read, /over 50%/)
    assert.match(read, /compress carried-over finished notes/)
    const excerptBody = big.split("\n").slice(1).join("\n").trim()
    assert.equal(read.split(excerptBody).length - 1, 1)
    assert.ok(!read.includes("6. Prioritized next steps"))
  })

  it("formats the generation line honestly for known and unknown lineage", () => {
    assert.match(buildGenerationLine({ agentId: "a", predecessorAgentId: "p", originAgentId: "o", generation: 3 }, 4), /generation 3/)
    assert.match(buildGenerationLine({ agentId: "a", predecessorAgentId: "p", originAgentId: "o", generation: 3 }, 4), /predecessor p/)
    assert.match(buildGenerationLine({ agentId: "a", predecessorAgentId: "p", originAgentId: "o", generation: 3 }, 4), /origin: o/)
    assert.match(buildGenerationLine({ agentId: "a", predecessorAgentId: "p", originAgentId: "o", generation: 3 }, 4), /next steps: 4/)
    assert.match(buildGenerationLine({ agentId: "a" }, undefined), /generation unknown/)
    assert.match(buildGenerationLine({ agentId: "a" }, undefined), /next steps: unknown/)
  })

  it("supports the actual template and report next-steps headings", () => {
    assert.equal(countNextSteps("6. Prioritized next steps for the successor session\n1. do a\n2. Fix\n"), 2)
    assert.equal(countNextSteps("7. Prioritized next steps for the successor\n1. only step\n"), 1)
    assert.equal(countNextSteps("## 6. Prioritized next steps for the successor session:\n1. do a\n"), 1)
    assert.equal(countNextSteps("**7. Prioritized next steps for the successor**\n- do a\n"), 1)
    assert.equal(countNextSteps("# Prioritized next steps for the successor session\n1. do a\n2. b\n"), 2)
  })
})

describe("pending corrections: pointer prefix, raced lineage, and prompt reuse", () => {
  const spawnFor = async (
    fake: Fake,
    event: Record<string, unknown>,
    answer: Record<string, unknown>,
  ): Promise<void> => {
    const hook = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await hook(fake.$, event, async () => ({ ...answer }))
  }

  const handoverBody = (steps: string[]): string =>
    `1. Original instructions\n2. Completed work\n3. In-progress work\n4. Key snippets\n5. Negative knowledge\n6. Prioritized next steps for the successor session\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`

  it("spawns from the exact readback pointer with appended redirection", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "e1", type: "general-purpose", status: "running" }]
    const original = "end to end origin task"
    await spawnFor(fake, { subagentType: "general-purpose", prompt: original }, { model: "m", agentId: "e1" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "e1", handover: handoverBody(["read a", "Fix"]), summary: "gen1" })
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "e1" })).result)
    const pointer = buildSuccessorPointer("e1")
    assert.ok(pointer.startsWith(buildSuccessorMarker("e1")))
    assert.ok(read.includes(pointer))
    // Parent pastes the exact pointer plus its own redirection.
    fake.agents = [...fake.agents, { id: "e2", type: "general-purpose", status: "running" }]
    await spawnFor(fake, { subagentType: "general-purpose", prompt: `${pointer} focus on risks` }, { model: "m", agentId: "e2" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "e2", handover: handoverBody(["read b"]), summary: "gen2" })
    const gen2 = fake.store.get("child:e2") as ChildRecord
    assert.equal(gen2.predecessorAgentId, "e1")
    assert.equal(gen2.originAgentId, "e1")
    assert.equal(gen2.generation, 2)
    // Third generation keeps the same original after a reload.
    const reloaded = makeFake()
    for (const [key, value] of fake.store) reloaded.store.set(key, value)
    reloaded.agents = [{ id: "e1", type: "general-purpose", status: "running" }, { id: "e2", type: "general-purpose", status: "running" }, { id: "e3", type: "general-purpose", status: "running" }]
    setup(reloaded)
    const reread = String((await toolCall(reloaded, { tool: READ_FULL, tool_use_id: "r2", childId: "e2", full: true })).result)
    assert.ok(reread.includes(buildSuccessorPointer("e2")))
    assert.equal(reread.split(original).length - 1, 1)
    await spawnFor(reloaded, { subagentType: "general-purpose", prompt: `${buildSuccessorPointer("e2")} keep going` }, { model: "m", agentId: "e3" })
    await toolCall(reloaded, { tool: HANDOVER_FULL, tool_use_id: "t3", agentId: "e3", handover: handoverBody(["read c"]), summary: "gen3" })
    const gen3 = reloaded.store.get("child:e3") as ChildRecord
    assert.equal(gen3.generation, 3)
    assert.equal(gen3.originAgentId, "e1")
    const read3 = String((await toolCall(reloaded, { tool: READ_FULL, tool_use_id: "r3", childId: "e3", full: true })).result)
    assert.equal(read3.split(original).length - 1, 1)
    assert.match(read3, /generation 3/)
  })

  it("inherits raced origin lineage for gen2/gen3 without linking running-only metadata", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "o1", type: "general-purpose", status: "running" }]
    const original = "raced origin task"
    const hook = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await hook(fake.$, { subagentType: "general-purpose", prompt: original }, async () => {
      await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "o1", handover: handoverBody(["read a"]) , summary: "gen1" })
      return { model: "m", agentId: "o1" }
    })
    // The raced record closed before spawn persistence, so it lacks lineage but the reader merges it.
    assert.equal((fake.store.get("child:o1") as ChildRecord).generation, undefined)
    assert.match(String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "o1" })).result), /generation 1/)
    fake.agents = [...fake.agents, { id: "o2", type: "general-purpose", status: "running" }]
    await spawnFor(fake, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("o1")} go` }, { model: "m", agentId: "o2" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "o2", handover: handoverBody(["read b"]), summary: "gen2" })
    const gen2 = fake.store.get("child:o2") as ChildRecord
    assert.equal(gen2.originAgentId, "o1")
    assert.equal(gen2.generation, 2)
    // Running-only spawn metadata without a stored handover never links.
    fake.agents = [...fake.agents, { id: "o3", type: "general-purpose", status: "running" }]
    await spawnFor(fake, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("running-only")} go` }, { model: "m", agentId: "o3" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t3", agentId: "o3", handover: handoverBody(["x"]), summary: "s" })
    assert.equal((fake.store.get("child:o3") as ChildRecord).originAgentId, undefined)
    // Reload: gen2 lineage and the original survive for gen3.
    const reloaded = makeFake()
    for (const [key, value] of fake.store) reloaded.store.set(key, value)
    reloaded.agents = [...fake.agents, { id: "o4", type: "general-purpose", status: "running" }]
    setup(reloaded)
    await spawnFor(reloaded, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("o2")} go` }, { model: "m", agentId: "o4" })
    await toolCall(reloaded, { tool: HANDOVER_FULL, tool_use_id: "t4", agentId: "o4", handover: handoverBody(["y"]), summary: "gen3" })
    const gen3 = reloaded.store.get("child:o4") as ChildRecord
    assert.equal(gen3.originAgentId, "o1")
    assert.equal(gen3.generation, 3)
    assert.equal(String((await toolCall(reloaded, { tool: READ_FULL, tool_use_id: "r4", childId: "o4", full: true })).result).split(original).length - 1, 1)
  })
})

describe("compact default, full:true, and successor auto-full", () => {
  const handoverBody = (steps: string[]): string =>
    `1. Original instructions\n2. Completed work\n3. In-progress work\n4. Key snippets\n5. Negative knowledge\n6. Prioritized next steps\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`

  it("withholds full texts by default and serves them once with full:true", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "k1", type: "general-purpose", status: "running" }]
    await toolCall(fake, { tool: READ_FULL, tool_use_id: "r0", childId: "k1" })
    const body = handoverBody(["do the thing"])
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "k1", handover: body, summary: "User decisions pending: none" })
    const compact = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "k1" })).result)
    assert.match(compact, /Handover from subagent k1/)
    assert.match(compact, /Diagnostics:/)
    assert.match(compact, /Baseline:/)
    assert.match(compact, /Chain:/)
    assert.match(compact, /Seed size:/)
    assert.match(compact, /User decisions pending: none/)
    assert.match(compact, /Prioritized next steps \(excerpt, continue here\):/)
    assert.match(compact, /Prioritized next steps \(excerpt, continue here\):\n1\. do the thing/)
    assert.ok(!compact.includes("6. Prioritized next steps"))
    assert.ok(compact.includes("do the thing"))
    assert.ok(!compact.includes("--- handover (VERBATIM"))
    assert.ok(!compact.includes("--- original task"))
    assert.match(compact, /Compact view: full original task and handover withheld/)
    const full = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", childId: "k1", full: true })).result)
    assert.match(full, /Full-access: explicit full:true request/)
    assert.ok(full.includes(body))
    assert.equal(full.split(body).length - 1, 1)
  })

  it("auto-serves full to the recorded successor while unrelated callers stay compact", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "s1", type: "general-purpose", status: "running" }]
    const spawn = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await spawn(fake.$, { subagentType: "general-purpose", prompt: "root origin" }, async () => ({ model: "m", agentId: "s1" }))
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "s1", handover: handoverBody(["first"]), summary: "s" })
    fake.agents = [...fake.agents, { id: "s2", type: "general-purpose", status: "running" }, { id: "other", type: "general-purpose", status: "running" }]
    await spawn(fake.$, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("s1")} go` }, async () => ({ model: "m", agentId: "s2" }))
    // Recorded successor (leading marker/stored predecessor link) receives full automatically.
    const succ = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", agentId: "s2", childId: "s1" })).result)
    assert.match(succ, /Full-access: caller s2 is the recorded successor/)
    assert.ok(succ.includes("root origin"))
    assert.ok(succ.includes(handoverBody(["first"])))
    // Unrelated live caller stays compact without auth failure.
    const parent = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", agentId: "other", childId: "s1" })).result)
    assert.ok(!parent.includes("root origin"))
    assert.ok(!parent.includes("--- handover (VERBATIM"))
    assert.match(parent, /Compact view/)
    // Open reader: parent with no calling loop id also reads compact.
    const open = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r3", childId: "s1" })).result)
    assert.ok(!open.includes("root origin"))
    assert.match(open, /Successor pointer/)
  })

  it("serves pointer-directed full:true reads before spawn return; unflagged unrelated reads stay compact", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "f1", type: "general-purpose", status: "running" }]
    const spawn = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await spawn(fake.$, { subagentType: "general-purpose", prompt: "fast origin" }, async () => ({ model: "m", agentId: "f1" }))
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "f1", handover: handoverBody(["a"]), summary: "s" })
    // The generated pointer always requests full:true.
    const pointer = buildSuccessorPointer("f1")
    assert.ok(pointer.includes(`read_handover({"childId":"f1","full":true})`))
    fake.agents = [...fake.agents, { id: "f2", type: "general-purpose", status: "running" }, { id: "other", type: "general-purpose", status: "running" }]
    let pointerDirected = ""
    await (only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>)(fake.$, { subagentType: "general-purpose", prompt: `${pointer} go` }, async () => {
      // Fast child follows the pointer exactly (full:true) before the spawn hook persists its predecessor link.
      pointerDirected = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "rx", agentId: "f2", childId: "f1", full: true })).result)
      return { model: "m", agentId: "f2" }
    })
    assert.match(pointerDirected, /Full-access: explicit full:true request/)
    assert.ok(pointerDirected.includes("fast origin"))
    // After persistence the recorded successor also auto-fulls without the flag.
    const after = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", agentId: "f2", childId: "f1" })).result)
    assert.match(after, /Full-access: caller f2 is the recorded successor/)
    assert.ok(after.includes("fast origin"))
    // An unrelated caller without the flag still receives the compact view.
    const unrelated = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", agentId: "other", childId: "f1" })).result)
    assert.ok(!unrelated.includes("fast origin"))
    assert.match(unrelated, /Compact view/)
  })

  it("reports ambiguous next steps and missing pending lines honestly with a full:true pointer", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("amb")
    const ambiguous = "1. Original\n2. Done\n6. Prioritized next steps\n1. Do A\nSome prose\n2. Do B\n"
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "amb", handover: ambiguous, summary: "no pending line here" })
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "amb" })).result)
    assert.match(read, /Prioritized next steps: unknown \(could not extract; request full:true/)
    assert.match(read, /User decisions pending: unknown \(no pending line in summary; request full:true to check\)/)
    assert.ok(!read.includes(ambiguous))
    const full = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", childId: "amb", full: true })).result)
    assert.ok(full.includes(ambiguous))
  })

  it("tracks baseline on first measurement, growth on the second, and unknown after invalid or reload", async () => {
    const startChild = async (f: Fake, id: string): Promise<void> => {
      const hook = only(f, "classic.SubagentStart") as unknown as (
        $: Engine,
        event: Record<string, unknown>,
        next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
      ) => Promise<Record<string, unknown>>
      await hook(f.$, { agent_id: id, agent_type: "general-purpose" }, async () => ({}))
    }
    // Normal observed start: first measured request baselines, second grows.
    const fake = makeFake({ soft: 1000 })
    setup(fake)
    fake.agents = childAgents("b1")
    await startChild(fake, "b1")
    await runStep(fake, { agentId: "b1", turnId: "t1" }, { input_tokens: 400, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await runStep(fake, { agentId: "b1", turnId: "t2" }, { input_tokens: 500, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 5, model: "m" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "b1", handover: handoverBody(["x"]), summary: "s" })
    const stored = fake.store.get("child:b1") as ChildRecord
    assert.equal((stored.diag as { baseline?: unknown }).baseline, 400)
    assert.equal((stored.diag as { growth?: unknown }).growth, 120)
    assert.match(String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "b1", full: true })).result), /Baseline: start-context-tokens=400, last-batch-increase=120\./)
    // Resume does not reset the seen baseline: a second start keeps it.
    const res = makeFake({ soft: 1000 })
    setup(res)
    res.agents = childAgents("r1")
    await startChild(res, "r1")
    await runStep(res, { agentId: "r1", turnId: "t1" }, { input_tokens: 400, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await startChild(res, "r1")
    await runStep(res, { agentId: "r1", turnId: "t2" }, { input_tokens: 520, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await toolCall(res, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "r1", handover: handoverBody(["x"]), summary: "s" })
    assert.match(String((await toolCall(res, { tool: READ_FULL, tool_use_id: "r1", childId: "r1", full: true })).result), /Baseline: start-context-tokens=400, last-batch-increase=120\./)
    // Legacy/unobserved: no start observed, so baseline stays unknown even
    // with two consecutive measurements; growth still tracks the delta.
    const legacy = makeFake({ soft: 1000 })
    setup(legacy)
    legacy.agents = childAgents("u1")
    await runStep(legacy, { agentId: "u1", turnId: "t1" }, { input_tokens: 400, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await runStep(legacy, { agentId: "u1", turnId: "t2" }, { input_tokens: 520, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await toolCall(legacy, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "u1", handover: handoverBody(["x"]), summary: "s" })
    assert.match(String((await toolCall(legacy, { tool: READ_FULL, tool_use_id: "r1", childId: "u1", full: true })).result), /Baseline: start-context-tokens=unknown, last-batch-increase=120\./)
    // Reload then fresh consecutive measurements: first post-reload total
    // must not invent a start; growth stays valid.
    const first = makeFake({ soft: 1000 })
    setup(first)
    first.agents = childAgents("c1")
    await startChild(first, "c1")
    await runStep(first, { agentId: "c1", turnId: "t1" }, { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    const second = makeFake({ soft: 1000 })
    for (const [key, value] of first.store) second.store.set(key, value)
    setup(second)
    second.agents = childAgents("c1")
    await startChild(second, "c1")
    await runStep(second, { agentId: "c1", turnId: "t1" }, { input_tokens: 4000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await runStep(second, { agentId: "c1", turnId: "t2" }, { input_tokens: 4500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await toolCall(second, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "c1", handover: handoverBody(["x"]), summary: "s" })
    assert.match(String((await toolCall(second, { tool: READ_FULL, tool_use_id: "r1", childId: "c1", full: true })).result), /Baseline: start-context-tokens=unknown, last-batch-increase=500\./)
    // A failed launch-metadata lookup cannot establish a fresh baseline.
    for (const key of ["child:outage", "spawn:outage"]) {
      const outage = makeFake({ soft: 1000 })
      setup(outage)
      outage.agents = childAgents("outage")
      outage.readFailKeys.add(key)
      await startChild(outage, "outage")
      outage.readFailKeys.clear()
      await runStep(outage, { agentId: "outage", turnId: "t1" }, { input_tokens: 400, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
      await toolCall(outage, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "outage", handover: handoverBody(["x"]), summary: "s" })
      assert.match(String((await toolCall(outage, { tool: READ_FULL, tool_use_id: "r1", childId: "outage" })).result), /Baseline: start-context-tokens=unknown, last-batch-increase=unknown\./)
    }
    // Invalid usage clears the last value so growth degrades honestly.
    const invalid = makeFake({ soft: 1000 })
    setup(invalid)
    invalid.agents = childAgents("b2")
    await startChild(invalid, "b2")
    await runStep(invalid, { agentId: "b2", turnId: "t1" }, { input_tokens: 400, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await runStep(invalid, { agentId: "b2", turnId: "t2" }, null)
    await toolCall(invalid, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "b2", handover: handoverBody(["x"]), summary: "s" })
    assert.match(String((await toolCall(invalid, { tool: READ_FULL, tool_use_id: "r1", childId: "b2", full: true })).result), /Baseline: start-context-tokens=400, last-batch-increase=unknown\./)
    // Compaction can shrink the per-request total: negative deltas retained.
    const compact = makeFake({ soft: 1000 })
    setup(compact)
    compact.agents = childAgents("n1")
    await startChild(compact, "n1")
    await runStep(compact, { agentId: "n1", turnId: "t1" }, { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await runStep(compact, { agentId: "n1", turnId: "t2" }, { input_tokens: 300, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await toolCall(compact, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "n1", handover: handoverBody(["x"]), summary: "s" })
    assert.match(String((await toolCall(compact, { tool: READ_FULL, tool_use_id: "r1", childId: "n1", full: true })).result), /Baseline: start-context-tokens=500, last-batch-increase=-200\./)
    // Reload loses in-memory baseline/growth.
    const reloaded = makeFake()
    setup(reloaded)
    reloaded.agents = childAgents("b3")
    await toolCall(reloaded, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "b3", handover: handoverBody(["x"]), summary: "s" })
    assert.match(String((await toolCall(reloaded, { tool: READ_FULL, tool_use_id: "r1", childId: "b3" })).result), /Baseline: start-context-tokens=unknown, last-batch-increase=unknown\./)
  })

  it("guards the pre-dispatch catch when next.error is absent", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "g1", "body")
    const handler = fake.catches.get("tool.call")
    assert.ok(handler)
    const seen: Array<Record<string, unknown>> = []
    const event = { tool: "Bash", agentId: "g1" }
    const next = Object.assign(
      (input: Record<string, unknown>): Promise<unknown> => {
        seen.push(input)
        return Promise.resolve({ result: "must not run" })
      },
      { called: false },
    )
    const noHost = new Proxy(fake.$, { get: () => { throw new Error("catch handlers must not access the host") } })
    const outcome = await handler(noHost, event, next as never) as { deny?: string }
    assert.match(String(outcome.deny), /before dispatch \(unknown\)/)
    assert.deepEqual(seen, [])
  })
})

describe("shared wording across both adapters", () => {
  it("keeps six numbered sections with no self-provenance request and honest history gaps", () => {
    for (const title of ["1. Original instructions", "2. Completed work", "3. In-progress work", "4. Key snippets", "5. Negative knowledge", "6. Prioritized next steps"]) {
      assert.ok(HANDOVER_SECTIONS.includes(title), `shared sections keep ${title}`)
    }
    assert.ok(!HANDOVER_SECTIONS.includes("agent, provider/model/variant"))
    assert.ok(!HANDOVER_SECTIONS.includes("provider/model"))
    assert.ok(!HANDOVER_SECTIONS.includes("session ID chain"))
    assert.ok(!HANDOVER_SECTIONS.includes("predecessor session"))
    assert.ok(HANDOVER_SECTIONS.includes("permissions/tool restrictions"))
    assert.ok(HANDOVER_SECTIONS.includes("flag history gaps"))
    assert.ok(HANDOVER_SECTIONS.includes("Do not describe your own agent type, model (including override), or chain"))
    assert.ok(HANDOVER_SECTIONS.includes("Keep open questions explicitly"))
    // Both adapters carry the shared text byte-for-byte.
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes(HANDOVER_SECTIONS))
    assert.ok(HANDOVER_DESCRIPTION.includes(HANDOVER_SECTIONS))
    assert.ok(HANDOVER_DESCRIPTION.includes("Do not describe your own agent type, model (including override), or chain"))
  })

  it("frames targeted rereads in both seeds without repeating completed work", () => {
    assert.ok(SEED_FRAMING.includes("Targeted rereads of already-covered material are allowed only to resolve open questions"))
    assert.ok(SEED_FRAMING.includes("never repeat completed steps"))
    assert.ok(SEED_FRAMING.includes("Continue from 'Prioritized next steps'"))
    assert.ok(HANDOVER_DESCRIPTION.includes("Targeted rereads of already-covered material are allowed only to resolve open questions"))
    assert.ok(CHILD_HANDOVER_DESCRIPTION.includes(HANDOVER_SECTIONS))
    assert.ok(buildClaudeRootIntro().includes("targeted rereads are allowed only to resolve open questions"))
    assert.ok(buildClaudeChildIntro().includes("targeted rereads are allowed only to resolve open questions"))
  })
})

describe("size retention acceptance", () => {
  const spawn = async (
    fake: Fake,
    event: Record<string, unknown>,
    answer: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const hook = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    return hook(fake.$, event, async () => ({ ...answer }))
  }

  const startChild = async (f: Fake, id: string): Promise<void> => {
    const hook = only(f, "classic.SubagentStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await hook(f.$, { agent_id: id, agent_type: "general-purpose" }, async () => ({}))
  }

  const completeTurn = async (f: Fake, event: Record<string, unknown>): Promise<unknown> => {
    const hook = only(f, "turn.complete") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<unknown>,
    ) => Promise<unknown>
    return hook(f.$, event, async (input) => input)
  }

  const PAY = 65536
  const big = (n: number): string => "x".repeat(n)

  const rec = (over: Record<string, unknown> = {}): ChildRecord =>
    ({ handover: "b", summary: "s", agentId: "t", parentSessionId: undefined, closed: true, storedAt: 1, ...over }) as ChildRecord

  const seedLegacy = (fake: Fake, id: string, at: number, pay = PAY): void => {
    fake.store.set(`child:${id}`, { handover: big(pay), summary: `s ${id}`, agentId: id, closed: true, storedAt: at })
    fake.store.set(`spawn:${id}`, { agentType: "general-purpose", modelOverride: null, storedAt: at })
  }

  const seedOriginChain = (fake: Fake, origin: string, members: string[], at: number, pay = PAY): void => {
    members.forEach((id, i) => {
      const predecessor = i === 0 ? {} : { predecessorAgentId: members[i - 1] }
      fake.store.set(`child:${id}`, {
        handover: big(pay), summary: `s ${id}`, agentId: id, closed: true, storedAt: at + i,
        originAgentId: origin, ...predecessor, generation: i + 1,
      })
      fake.store.set(`spawn:${id}`, {
        agentType: "general-purpose", modelOverride: null, storedAt: at + i,
        originAgentId: origin, ...predecessor, generation: i + 1,
      })
    })
    fake.store.set(originalRecordKey(origin), { prompt: `origin task ${origin}`, originAgentId: origin, storedAt: at })
    fake.store.set(activityKey(origin), { lastActive: at })
  }

  // Grow the store past the fixed budget with oldest-first timestamped legacy chains.
  const fillOverBudget = (fake: Fake, prefix: string, extra = 4, pay = PAY): string[] => {
    const ids: string[] = []
    let i = 0
    while (estimateStoreBytes(fake.store) <= STORE_BUDGET_BYTES + extra * (pay + 512)) {
      const id = `${prefix}${i}`
      seedLegacy(fake, id, 1000 + i * 10, pay)
      ids.push(id)
      i++
    }
    return ids
  }

  const writeHandover = async (fake: Fake, agentId: string, handover = "fresh body"): Promise<CallOutcome> => {
    if (!fake.agents.some((agent) => agent.id === agentId)) {
      fake.agents = [...fake.agents, ...childAgents(agentId)]
    }
    return toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: `t-${agentId}`, agentId, handover, summary: `s ${agentId}` })
  }

  it("budgets a fixed 3 MiB complete serialized store including every key family and pending replacement", () => {
    assert.equal(STORE_BUDGET_BYTES, 3 * 1024 * 1024)
    const entries = new Map<string, unknown>([
      ["child:a1", { handover: "body", summary: "s", agentId: "a1", closed: true, storedAt: 7 }],
      ["spawn:a1", { agentType: "Explore", storedAt: 7 }],
      [originalRecordKey("a1"), { prompt: "task", originAgentId: "a1", storedAt: 7 }],
      [activityKey("a1"), { lastActive: 9 }],
      [pinKey("a1"), { owner: "ses_host", updatedAt: 9 }],
      ["mystery:key", { anything: [1, "two"] }],
      ["noprefix", 42],
    ])
    const expected = utf8ByteLength(JSON.stringify(Object.fromEntries(entries)))
    assert.equal(estimateStoreBytes(entries), expected)
    // Empty store is just the outer braces; pending replaces the old entry value.
    assert.equal(estimateStoreBytes(new Map()), 2)
    const replacement = { handover: "replaced body", summary: "s2", agentId: "a1", closed: true, storedAt: 8 }
    const withPending = new Map(entries)
    withPending.set("child:a1", replacement)
    assert.equal(
      estimateStoreBytes(entries, { key: "child:a1", value: replacement }),
      utf8ByteLength(JSON.stringify(Object.fromEntries(withPending))),
    )
    // Concurrently deleted (undefined) values count as absent.
    const withAbsent = new Map(entries)
    withAbsent.set("mystery:key", undefined)
    const absentExpected = new Map(entries)
    absentExpected.delete("mystery:key")
    assert.equal(estimateStoreBytes(withAbsent), utf8ByteLength(JSON.stringify(Object.fromEntries(absentExpected))))
  })

  it("counts UTF-8 bytes and JSON escapes in keys and values, not string length", () => {
    assert.equal(utf8ByteLength("😀"), 4)
    const entries = new Map<string, unknown>([
      ['child:"quo"téd', { handover: "emoji 😀\nnewline\t\"quote\"\\slash é", summary: "s", agentId: "x", closed: true, storedAt: 1 }],
      ["spawn:ünï", { agentType: "général", storedAt: 1 }],
    ])
    assert.equal(estimateStoreBytes(entries), utf8ByteLength(JSON.stringify(Object.fromEntries(entries))))
    assert.ok(estimateStoreBytes(entries) > [...entries.keys()].join("").length)
  })

  it("classifies absent lineage as legacy and every unverifiable claim as uncertain", () => {
    assert.equal(classifyChain(undefined, undefined).kind, "legacy")
    assert.equal(classifyChain(rec(), undefined).kind, "legacy")
    // A generation or predecessor without a resolvable origin is a claim, never legacy.
    assert.equal(classifyChain(undefined, { generation: 2 }).kind, "uncertain")
    assert.equal(classifyChain(undefined, { predecessorAgentId: "p" }).kind, "uncertain")
    assert.equal(classifyChain(rec({ generation: 3 }), undefined).kind, "uncertain")
    // A named origin is a whole chain.
    assert.deepEqual(classifyChain(undefined, { originAgentId: "o", generation: 1 }).origin, "o")
  })

  it("marks malformed, conflicting, and empty lineage uncertain, flagging malformed markers explicitly", () => {
    // Present-but-invalid values (empty strings, non-integer generations) are malformed, never absent.
    for (const bad of [
      { originAgentId: "" },
      { predecessorAgentId: "" },
      { generation: 0 },
      { generation: 1.5 },
    ]) {
      assert.equal(classifyChain(undefined, bad as SpawnProvenance).kind, "uncertain")
    }
    assert.equal(classifyChain(rec({ originAgentId: "" }), undefined).kind, "uncertain")
    // Both-present disagreements are conflicts, never guessed.
    assert.equal(classifyChain(rec({ originAgentId: "o1" }), { originAgentId: "o2" }).kind, "uncertain")
    assert.equal(classifyChain(
      rec({ originAgentId: "o", predecessorAgentId: "p1" }),
      { originAgentId: "o", predecessorAgentId: "p2" },
    ).kind, "uncertain")
    assert.equal(classifyChain(
      rec({ originAgentId: "o", generation: 2 }),
      { originAgentId: "o", generation: 3 },
    ).kind, "uncertain")
    // The explicit malformed-marker flag survives even beside valid fields.
    assert.equal(classifyChain(undefined, { originAgentId: "o", lineageUncertain: true }).kind, "uncertain")
    assert.equal(classifyChain(undefined, { lineageUncertain: true }).kind, "uncertain")
  })

  it("groups whole origin chains with their original/activity keys and quarantines malformed values", () => {
    const byKey = new Map<string, unknown>()
    byKey.set("child:m1", { handover: "b", summary: "s", agentId: "m1", closed: true, storedAt: 10, originAgentId: "o", generation: 1 })
    byKey.set("spawn:m1", { originAgentId: "o", generation: 1, storedAt: 10 })
    byKey.set("child:m2", { handover: "b", summary: "s", agentId: "m2", closed: true, storedAt: 20, originAgentId: "o", predecessorAgentId: "m1", generation: 2 })
    byKey.set("spawn:m2", { originAgentId: "o", predecessorAgentId: "m1", generation: 2, storedAt: 20 })
    byKey.set(originalRecordKey("o"), { prompt: "task", originAgentId: "o", storedAt: 5 })
    byKey.set(activityKey("o"), { lastActive: 25 })
    byKey.set("child:bad", { handover: 42 })
    byKey.set("spawn:bad", { agentType: 42 })
    byKey.set("mystery:key", { anything: true })
    const groups = groupChains(byKey)
    const origin = groups.get("origin:o")
    assert.ok(origin)
    assert.deepEqual([...origin.keys].sort(), [activityKey("o"), "child:m1", "child:m2", originalRecordKey("o"), "spawn:m1", "spawn:m2"].sort())
    assert.equal(origin.lastActive, 25)
    // Malformed values are quarantined into an uncertain singleton, never attached to the valid chain.
    const quarantined = groups.get("uncertain:bad")
    assert.ok(quarantined)
    assert.ok(quarantined.keys.includes("child:bad"))
    assert.ok(!origin.keys.includes("child:bad"))
    // Unknown families ride along in the estimate but form no evictable group.
    assert.ok(![...groups.values()].some((group) => group.keys.includes("mystery:key")))
  })

  it("orders oldest whole chains first with legacy before origin and untimestamped oldest", () => {
    const byKey = new Map<string, unknown>()
    byKey.set("child:new-origin", { handover: "b", summary: "s", agentId: "new-origin", closed: true, storedAt: 50, originAgentId: "no", generation: 1 })
    byKey.set("spawn:new-origin", { originAgentId: "no", generation: 1, storedAt: 50 })
    byKey.set("child:old-origin", { handover: "b", summary: "s", agentId: "old-origin", closed: true, storedAt: 10, originAgentId: "oo", generation: 1 })
    byKey.set("spawn:old-origin", { originAgentId: "oo", generation: 1, storedAt: 10 })
    byKey.set("child:fresh-legacy", { handover: "b", summary: "s", agentId: "fresh-legacy", closed: true, storedAt: 100 })
    byKey.set("child:stale-legacy", { handover: "b", summary: "s", agentId: "stale-legacy", closed: true, storedAt: 1 })
    byKey.set("child:nostamp", { handover: "b", summary: "s", agentId: "nostamp", closed: true })
    byKey.set("child:unstamped-origin", { handover: "b", summary: "s", agentId: "unstamped-origin", closed: true, originAgentId: "uo", generation: 1 })
    byKey.set("spawn:unstamped-origin", { originAgentId: "uo", generation: 1 })
    byKey.set("child:unc", { handover: "b", summary: "s", agentId: "unc", closed: true, storedAt: 1 })
    byKey.set("spawn:unc", { lineageUncertain: true, storedAt: 1 })
    const ordered = orderEvictableChains(groupChains(byKey)).map((group) => group.chain)
    // Rank 0 is legacy plus untimestamped origins: the untimestamped origin
    // sorts oldest with legacy (never behind the recent timestamped legacy),
    // while timestamped origins stay last; uncertain never appears.
    assert.deepEqual(ordered, ["nostamp", "uo", "stale-legacy", "fresh-legacy", "oo", "no"])
    // Activity wins over storedAt for recency.
    byKey.set(activityKey("oo"), { lastActive: 1000 })
    const reordered = orderEvictableChains(groupChains(byKey)).map((group) => group.chain)
    assert.deepEqual(reordered, ["nostamp", "uo", "stale-legacy", "fresh-legacy", "no", "oo"])
  })

  it("ranks untimestamped origins with legacy oldest instead of behind recent legacy", () => {
    const byKey = new Map<string, unknown>()
    byKey.set("child:recent-legacy", { handover: "b", summary: "s", agentId: "recent-legacy", closed: true, storedAt: 500 })
    byKey.set("child:uom", { handover: "b", summary: "s", agentId: "uom", closed: true, originAgentId: "uo", generation: 1 })
    byKey.set("spawn:uom", { originAgentId: "uo", generation: 1 })
    byKey.set("child:new-origin-m", { handover: "b", summary: "s", agentId: "new-origin-m", closed: true, storedAt: 900, originAgentId: "no", generation: 1 })
    byKey.set("spawn:new-origin-m", { originAgentId: "no", generation: 1, storedAt: 900 })
    const ordered = orderEvictableChains(groupChains(byKey)).map((group) => group.chain)
    // The untimestamped origin evicts before the recent timestamped legacy;
    // the timestamped origin sorts last.
    assert.deepEqual(ordered, ["uo", "recent-legacy", "no"])
  })

  it("treats spawn-only orphans as legacy singletons and unknown keys as noncandidates", () => {
    const byKey = new Map<string, unknown>()
    byKey.set("spawn:orphan", { agentType: "Explore", modelOverride: null, storedAt: 5 })
    byKey.set("weird", 1)
    byKey.set("other:thing", { payload: "x" })
    const groups = groupChains(byKey)
    const orphan = groups.get("legacy:orphan")
    assert.ok(orphan)
    assert.deepEqual(orphan.keys, ["spawn:orphan"])
    assert.deepEqual(orderEvictableChains(groups).map((group) => group.chain), ["orphan"])
  })

  it("keeps identifiable related original/activity keys with the member chain", () => {
    const byKey = new Map<string, unknown>()
    byKey.set("child:m1", { handover: "b", summary: "s", agentId: "m1", closed: true, storedAt: 10, originAgentId: "o", generation: 1 })
    byKey.set("spawn:m1", { predecessorAgentId: "ghost", originAgentId: "o", generation: 1, storedAt: 10 })
    // ghost is named as a predecessor but has no member keys: its orphan
    // original/activity stays with the member chain, not an independent group.
    byKey.set(originalRecordKey("ghost"), { prompt: "old task", originAgentId: "ghost", storedAt: 1 })
    byKey.set(activityKey("ghost"), { lastActive: 2 })
    const groups = groupChains(byKey)
    assert.equal(groups.get("legacy:ghost"), undefined)
    assert.ok(groups.get("origin:o")?.keys.includes(originalRecordKey("ghost")))
    assert.ok(groups.get("origin:o")?.keys.includes(activityKey("ghost")))
  })

  it("builds lock-preserving tombstones carrying lineage and timestamps", () => {
    const tomb = buildChildTombstone({ agentId: "c9", storedAt: 42, predecessorAgentId: "p", originAgentId: "o", generation: 2 })
    assert.equal(tomb.tombstone, true)
    assert.equal(tomb.expired, true)
    assert.equal(tomb.closed, true)
    assert.equal(tomb.storedAt, 42)
    assert.equal(tomb.originAgentId, "o")
    assert.ok(isChildTombstone(tomb))
    assert.ok(!isChildTombstone({ handover: "b", summary: "s", agentId: "c", closed: true }))
  })

  it("resolves pending chains from merged store and memory provenance without guessing", async () => {
    const fake = makeFake()
    setup(fake)
    fake.store.set("child:m1", { handover: "b", summary: "s", agentId: "m1", closed: true, storedAt: 1, originAgentId: "o", generation: 1 })
    const byKey = new Map(fake.store)
    assert.equal(await resolveChainOf(fake.$, byKey, "m1", undefined), "o")
    assert.equal(await resolveChainOf(fake.$, byKey, "solo", undefined), "solo")
    // A stored predecessor without an origin is uncertain: undefined, never guessed.
    fake.store.set("spawn:lost", { predecessorAgentId: "ghost", storedAt: 1 })
    assert.equal(await resolveChainOf(fake.$, new Map(fake.store), "lost", undefined), undefined)
    // Memory provenance supplements the store for in-flight ids.
    assert.equal(await resolveChainOf(fake.$, byKey, "fresh", { originAgentId: "o2" }), "o2")
  })

  it("evicts oldest whole legacy chains first, including spawn-only orphans", async () => {
    const fake = makeFake()
    setup(fake)
    const ids = fillOverBudget(fake, "old")
    fake.store.set("spawn:orphan", { agentType: "Explore", modelOverride: null, storedAt: 1 })
    const done = await writeHandover(fake, "writer")
    assert.ok(done.result)
    const oldest = ids[0] as string
    assert.ok(isChildTombstone(fake.store.get(`child:${oldest}`)))
    assert.equal(fake.store.get(`spawn:${oldest}`), undefined)
    // The spawn-only orphan sorts oldest (storedAt 1) and is reclaimed too.
    assert.equal(fake.store.get("spawn:orphan"), undefined)
    // Newer chains and the writing chain survive with the projection fitting.
    const newest = ids[ids.length - 1] as string
    assert.equal((fake.store.get(`child:${newest}`) as ChildRecord).handover, big(PAY))
    assert.equal((fake.store.get("child:writer") as ChildRecord).summary, "s writer")
    assert.ok(estimateStoreBytes(fake.store) <= STORE_BUDGET_BYTES)
    assert.ok(![...fake.store.keys()].some((key) => key === "child:writer" && isChildTombstone(fake.store.get(key))))
  })

  it("protects the writing, live-listed, inflight, and pinned chains while evicting the oldest unprotected chain", async () => {
    const fake = makeFake()
    setup(fake)
    const ids = fillOverBudget(fake, "p")
    const liveId = ids[1] as string
    const pinnedId = ids[2] as string
    fake.agents = [{ id: liveId, type: "general-purpose", status: "running" }]
    fake.store.set(pinKey(pinnedId), { owner: "ses_host", updatedAt: Date.now() })
    const inflightId = ids[3] as string
    // Inflight chains are protected by contract: reclaim with them held back
    // evicts around them without touching their keys.
    const scan = await reclaimForWrite(fake.$, "child:newcomer", { probe: true }, new Set([inflightId, liveId, pinnedId]))
    assert.ok(!scan.evicted.some((key) => key === `child:${inflightId}` || key === `spawn:${inflightId}`))
    assert.ok(!scan.tombstoned.includes(inflightId))
    assert.ok(fake.store.get(`child:${inflightId}`))
    const done = await writeHandover(fake, "writer")
    assert.ok(done.result)
    // Oldest unprotected chain went; live, pinned, inflight, and writer chains remain.
    assert.ok(isChildTombstone(fake.store.get(`child:${ids[0]}`)))
    assert.equal((fake.store.get(`child:${liveId}`) as ChildRecord).handover, big(PAY))
    assert.equal((fake.store.get(`child:${pinnedId}`) as ChildRecord).handover, big(PAY))
    assert.equal((fake.store.get(`child:${inflightId}`) as ChildRecord).handover, big(PAY))
    assert.ok(fake.store.get("child:writer"))
  })

  it("protects uncertain members and the predecessor/origin chains they reference", async () => {
    const fake = makeFake()
    setup(fake)
    seedOriginChain(fake, "O", ["om1", "om2"], 1000)
    // Uncertain successor observing om2 as predecessor: explicit unresolvable lineage.
    fake.store.set("spawn:u1", { predecessorAgentId: "om2", lineageUncertain: true, storedAt: 5000 })
    fake.store.set("child:u1", { handover: "b", summary: "s", agentId: "u1", closed: true, storedAt: 5000 })
    const ids = fillOverBudget(fake, "q")
    const done = await writeHandover(fake, "writer")
    assert.ok(done.result)
    // Uncertain singleton and the referenced origin chain survive; unrelated legacy was evicted.
    assert.equal((fake.store.get("child:u1") as ChildRecord).handover, "b")
    assert.equal((fake.store.get("child:om1") as ChildRecord).originAgentId, "O")
    assert.equal((fake.store.get("child:om2") as ChildRecord).handover, big(PAY))
    assert.ok(fake.store.get(originalRecordKey("O")))
    assert.ok(isChildTombstone(fake.store.get(`child:${ids[0]}`)))
  })

  it("protects chains named by guard-invalid records and mismatched identities", async () => {
    const fake = makeFake()
    setup(fake)
    seedOriginChain(fake, "O", ["om1", "om2"], 1000)
    // Guard-invalid child (missing summary) naming the victim origin and predecessor.
    fake.store.set("child:bad", { handover: "b", agentId: "bad", closed: true, storedAt: 5000, originAgentId: "O", predecessorAgentId: "om1" })
    // Guard-invalid spawn (non-string agentType) naming the victim origin and predecessor.
    fake.store.set("spawn:raw", { agentType: 42, originAgentId: "O", predecessorAgentId: "om2" })
    // Guard-invalid child naming an orphan predecessor carrying original/activity.
    fake.store.set("child:bad2", { handover: "b", agentId: "bad2", closed: true, storedAt: 5000, predecessorAgentId: "ghost" })
    fake.store.set(originalRecordKey("ghost"), { prompt: "ghost task", originAgentId: "ghost", storedAt: 1 })
    fake.store.set(activityKey("ghost"), { lastActive: 2 })
    // Conflicting recorded identity: key mux claims member om1.
    fake.store.set("child:mux", { handover: "b", summary: "s", agentId: "om1", closed: true, storedAt: 5000 })
    fake.store.set("mystery:kept", { payload: "x" })
    // Grouping first: malformed values quarantine as uncertain singletons and
    // never join the victim chain; the ghost orphans ride with their
    // quarantined referrer instead of forming an independent legacy group.
    const groups = groupChains(new Map(fake.store))
    assert.ok(groups.get("uncertain:bad"))
    assert.ok(groups.get("uncertain:raw"))
    assert.ok(groups.get("uncertain:mux"))
    assert.ok(groups.get("uncertain:bad2")?.keys.includes(originalRecordKey("ghost")))
    assert.ok(groups.get("uncertain:bad2")?.keys.includes(activityKey("ghost")))
    assert.equal(groups.get("legacy:ghost"), undefined)
    assert.ok(!groups.get("origin:O")?.keys.includes("child:bad"))
    const ids = fillOverBudget(fake, "h")
    const done = await writeHandover(fake, "writer")
    assert.ok(done.result)
    // Victim chain, orphans, quarantined records, and opaque keys survive; unrelated legacy was evicted.
    assert.equal((fake.store.get("child:om1") as ChildRecord).handover, big(PAY))
    assert.equal((fake.store.get("child:om2") as ChildRecord).handover, big(PAY))
    assert.ok(fake.store.get(originalRecordKey("O")))
    assert.ok(fake.store.get(originalRecordKey("ghost")))
    assert.ok(fake.store.get(activityKey("ghost")))
    assert.ok(fake.store.get("child:bad"))
    assert.ok(fake.store.get("spawn:raw"))
    assert.ok(fake.store.get("child:mux"))
    assert.equal((fake.store.get("mystery:kept") as { payload: string }).payload, "x")
    assert.ok(isChildTombstone(fake.store.get(`child:${ids[0]}`)))
  })

  it("treats conflicting valid child/spawn origins as uncertain and shields both chains", async () => {
    const fake = makeFake()
    setup(fake)
    seedOriginChain(fake, "O1", ["a1", "a2"], 1000)
    seedOriginChain(fake, "O2", ["b1"], 2000)
    // Each record alone classifies as an origin; merged they conflict, so the
    // id is uncertain and both referenced chains are shielded.
    fake.store.set("child:c1", { handover: "b", summary: "s", agentId: "c1", closed: true, storedAt: 5000, originAgentId: "O1", generation: 2 })
    fake.store.set("spawn:c1", { agentType: "general-purpose", modelOverride: null, storedAt: 5000, originAgentId: "O2", generation: 2 })
    const groups = groupChains(new Map(fake.store))
    assert.ok(groups.get("uncertain:c1"))
    assert.ok(!groups.get("origin:O1")?.keys.includes("child:c1"))
    assert.ok(!groups.get("origin:O2")?.keys.includes("spawn:c1"))
    const ids = fillOverBudget(fake, "cx")
    const done = await writeHandover(fake, "writer")
    assert.ok(done.result)
    assert.equal((fake.store.get("child:a1") as ChildRecord).originAgentId, "O1")
    assert.equal((fake.store.get("child:b1") as ChildRecord).originAgentId, "O2")
    assert.ok(fake.store.get(originalRecordKey("O1")))
    assert.ok(fake.store.get(originalRecordKey("O2")))
    assert.ok(fake.store.get("child:c1"))
    assert.ok(fake.store.get("spawn:c1"))
    assert.ok(isChildTombstone(fake.store.get(`child:${ids[0]}`)))
  })

  it("never evicts unknown or other key families", async () => {
    const fake = makeFake()
    setup(fake)
    fillOverBudget(fake, "k")
    fake.store.set("mystery:kept", { payload: big(1024) })
    fake.store.set("barekey", "kept-value")
    const done = await writeHandover(fake, "writer")
    assert.ok(done.result)
    assert.deepEqual((fake.store.get("mystery:kept") as { payload: string }).payload, big(1024))
    assert.equal(fake.store.get("barekey"), "kept-value")
  })

  it("keeps retained tombstones locked with explicit expired reads and denials", async () => {
    const fake = makeFake()
    setup(fake)
    fake.store.set("child:x1", buildChildTombstone({ agentId: "x1", storedAt: 5, originAgentId: "O" }))
    fake.agents = childAgents("x1")
    const read = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "x1" })
    assert.match(String(read.result), /has expired and is no longer stored/)
    assert.match(String(read.result), /must not be messaged or resumed/)
    // Gate, duplicate handover, and stop all refuse with expiry wording; nothing is resurrected.
    assert.match(String((await toolCall(fake, { tool: "Bash", tool_use_id: "t1", agentId: "x1" })).deny), /expired under size-based retention/)
    assert.match(String((await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "x1", handover: "b", summary: "s" })).deny), /expired under size-based retention/)
    const stopped = await stopHook(fake, { agent_id: "x1", stop_hook_active: false, last_assistant_message: "other" })
    assert.match(String(stopped.block), /SubagentHandback/)
    assert.ok(isChildTombstone(fake.store.get("child:x1")))
    // Handback forwards the locked reply through next without persisting delivery status onto the tombstone.
    const forwarded = await toolCall(fake, { tool: "SubagentHandback", agentId: "x1", message: "report" }, async (input) => ({ result: `native:${String((input as Record<string, unknown>).message).slice(0, 20)}` }))
    assert.match(String(forwarded.result), /^native:/)
    const after = fake.store.get("child:x1") as ChildTombstone
    assert.ok(isChildTombstone(after))
    assert.equal((after as unknown as Record<string, unknown>).handbackDelivered, undefined)
    // Continuations still get the intro but never rebuild a payload.
    await startChild(fake, "x1")
    assert.ok(isChildTombstone(fake.store.get("child:x1")))
  })

  it("tombstones retain merged spawn lineage and the pre-eviction timestamp", async () => {
    const fake = makeFake()
    setup(fake)
    // Child without lineage plus spawn with origin: the tombstone merges the spawn link.
    fake.store.set("child:merge", { handover: big(3 * 1024 * 1024 + 65536), summary: "s", agentId: "merge", closed: true, storedAt: 100 })
    fake.store.set("spawn:merge", { originAgentId: "O9", generation: 5, storedAt: 100 })
    // Small newer filler evicts first but frees almost nothing, so reclamation
    // reaches the big older origin chain.
    for (let i = 0; i < 5; i++) seedLegacy(fake, `mf${i}`, 5000 + i, 1024)
    const done = await writeHandover(fake, "writer")
    assert.ok(done.result)
    const tomb = fake.store.get("child:merge") as ChildTombstone
    assert.ok(isChildTombstone(tomb))
    assert.equal(tomb.originAgentId, "O9")
    assert.equal(tomb.generation, 5)
    // Evicting does not refresh the chain age: the original member timestamp is kept.
    assert.equal(tomb.storedAt, 100)
  })

  it("lets successors of expired predecessors inherit lineage without resurrecting payload or resetting the origin", async () => {
    const fake = makeFake()
    setup(fake)
    fake.store.set("child:gone", buildChildTombstone({ agentId: "gone", storedAt: 5, originAgentId: "O", generation: 1 }))
    fake.agents = [{ id: "next", type: "general-purpose", status: "running" }]
    const result = await spawn(fake, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("gone")} keep going` }, { model: "m", agentId: "next" })
    assert.equal((result as Record<string, unknown>).agentId, "next")
    const meta = fake.store.get("spawn:next") as SpawnProvenance
    assert.equal(meta.predecessorAgentId, "gone")
    assert.equal(meta.originAgentId, "O")
    assert.equal(meta.generation, 2)
    // The expired predecessor is untouched and no new origin was fabricated for it.
    assert.ok(isChildTombstone(fake.store.get("child:gone")))
    assert.equal(fake.store.get(originalRecordKey("gone")), undefined)
  })

  it("refreshes activity on reads and continuations without a keys() eviction scan", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "a1", handover: "body", summary: "s" })
    let keysCalls = 0
    const innerKeys = fake.$.store.keys.bind(fake.$.store)
    ;(fake.$.store as unknown as { keys: () => Promise<string[]> }).keys = async () => {
      keysCalls++
      return innerKeys()
    }
    await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "a1" })
    await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", childId: "a1", full: true })
    await startChild(fake, "a1")
    await runStep(fake, { agentId: "a1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await completeTurn(fake, { agentId: "a1", turnId: "t1" })
    assert.equal(keysCalls, 0)
    // Activity was still touched (chain stays young) without any scan.
    assert.ok(fake.store.get(activityKey("a1")))
    assert.equal((fake.store.get("child:a1") as ChildRecord).handover, "body")
  })

  it("refuses the write when key enumeration is missing, even apparently under budget, then retries clean", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("w1")
    fake.keysFails = true
    const denied = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "w1", handover: "b", summary: "s" })
    assert.match(String(denied.deny), /storage budget refuses the write/)
    assert.match(String(denied.deny), /store scan incomplete \(key enumeration unavailable\)/)
    assert.match(String(denied.deny), /nothing was stored and the child is not locked/)
    assert.equal(fake.store.get("child:w1"), undefined)
    // No lock was taken: ordinary tools still pass through.
    assert.match(String((await toolCall(fake, { tool: "Bash", tool_use_id: "t2", agentId: "w1" })).result), /^passed:Bash$/)
    fake.keysFails = false
    const retried = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t3", agentId: "w1", handover: "b", summary: "s" })
    assert.match(String(retried.result), /Handover stored/)
  })

  it("refuses the write on any unreadable key, even apparently under budget, then retries clean", async () => {
    const fake = makeFake()
    setup(fake)
    fake.store.set("child:other", { handover: "kept", summary: "s", agentId: "other", closed: true, storedAt: 1 })
    fake.agents = childAgents("w1")
    fake.readFailKeys.add("child:other")
    const denied = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "w1", handover: "b", summary: "s" })
    assert.match(String(denied.deny), /store scan incomplete \(1 unreadable keys, first: child:other\)/)
    assert.match(String(denied.deny), /nothing was stored and the child is not locked/)
    assert.equal(fake.store.get("child:w1"), undefined)
    fake.readFailKeys.delete("child:other")
    const retried = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t3", agentId: "w1", handover: "b", summary: "s" })
    assert.match(String(retried.result), /Handover stored/)
    assert.equal((fake.store.get("child:other") as ChildRecord).handover, "kept")
  })

  it("keeps a chain whole when its tombstone write fails and reports an explicit retryable error", async () => {
    const fake = makeFake()
    setup(fake)
    const ids = fillOverBudget(fake, "f", 4)
    const oldest = ids[0] as string
    fake.store.set(originalRecordKey(oldest), { prompt: `origin task ${oldest}`, originAgentId: oldest, storedAt: 1 })
    fake.agents = childAgents("writer")
    fake.writeFailKeys.add(`child:${oldest}`)
    const denied = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "writer", handover: "fresh", summary: "s" })
    assert.match(String(denied.deny), /storage budget refuses the write/)
    assert.match(String(denied.deny), /tombstone child:/)
    assert.match(String(denied.deny), /retry the same call/)
    assert.match(String(denied.deny), /nothing was stored and the child is not locked/)
    // The sibling spawn/original keys were not deleted behind the failed tombstone.
    assert.equal((fake.store.get(`child:${oldest}`) as ChildRecord).handover, big(PAY))
    assert.ok(fake.store.get(`spawn:${oldest}`))
    assert.ok(fake.store.get(originalRecordKey(oldest)))
    assert.equal(fake.store.get("child:writer"), undefined)
    fake.writeFailKeys.delete(`child:${oldest}`)
    // Force reclamation on retry with fresh over-budget filler: the oldest
    // chain is tombstoned first now that its lock write succeeds.
    fake.store.set("child:bigfill", { handover: big(500000), summary: "s", agentId: "bigfill", closed: true, storedAt: 99999 })
    fake.store.set("spawn:bigfill", { agentType: "general-purpose", modelOverride: null, storedAt: 99999 })
    const retried = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "writer", handover: "fresh", summary: "s" })
    assert.match(String(retried.result), /Handover stored/)
    assert.ok(isChildTombstone(fake.store.get(`child:${oldest}`)))
  })

  it("reports partial delete failures explicitly even when the projection fits, then completes on retry", async () => {
    const fake = makeFake()
    setup(fake)
    const ids = fillOverBudget(fake, "d", 1)
    const oldest = ids[0] as string
    fake.agents = childAgents("writer")
    fake.deleteFailKeys.add(`spawn:${oldest}`)
    const denied = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "writer", handover: "fresh", summary: "s" })
    assert.match(String(denied.deny), /storage budget refuses the write/)
    assert.match(String(denied.deny), /delete spawn:/)
    assert.match(String(denied.deny), /retry the same call/)
    // The payload lock was still preserved as a tombstone; the failed delete was retained.
    assert.ok(isChildTombstone(fake.store.get(`child:${oldest}`)))
    assert.ok(fake.store.get(`spawn:${oldest}`))
    assert.equal(fake.store.get("child:writer"), undefined)
    fake.deleteFailKeys.delete(`spawn:${oldest}`)
    // Force reclamation on retry: the oldest chain is visited first and its
    // retained delete completes.
    fake.store.set("child:bigfill", { handover: big(500000), summary: "s", agentId: "bigfill", closed: true, storedAt: 99999 })
    fake.store.set("spawn:bigfill", { agentType: "general-purpose", modelOverride: null, storedAt: 99999 })
    const retried = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "writer", handover: "fresh", summary: "s" })
    assert.match(String(retried.result), /Handover stored/)
    assert.equal(fake.store.get(`spawn:${oldest}`), undefined)
  })

  it("stores the canonical summary losslessly beside delimiter text and keeps legacy short replies deliverable", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("a1")
    const tricky = `${CHILD_SUMMARY_PREFIX} tricky\nUser decisions pending: none\nContext handover (incomplete): embedded marker-like text`
    const done = await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "a1", handover: "body", summary: tricky })
    assert.ok(done.result)
    const stored = fake.store.get("child:a1") as ChildRecord
    assert.equal(stored.summary, tricky)
    assert.equal(stored.shortReply, undefined)
    // Derivation never parses the summary out of generated text: the full text survives verbatim.
    assert.ok(shortReplyOf(stored).includes(tricky))
    assert.match(String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "a1" })).result), /User decisions pending: none/)
    // The successor payload carries the handover verbatim once; the summary
    // travels via the derived short reply, never rewritten.
    const full = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r2", childId: "a1", full: true })).result)
    assert.equal(full.split("body").length - 1, 1)
    // Legacy stored short replies are returned verbatim by derivation and
    // forwarded as-is on the native handback path for the matching turn.
    const legacy = makeFake()
    setup(legacy)
    legacy.store.set("child:old", { handover: "old body", summary: "old summary", agentId: "old", shortReply: "Context handover (incomplete): old short", closed: true, storedAt: 1 })
    assert.equal(shortReplyOf(legacy.store.get("child:old") as ChildRecord), "Context handover (incomplete): old short")
    legacy.store.set("child:old2", { handover: "old body", summary: "old summary", agentId: "old2", shortReply: "Context handover (incomplete): old short", closed: true, storedAt: 1, handoverTurnId: "t" })
    legacy.agents = childAgents("old2")
    await runStep(legacy, { agentId: "old2", turnId: "t" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    const seen: unknown[] = []
    await toolCall(legacy, { tool: "SubagentHandback", agentId: "old2", message: "report" }, async (input) => {
      seen.push((input as Record<string, unknown>).message)
      return { result: "native-ok" }
    })
    assert.deepEqual(seen, ["Context handover (incomplete): old short"])
    assert.match(String((await toolCall(legacy, { tool: READ_FULL, tool_use_id: "r2", childId: "old", full: true })).result), /old body/)
  })

  it("releases owned pins and transient state on the matched turn.complete while mismatched turns preserve them", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = childAgents("w1")
    await spawn(fake, { subagentType: "Explore" }, { model: "m", agentId: "w1" })
    assert.ok(fake.store.get(pinKey("w1")))
    await runStep(fake, { agentId: "w1", turnId: "t1" }, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    // Mismatched turn identity leaves the live newer-turn state alone.
    await completeTurn(fake, { agentId: "w1", turnId: "other" })
    assert.ok(fake.store.get(pinKey("w1")))
    await completeTurn(fake, { agentId: "w1", turnId: "t1" })
    assert.equal(fake.store.get(pinKey("w1")), undefined)
    // Correction state retired with the turn: a later stop corrects fresh.
    await handOver(fake, "w1", "body")
    const event = { agent_id: "w1", stop_hook_active: false, last_assistant_message: "other" }
    assert.match(String((await stopHook(fake, event)).block), /ONLY/)
    assert.equal((await stopHook(fake, event)).block, undefined)
    await completeTurn(fake, { agentId: "w1" })
    assert.match(String((await stopHook(fake, event)).block), /ONLY/)
  })

  it("retires measurements on a matching turn.complete and re-enables them on a new open turn", async () => {
    const fake = makeFake({ soft: 1000 })
    setup(fake)
    const nudges = async (): Promise<number> =>
      ((await batch(fake, { agent_id: "w1" })).additionalContext as unknown[] | undefined)?.length ?? 0
    fake.agents = childAgents("w1")
    await spawn(fake, { subagentType: "Explore" }, { model: "m", agentId: "w1" })
    await startChild(fake, "w1")
    await runStep(fake, { agentId: "w1", turnId: "t1" }, { input_tokens: 900, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    // Over soft before completion: the batch nudges.
    assert.equal(await nudges(), 1)
    await completeTurn(fake, { agentId: "w1", turnId: "t1" })
    // Completion of the unhanded-over child cleared the measurement: no nudge without fresh steps.
    assert.deepEqual((await batch(fake, { agent_id: "w1" })).additionalContext ?? [], [])
    assert.equal(fake.store.get(pinKey("w1")), undefined)
    // A genuinely new open turn re-enables measurement with the pin present
    // inside next (before the first resumed request runs in-flight).
    let pinInsideNext: unknown = "unset"
    const hook = only(fake, "turn.step") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => AsyncGenerator<unknown, StepResult, StepResult | undefined>,
    ) => AsyncGenerator<unknown, StepResult, StepResult | undefined>
    async function* probingNext(): AsyncGenerator<unknown, StepResult, StepResult | undefined> {
      pinInsideNext = fake.store.get(pinKey("w1"))
      yield { kind: "text", text: "chunk" }
      return { usage: { input_tokens: 1100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" } }
    }
    const stream = hook(fake.$, { agentId: "w1", turnId: "t2" }, probingNext as never)
    for (;;) {
      const item = await stream.next()
      if (item.done === true) break
    }
    assert.ok(isChainPin(pinInsideNext))
    assert.ok(fake.store.get(pinKey("w1")))
    assert.equal(await nudges(), 1)
    // A late completion for the superseded turn preserves the fresh pin and state.
    await completeTurn(fake, { agentId: "w1", turnId: "t1" })
    assert.ok(fake.store.get(pinKey("w1")))
    assert.equal(await nudges(), 1)
    // A late step from the superseded turn changes nothing either.
    await runStep(fake, { agentId: "w1", turnId: "t1" }, { input_tokens: 9999, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    assert.equal(await nudges(), 1)
    // Handover after retirement reports honest unknown diagnostics: no fabricated baseline.
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "w1", handover: "body", summary: "s" })
    assert.match(String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "w1", full: true })).result), /Baseline: start-context-tokens=unknown, last-batch-increase=unknown\./)
  })

  it("keeps the once-per-turn stop latch across blocked stops and refreshes it on resume", async () => {
    const fake = makeFake()
    setup(fake)
    await handOver(fake, "m1", "body")
    const event = { agent_id: "m1", stop_hook_active: false, last_assistant_message: "other" }
    // A blocked terminal stop returns the base untouched without consuming the latch.
    assert.deepEqual(await stopHook(fake, event, async () => ({ block: "other hook" })), { block: "other hook" })
    assert.match(String((await stopHook(fake, event)).block), /ONLY/)
    assert.equal((await stopHook(fake, event)).block, undefined)
    // A resumed turn receives a fresh correction.
    await runStep(fake, { agentId: "m1", turnId: "resumed" }, null)
    assert.match(String((await stopHook(fake, event)).block), /ONLY/)
  })

  it("ignores late and superseded step callbacks without resurrecting measurements", async () => {
    const fake = makeFake({ soft: 1000 })
    setup(fake)
    fake.agents = childAgents("s1")
    const hook = only(fake, "classic.SubagentStart") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    await hook(fake.$, { agent_id: "s1", agent_type: "general-purpose" }, async () => ({}))
    await runStep(fake, { agentId: "s1", turnId: "t1" }, { input_tokens: 400, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await runStep(fake, { agentId: "s1", turnId: "t2" }, { input_tokens: 520, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    // Late callback from the superseded turn must not rewrite the growth delta.
    await runStep(fake, { agentId: "s1", turnId: "t1" }, { input_tokens: 9999, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "s1", handover: "body", summary: "s" })
    assert.match(String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "s1", full: true })).result), /Baseline: start-context-tokens=400, last-batch-increase=120\./)
  })

  it("reclaims completed, failed, and killed listings while unknown and running listings protect", async () => {
    const fake = makeFake()
    setup(fake)
    seedLegacy(fake, "done", 100, PAY)
    seedLegacy(fake, "broke", 200, PAY)
    seedLegacy(fake, "dead", 300, PAY)
    seedLegacy(fake, "guarded", 400, PAY)
    seedLegacy(fake, "weird", 500, PAY)
    fillOverBudget(fake, "z", 4)
    fake.agents = [
      { id: "done", type: "general-purpose", status: "completed" },
      { id: "broke", type: "general-purpose", status: "failed" },
      { id: "dead", type: "general-purpose", status: "killed" },
      { id: "guarded", type: "general-purpose", status: "running" },
      { id: "weird", type: "general-purpose", status: "mystery-status" },
    ]
    const done = await writeHandover(fake, "writer")
    assert.ok(done.result)
    assert.ok(isChildTombstone(fake.store.get("child:done")))
    assert.ok(isChildTombstone(fake.store.get("child:broke")))
    assert.ok(isChildTombstone(fake.store.get("child:dead")))
    assert.equal((fake.store.get("child:guarded") as ChildRecord).handover, big(PAY))
    assert.equal((fake.store.get("child:weird") as ChildRecord).handover, big(PAY))
  })

  it("holds refcounted reservations across overlapping same-predecessor spawns until all settle", async () => {
    const fake = makeFake()
    setup(fake)
    // Origin predecessor so the successors resolve to real origin members
    // (a successor of a legacy origin-less record would stay uncertain and
    // protect its refs indefinitely, which the uncertain test covers).
    seedOriginChain(fake, "P", ["pred"], 100, PAY)
    // One over-budget filler per step: each write has exactly one eligible
    // victim besides the reserved predecessor chain, so eviction order is exact.
    const addFiller = (id: string): void => {
      fake.store.set(`child:${id}`, { handover: big(3 * 1024 * 1024 + 65536), summary: "s", agentId: id, closed: true, storedAt: 9000 })
      fake.store.set(`spawn:${id}`, { agentType: "general-purpose", modelOverride: null, storedAt: 9000 })
    }
    const hook = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    // Two overlapping spawns from the same predecessor: protection starts
    // before next and each holds its own reservation while pending.
    let releaseFirst!: (value: Record<string, unknown>) => void
    let releaseSecond!: (value: Record<string, unknown>) => void
    const first = hook(fake.$, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("pred")} one` }, async () => new Promise((resolve) => { releaseFirst = resolve as never }))
    const second = hook(fake.$, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("pred")} two` }, async () => new Promise((resolve) => { releaseSecond = resolve as never }))
    // A concurrent write while both are pending cannot evict the predecessor chain.
    addFiller("fill1")
    assert.ok((await writeHandover(fake, "w1")).result)
    assert.ok(isChildTombstone(fake.store.get("child:fill1")))
    assert.equal((fake.store.get("child:pred") as ChildRecord).handover, big(PAY))
    // Settling the first spawn must not release protection while the second is still pending.
    releaseFirst({ model: "m", agentId: "s1" })
    assert.equal(((await first) as Record<string, unknown>).agentId, "s1")
    addFiller("fill2")
    assert.ok((await writeHandover(fake, "w2")).result)
    assert.ok(isChildTombstone(fake.store.get("child:fill2")))
    assert.equal((fake.store.get("child:pred") as ChildRecord).handover, big(PAY))
    // Once all settle, the predecessor chain is reclaimable again: oldest first.
    releaseSecond({ model: "m", agentId: "s2" })
    assert.equal(((await second) as Record<string, unknown>).agentId, "s2")
    // Retire the successors' active pins via turn completion (a real
    // lifecycle release; live pins would otherwise keep protecting the chain).
    await completeTurn(fake, { agentId: "s1" })
    await completeTurn(fake, { agentId: "s2" })
    assert.equal(fake.store.get(pinKey("s1")), undefined)
    assert.equal(fake.store.get(pinKey("s2")), undefined)
    // Push just over budget with a live-listed filler (protected itself), so
    // the released predecessor chain is the only reclaimable candidate.
    // Sized so evicting P (~66KB) fits but nothing else must go.
    fake.store.set("child:fill4", { handover: big(3108000), summary: "s", agentId: "fill4", closed: true, storedAt: 9500 })
    fake.store.set("spawn:fill4", { agentType: "general-purpose", modelOverride: null, storedAt: 9500 })
    fake.agents = [...fake.agents, ...childAgents("fill4")]
    assert.ok((await writeHandover(fake, "w4")).result)
    assert.ok(isChildTombstone(fake.store.get("child:pred")))
    assert.equal((fake.store.get("child:fill4") as ChildRecord).handover.length, 3108000)
  })

  it("releases its reservation when next rejects without masking the original failure", async () => {
    const fake = makeFake()
    setup(fake)
    seedOriginChain(fake, "P", ["pred"], 100, PAY)
    const hook = only(fake, "agent.spawn") as unknown as (
      $: Engine,
      event: Record<string, unknown>,
      next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>
    const failure = new Error("native spawn blew up")
    // Overlapping second same-predecessor spawn stays pending while the first rejects.
    let releaseSecond!: (value: Record<string, unknown>) => void
    const second = hook(fake.$, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("pred")} two` }, async () => new Promise((resolve) => { releaseSecond = resolve as never }))
    // The original rejection propagates unchanged (never a ReferenceError),
    // and the failed spawn's reservation is released exactly once.
    let seen: unknown = "unset"
    try {
      await hook(fake.$, { subagentType: "general-purpose", prompt: `${buildSuccessorMarker("pred")} one` }, async () => { throw failure })
      assert.fail("rejecting next must propagate")
    } catch (error) {
      seen = error
    }
    assert.equal(seen, failure)
    // The first exception must not drop the overlapping second reservation: a
    // concurrent write while it is pending still cannot evict the predecessor chain.
    const addFiller = (id: string): void => {
      fake.store.set(`child:${id}`, { handover: big(3 * 1024 * 1024 + 65536), summary: "s", agentId: id, closed: true, storedAt: 9000 })
      fake.store.set(`spawn:${id}`, { agentType: "general-purpose", modelOverride: null, storedAt: 9000 })
    }
    addFiller("fill1")
    assert.ok((await writeHandover(fake, "w1")).result)
    assert.ok(isChildTombstone(fake.store.get("child:fill1")))
    assert.equal((fake.store.get("child:pred") as ChildRecord).handover, big(PAY))
    // Once the remaining reservation settles, quota can reclaim the
    // predecessor chain again: retire its pin, then push just over budget
    // with a live-listed filler so the released chain is the only candidate.
    // A leaked reservation would keep it protected and deny the write.
    releaseSecond({ model: "m", agentId: "s2" })
    assert.equal(((await second) as Record<string, unknown>).agentId, "s2")
    await completeTurn(fake, { agentId: "s2" })
    assert.equal(fake.store.get(pinKey("s2")), undefined)
    fake.store.set("child:fill4", { handover: big(3108000), summary: "s", agentId: "fill4", closed: true, storedAt: 9500 })
    fake.store.set("spawn:fill4", { agentType: "general-purpose", modelOverride: null, storedAt: 9500 })
    fake.agents = [...fake.agents, ...childAgents("fill4")]
    assert.ok((await writeHandover(fake, "w4")).result)
    assert.ok(isChildTombstone(fake.store.get("child:pred")))
    assert.equal((fake.store.get("child:fill4") as ChildRecord).handover.length, 3108000)
  })
})
