// Credit-free Node fixtures: drive the actually exported register() wiring
// with a fake $/on harness. No models, no network, no filesystem.
import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import type { AgentInfo, CatchNext, ClassicSubagentStopResult, Engine, On, PlainCatchHook, ToolCallResult } from "./claude-types.ts"
import { register } from "./register.ts"
import {
  buildChildShortReply,
  buildClaudeChildIntro,
  buildClaudeChildNudge,
  buildClaudeRootIntro,
  buildClaudeSuccessorSeed,
  buildGenerationLine,
  buildHandoverStoredInstruction,
  buildLockedChildReply,
  buildProvenanceReadback,
  buildSuccessorMarker,
  buildSuccessorPointer,
  CHILD_HANDOVER_DESCRIPTION,
  CHILD_READ_DESCRIPTION,
  classifySuccessorMarker,
  countNextSteps,
  estimateSeedTokens,
  formatHandbackDelivered,
  HANDOVER_FULL,
  isSeedTooLarge,
  mergeProvenance,
  originalRecordKey,
  parseSuccessorMarker,
  READ_BEFORE_DECISION,
  READ_FULL,
  SUCCESSOR_MARKER_TAG,
  type ChildRecord,
  type OriginalRecord,
} from "./child.ts"
import { HANDOVER_SECTIONS } from "../source/shared/handover-text.ts"
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
  agents: AgentInfo[]
  listFails: boolean
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
  const fake = {
    handlers,
    catches: new Map<string, PlainCatchHook<Record<string, unknown>, unknown>>(),
    tools,
    store,
    readFailKeys,
    writeFailKeys,
    agents: [] as AgentInfo[],
    listFails: false,
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
        store.delete(key)
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
      "agent.spawn", "classic.PostToolBatch", "classic.SessionStart", "classic.SubagentStart", "classic.SubagentStop", "session.start", "tool.call",
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
      const rewritten = { ...event, message: stored.shortReply }
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
    assert.match(intro, /receives the full handover intact via mcp__auto-context-handover__read_handover/)
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
    assert.match(plain, /First call mcp__auto-context-handover__read_handover\(\{"childId":"a1"\}\) to read the full handover/)
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
        ["session.start", "turn.step", "classic.SessionStart", "classic.PostToolBatch", "classic.SubagentStart", "classic.SubagentStop", "agent.spawn", "tool.call"].includes(event),
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
    assert.match(text, /First call mcp__auto-context-handover__read_handover\(\{"childId":"a1"\}\) to read the full handover/)
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
    assert.equal(stored.summary, "did work")
    assert.equal(stored.agentId, "a1")
    assert.equal(stored.parentSessionId, "ses_host")
    assert.equal(stored.closed, true)
    assert.equal(Object.keys(Object.fromEntries(fake.store)).length, 1)
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
      assert.equal(input.message, stored.shortReply)
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
    await handOver(fake, "a1", "verbatim body here")
    const read = await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "a1" })
    const text = String(read.result)
    assert.match(text, /verbatim body here/)
    assert.match(text, /a1/)
    assert.ok(!text.includes("continued in session"))
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
    assert.ok(!String(first.block).includes((fake.store.get("child:a1") as ChildRecord).shortReply) || String(first.block).includes("locked after a context handover"))
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
    const corrected = await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: stored.shortReply })
    assert.match(String(corrected.block), /Call SubagentHandback now/)
    assert.match(String(corrected.block), /may not reach your parent/)
    assert.ok(String(corrected.block).includes(stored.shortReply))
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
      assert.match(reply, /First call mcp__auto-context-handover__read_handover\(\{"childId":"a1"\}\) to read the full handover/)
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
    assert.match(String(read.result), /tiny payload/)
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
      assert.equal(seen[0]?.message, stored.shortReply)
    }
    const stop = await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: stored.shortReply })
    assert.deepEqual(stop, { agent_id: "a1", stop_hook_active: false, last_assistant_message: stored.shortReply })
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
    reload.store.set("child:legacy", { handover: "legacy body", summary: "s", agentId: "legacy", shortReply: "Context handover (incomplete): s", closed: true, storedAt: 1 })
    const legacyRead = await toolCall(reload, { tool: READ_FULL, tool_use_id: "r2", childId: "legacy" })
    assert.match(String(legacyRead.result), /legacy body/)
    assert.match(String(legacyRead.result), /Diagnostics: reason=unknown, stage=unknown, estimated-context-tokens=unknown, soft-limit=unknown/)
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
    assert.deepEqual(fake.store.get("spawn:c1"), { agentType: "Explore", modelOverride: "opus", originAgentId: "c1", generation: 1 })
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
    assert.match(String((fake.store.get("child:c2") as ChildRecord).shortReply), /\(recorded: no override\)/)
    assert.ok(!String((fake.store.get("child:c2") as ChildRecord).shortReply).includes("unknown"))
    await spawn(fake, { subagentType: "Plan", model: "opus", fork: true }, { model: "parent-model", agentId: "c3" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t2", agentId: "c3", handover: "b", summary: "s" })
    assert.match(String((fake.store.get("child:c3") as ChildRecord).shortReply), /\(recorded: no override\)/)
    // Reload without spawn metadata stays unknown and honest.
    const reload = makeFake()
    setup(reload)
    reload.agents = [{ id: "c4", type: "general-purpose", status: "running" }]
    await toolCall(reload, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "c4", handover: "b", summary: "s" })
    assert.match(String((reload.store.get("child:c4") as ChildRecord).shortReply), /\(recorded: unknown, use predecessor spawn params\)/)
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
    assert.deepEqual(after.store.get("spawn:a1"), { agentType: "Other", modelOverride: "other", originAgentId: "a1", generation: 1 })
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
    assert.match(String(stored.shortReply), /same agent type \(recorded: Explore\)/)
    assert.match(String(stored.shortReply), /same model override \(recorded: unknown, use predecessor spawn params\)/)
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
    assert.deepEqual(fake.store.get("spawn:r1"), { agentType: "Explore", modelOverride: "opus", originAgentId: "r1", generation: 1 })
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
    assert.match(String((reloaded.store.get("child:r2") as ChildRecord).shortReply), /\(recorded: unknown, use predecessor spawn params\)/)
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
    assert.match(String((reloaded.store.get("child:w1") as ChildRecord).shortReply), /\(recorded: unknown, use predecessor spawn params\)/)
    // A spawn-meta read outage at handover time also degrades to unknown.
    const outage = makeFake()
    setup(outage)
    outage.agents = [{ id: "w2", type: "general-purpose", status: "running" }]
    outage.store.set("spawn:w2", { agentType: "Explore", modelOverride: "opus" })
    outage.readFailKeys.add("spawn:w2")
    const done = await toolCall(outage, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "w2", handover: "b", summary: "s" })
    assert.match(String(done.result), /\(recorded: unknown, use predecessor spawn params\)/)
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
    // Code never synthesizes a pending-none line for missing/legacy summaries.
    const legacy = makeFake()
    setup(legacy)
    legacy.store.set("child:old", { handover: "old body", summary: "", agentId: "old", shortReply: "Context handover (incomplete): handover stored.", closed: true, storedAt: 1 })
    legacy.agents = childAgents("old")
    const read = await toolCall(legacy, { tool: READ_FULL, tool_use_id: "r1", childId: "old" })
    assert.ok(!String(read.result).includes('User decisions pending'))
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
    assert.ok(text.includes(stored.shortReply))
    assert.equal(buildHandoverStoredInstruction(stored.shortReply), text)
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
    const corrected = await stopHook(fake, { agent_id: "a1", stop_hook_active: false, last_assistant_message: stored.shortReply })
    assert.match(String(corrected.block), /Call SubagentHandback now/)
    assert.ok(String(corrected.block).includes(stored.shortReply))
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
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "c1" })).result)
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
      assert.match(seed, new RegExp(`read_handover\\(\\{"childId":"c1"\\}\\)`))
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
    assert.ok(intro.includes('When a subagent returns a "Context handover (incomplete):" reply, read the full handover'))
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
    // Readback supplies the original verbatim once and the handover verbatim once.
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "g2" })).result)
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
    assert.deepEqual(fake.store.get("spawn:race1"), { agentType: "general-purpose", modelOverride: null, originAgentId: "race1", generation: 1 })
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "race1" })).result)
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
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "g2" })).result)
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
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "q1" })).result)
    assert.match(read, /original capture failed/)
    assert.match(read, /quota exceeded/)
    assert.match(read, /\(origin: q1\)/)
    // After a reload the persisted spawn error still reports the cause.
    const reloaded = makeFake()
    for (const [key, value] of fake.store) reloaded.store.set(key, value)
    setup(reloaded)
    const reread = String((await toolCall(reloaded, { tool: READ_FULL, tool_use_id: "r2", childId: "q1" })).result)
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
    const doomedRead = String((await toolCall(doomed, { tool: READ_FULL, tool_use_id: "r1", childId: "q9" })).result)
    assert.match(doomedRead, /has no stored original/)
  })

  it("serves successor-facing guidance, marker-prefix pointer, and payload-measured seed", async () => {
    const fake = makeFake()
    setup(fake)
    fake.agents = [{ id: "c1", type: "general-purpose", status: "running" }]
    await spawn(fake, { subagentType: "general-purpose", prompt: "origin task" }, { model: "m", agentId: "c1" })
    await toolCall(fake, { tool: HANDOVER_FULL, tool_use_id: "t1", agentId: "c1", handover: handoverBody(["do a"]), summary: "s" })
    const read = String((await toolCall(fake, { tool: READ_FULL, tool_use_id: "r1", childId: "c1" })).result)
    assert.match(read, /reference only/)
    assert.match(read, /must not be repeated/)
    assert.match(read, /trusted unless marked unverified/)
    assert.match(read, /preserve verification distinctions/)
    assert.match(read, /do not recast predecessor direct evidence as successor direct verification/)
    assert.match(read, /continue from 'Prioritized next steps'/i)
    assert.match(read, /SubagentHandback/)
    const pointer = buildSuccessorPointer("c1")
    assert.ok(pointer.startsWith(buildSuccessorMarker("c1")))
    assert.ok(read.includes(pointer))
    assert.ok(read.indexOf(buildSuccessorMarker("c1")) < read.indexOf(`read_handover({"childId":"c1"})`))
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
    const read = String((await toolCall(second, { tool: READ_FULL, tool_use_id: "r1", childId: "r2" })).result)
    assert.ok(read.includes("origin prompt text"))
    assert.match(read, /generation 2/)
    // Original read outage degrades honestly with quota wording, never fabricated.
    second.readFailKeys.add(originalRecordKey("r1"))
    const outage = String((await toolCall(second, { tool: READ_FULL, tool_use_id: "r2", childId: "r2" })).result)
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
    assert.equal(read.split(big).length - 1, 1)
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
    const reread = String((await toolCall(reloaded, { tool: READ_FULL, tool_use_id: "r2", childId: "e2" })).result)
    assert.ok(reread.includes(buildSuccessorPointer("e2")))
    assert.equal(reread.split(original).length - 1, 1)
    await spawnFor(reloaded, { subagentType: "general-purpose", prompt: `${buildSuccessorPointer("e2")} keep going` }, { model: "m", agentId: "e3" })
    await toolCall(reloaded, { tool: HANDOVER_FULL, tool_use_id: "t3", agentId: "e3", handover: handoverBody(["read c"]), summary: "gen3" })
    const gen3 = reloaded.store.get("child:e3") as ChildRecord
    assert.equal(gen3.generation, 3)
    assert.equal(gen3.originAgentId, "e1")
    const read3 = String((await toolCall(reloaded, { tool: READ_FULL, tool_use_id: "r3", childId: "e3" })).result)
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
    assert.equal(String((await toolCall(reloaded, { tool: READ_FULL, tool_use_id: "r4", childId: "o4" })).result).split(original).length - 1, 1)
  })
})
