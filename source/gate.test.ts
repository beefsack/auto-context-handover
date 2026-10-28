// Harness test: drives the real plugin setup with a fake host context.
// Every primary-path test invokes the context hook before the tool, like the
// real host does. No paid model calls, no server, no filesystem.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Plugin } from "@opencode/plugin"
import plugin from "./index.ts"
import { buildChildHardDirective, buildChildNudge, buildHardDirective, buildLockedChildDirective, buildLockedChildReturn, buildNudge, buildSubagentReturn, buildSuccessorSeed, HANDOVER_DESCRIPTION } from "./text.ts"

interface AddedTool {
  name: string
  options?: { codemode?: boolean }
  execute: (input: Record<string, unknown>, context: Record<string, unknown>) => Promise<{ content?: unknown; metadata?: unknown }>
}

interface SessionInfo {
  id: string
  parentID?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  location?: { directory: string }
  history?: Array<Record<string, unknown>>
}

interface Fake {
  ctx: Plugin.Context
  tools: Map<string, AddedTool>
  hooks: Map<string, (event: Record<string, unknown>) => Promise<void> | void>
  storage: Map<string, unknown>
  failSetKeys: Set<string>
  failGetKeys: Set<string>
  sessions: Map<string, SessionInfo>
  getBehavior: (sessionID: string) => SessionInfo | undefined | Promise<SessionInfo | undefined>
  created: Array<Record<string, unknown>>
  createBehavior: (input: Record<string, unknown>) => { id: string } | Promise<{ id: string }>
  prompted: Array<Record<string, unknown>>
  promptBehavior: (input: Record<string, unknown>) => unknown
  synthetics: Array<Record<string, unknown>>
  syntheticBehavior: (input: Record<string, unknown>) => unknown
}

const assistantMessage = (tokens: Record<string, unknown>, toolChars = 0) => ({
  type: "assistant",
  tokens,
  content: [
    { type: "text", text: "x".repeat(100) },
    ...(toolChars > 0
      ? [{ type: "tool", state: { status: "completed", input: { q: 1 }, content: [{ type: "text", text: "y".repeat(toolChars) }] } }]
      : []),
  ],
})

const makeFake = (options: unknown, events: Array<Record<string, unknown>> = []): Fake => {
  const tools = new Map<string, AddedTool>()
  const hooks = new Map<string, (event: Record<string, unknown>) => Promise<void> | void>()
  const storage = new Map<string, unknown>()
  const failSetKeys = new Set<string>()
  const failGetKeys = new Set<string>()
  const sessions = new Map<string, SessionInfo>()
  const fake: Fake = {
    tools,
    hooks,
    storage,
    failSetKeys,
    failGetKeys,
    sessions,
    getBehavior: (sessionID: string) => sessions.get(sessionID),
    created: [],
    createBehavior: (input: Record<string, unknown>) => {
      fake.created.push(input)
      const id = `ses_new_${fake.created.length}`
      sessions.set(id, { id, agent: input.agent as string, model: input.model as SessionInfo["model"], location: input.location as SessionInfo["location"] })
      return { id }
    },
    prompted: [],
    promptBehavior: (input: Record<string, unknown>) => {
      fake.prompted.push(input)
      return { id: "inbox_1" }
    },
    synthetics: [],
    syntheticBehavior: (input: Record<string, unknown>) => {
      fake.synthetics.push(input)
      return { id: "inbox_2" }
    },
  } as unknown as Fake
  const ctx = {
    options,
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (tool: AddedTool) => tools.set(tool.name, tool) })
        return { dispose: async () => undefined }
      },
    },
    session: {
      hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void> | void) => {
        hooks.set(name, callback)
        return { dispose: async () => undefined }
      },
      get: async ({ sessionID }: { sessionID: string }) => fake.getBehavior(sessionID),
      create: async (input: Record<string, unknown>) => fake.createBehavior(input),
      prompt: async (input: Record<string, unknown>) => fake.promptBehavior(input),
      synthetic: async (input: Record<string, unknown>) => fake.syntheticBehavior(input),
      context: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID)?.history ?? [],
    },
    model: {
      list: async () => ({
        location: {},
        data: [{ providerID: "anthropic", id: "claude", limit: { context: 200000, input: 200000 } }],
      }),
    },
    storage: {
      get: async (key: string) => {
        if (failGetKeys.has(key)) throw new Error(`injected read failure for ${key}`)
        return storage.get(key)
      },
      set: async (key: string, value: unknown) => {
        if (failSetKeys.has(key)) throw new Error(`injected write failure for ${key}`)
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async () => ({ entries: [] }),
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: async function* () {
          for (const item of events) yield item
        },
      }),
    },
  }
  fake.ctx = ctx as unknown as Plugin.Context
  return fake
}

const setup = (fake: Fake) =>
  (plugin as unknown as { setup: (ctx: Plugin.Context) => Promise<void> }).setup(fake.ctx)

const contextEvent = (sessionID: string, tools: Record<string, unknown>, model?: { providerID: string; id: string; variant?: string }, agent = "build") => ({
  sessionID,
  agent,
  model: model ?? { providerID: "anthropic", id: "claude" },
  system: [],
  messages: [] as Array<unknown>,
  options: {},
  tools,
})

const messageText = (messages: Array<unknown>): string => JSON.stringify(messages[0])

const seedOf = (text: string, sessionID: string): number => Math.ceil(buildSuccessorSeed(text, sessionID).length / 4)

const driveHandover = async (fake: Fake, sessionID: string, text: string, tokenSum: number) => {
  fake.sessions.set(sessionID, {
    id: sessionID,
    agent: "build",
    history: [assistantMessage({ input: tokenSum, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })],
  })
  const event = contextEvent(sessionID, {})
  await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
  const tool = fake.tools.get("context_handover")
  assert.ok(tool)
  return tool.execute({ handover: text, summary: "step done" }, { sessionID, agent: "build" })
}

// Host default routing: tools without options.codemode===false are NOT in
// event.tools directly; they hide behind the `execute` Code Mode tool.
const outgoingTools = (fake: Fake, extra: Record<string, unknown> = { bash: {}, read: {} }): Record<string, unknown> => {
  const direct: Record<string, unknown> = { ...extra }
  let codemoded = false
  for (const [name, tool] of fake.tools) {
    if (tool.options?.codemode === false) direct[name] = {}
    else codemoded = true
  }
  if (codemoded) direct.execute = {}
  return direct
}

describe("auto-context-handover harness", () => {
  it("registers the handover and read tools", async () => {
    const fake = makeFake({})
    await setup(fake)
    assert.ok(fake.tools.has("context_handover"))
    assert.ok(fake.tools.has("read_handover"))
    // Direct declarations: the host must list both outside Code Mode `execute`.
    assert.equal(fake.tools.get("context_handover")?.options?.codemode, false)
    assert.equal(fake.tools.get("read_handover")?.options?.codemode, false)
  })

  it("registers default guidance to hand over only after a nudge or explicit user request", async () => {
    const fake = makeFake({})
    await setup(fake)
    const tool = fake.tools.get("context_handover") as unknown as { description?: unknown }
    assert.equal(tool.description, HANDOVER_DESCRIPTION)
    assert.ok(HANDOVER_DESCRIPTION.startsWith(
      "Call this tool only after the plugin nudges you about the context limit, or when the user explicitly asks for a handover. " +
      "Do not call it just to finish a task; give a normal final response instead. " +
      "Once nudged, call exactly once per session when you are done with the current unit of work, then stop. ",
    ))
  })

  it("replaces the handover description fully with custom text", async () => {
    const fake = makeFake({ handoverDescription: "custom desc" })
    await setup(fake)
    const tool = fake.tools.get("context_handover") as unknown as { description?: unknown }
    assert.equal(tool.description, "custom desc")
  })

  it("allows an empty custom handover description", async () => {
    const fake = makeFake({ handoverDescription: "" })
    await setup(fake)
    const tool = fake.tools.get("context_handover") as unknown as { description?: unknown }
    assert.equal(tool.description, "")
  })

  it("leaves quiet requests untouched below soft", async () => {
    const fake = makeFake({ soft: "70%" })
    await setup(fake)
    fake.sessions.set("ses_quiet", {
      id: "ses_quiet",
      history: [assistantMessage({ input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    const event = contextEvent("ses_quiet", { bash: {}, read: {} })
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    assert.equal(event.messages.length, 0)
    assert.deepEqual(Object.keys(event.tools), ["bash", "read"])
  })

  it("appends a stable stage-only nudge at soft without touching tools", async () => {
    const fake = makeFake({ soft: 1000 })
    await setup(fake)
    fake.sessions.set("ses_nudge", {
      id: "ses_nudge",
      history: [assistantMessage({ input: 900, output: 100, reasoning: 50, cache: { read: 0, write: 0 } })],
    })
    const event = contextEvent("ses_nudge", { bash: {}, read: {} })
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    assert.equal(event.messages.length, 1)
    assert.match(messageText(event.messages), /Auto-context-handover (notice|warning|final warning)\./)
    assert.ok(!/%/.test(messageText(event.messages)), "nudge must not contain live percentages")
    assert.deepEqual(Object.keys(event.tools), ["bash", "read"])
  })

  it("hard-gates to the handover tool only, with a firm directive", async () => {
    const fake = makeFake({ soft: 1000, hard: 1500 })
    await setup(fake)
    assert.equal(fake.tools.get("context_handover")?.options?.codemode, false)
    fake.sessions.set("ses_hard", {
      id: "ses_hard",
      history: [assistantMessage({ input: 1200, output: 300, reasoning: 100, cache: { read: 0, write: 0 } })],
    })
    const outgoing = outgoingTools(fake, { bash: {}, read: {}, execute: {} })
    assert.ok(outgoing.execute, "other host tools hide behind execute")
    assert.ok(outgoing.context_handover, "registered handover is direct, not codemoded")
    const event = contextEvent("ses_hard", outgoing)
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    assert.deepEqual(Object.keys(event.tools), ["context_handover"])
    assert.match(messageText(event.messages), /Only the context_handover tool remains available/)
  })

  it("requires hook-observed identity before the tool runs", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_noid", { id: "ses_noid", history: [] })
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "text", summary: "s" }, { sessionID: "ses_noid", agent: "build" }),
      /no request observed/,
    )
    assert.equal(fake.storage.get("auto-context-handover:handover:ses_noid"), undefined)
  })

  it("refuses when the session cannot be read, never guessing root", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.getBehavior = () => {
      throw new Error("gone")
    }
    const event = contextEvent("ses_gone", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "text", summary: "s" }, { sessionID: "ses_gone", agent: "build" }),
      /cannot read session ses_gone/,
    )
    assert.equal(fake.storage.get("auto-context-handover:handover:ses_gone"), undefined)
  })

  it("uses the active request identity, not stored session info", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_active", {
      id: "ses_active",
      agent: "stale-agent",
      model: { providerID: "stale-provider", id: "stale-model" },
      location: { directory: "/tmp/work" },
      history: [],
    })
    const event = contextEvent("ses_active", {}, { providerID: "anthropic", id: "claude" }, "build")
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await handover.execute({ handover: "did the thing", summary: "done" }, { sessionID: "ses_active", agent: "build" })
    assert.deepEqual(fake.created[0]?.model, { providerID: "anthropic", id: "claude" })
    assert.equal(fake.created[0]?.agent, "build")
    assert.equal(fake.created[0]?.parentID, undefined)
    const stored = fake.storage.get("auto-context-handover:handover:ses_active") as { model: unknown }
    assert.deepEqual(stored.model, { providerID: "anthropic", id: "claude" })
  })

  it("passes the active request variant to the successor session", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_variant", {
      id: "ses_variant",
      agent: "build",
      history: [],
    })
    const event = contextEvent("ses_variant", {}, { providerID: "anthropic", id: "claude", variant: "high" }, "build")
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await handover.execute({ handover: "did the thing", summary: "done" }, { sessionID: "ses_variant", agent: "build" })
    assert.deepEqual(fake.created[0]?.model, { providerID: "anthropic", id: "claude", variant: "high" })
  })

  it("omits variant from the successor model when the request has none", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_novariant", {
      id: "ses_novariant",
      agent: "build",
      history: [],
    })
    const event = contextEvent("ses_novariant", {}, { providerID: "anthropic", id: "claude" }, "build")
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await handover.execute({ handover: "did the thing", summary: "done" }, { sessionID: "ses_novariant", agent: "build" })
    assert.deepEqual(fake.created[0]?.model, { providerID: "anthropic", id: "claude" })
    assert.ok(!("variant" in ((fake.created[0]?.model ?? {}) as Record<string, unknown>)))
  })

  it("rotates a primary session to a fresh root and links both ways", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_primary", {
      id: "ses_primary",
      agent: "build",
      model: { providerID: "anthropic", id: "claude" },
      location: { directory: "/tmp/work" },
      history: [],
    })
    const event = contextEvent("ses_primary", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const result = await handover.execute(
      { handover: "did the thing. next: verify.", summary: "done, verify next" },
      { sessionID: "ses_primary", agent: "build" },
    )
    assert.equal(fake.created.length, 1)
    assert.deepEqual(fake.created[0]?.location, { directory: "/tmp/work" })
    assert.equal(fake.prompted.length, 1)
    assert.match(String((fake.prompted[0]?.text as string) ?? ""), /did the thing/)
    assert.match(String((fake.prompted[0]?.text as string) ?? ""), /ses_primary/)
    assert.ok(fake.storage.get("auto-context-handover:lock:ses_primary"))
    assert.ok(fake.storage.get("auto-context-handover:link:back:ses_new_1"))
    assert.ok(fake.storage.get("auto-context-handover:link:forward:ses_primary"))
    assert.equal(fake.synthetics.length, 1)
    assert.match(String(result.content), /ses_new_1/)
  })

  it("reuses the existing successor instead of minting a second root", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_retry", { id: "ses_retry", agent: "build", history: [] })
    fake.storage.set("auto-context-handover:link:forward:ses_retry", { sessionID: "ses_old", at: 1 })
    fake.storage.set("auto-context-handover:link:back:ses_old", { sessionID: "ses_retry", at: 1 })
    fake.sessions.set("ses_old", { id: "ses_old", agent: "build", history: [] })
    const event = contextEvent("ses_retry", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const result = await handover.execute({ handover: "again", summary: "s" }, { sessionID: "ses_retry", agent: "build" })
    assert.equal(fake.created.length, 0)
    assert.match(String(result.content), /ses_old/)
  })

  it("reports creation failure without locking, text retained", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_nocreate", { id: "ses_nocreate", agent: "build", history: [] })
    fake.createBehavior = () => {
      throw new Error("db down")
    }
    const event = contextEvent("ses_nocreate", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_nocreate", agent: "build" }),
      /NOT locked.*db down/,
    )
    assert.equal(fake.storage.get("auto-context-handover:lock:ses_nocreate"), undefined)
    assert.equal((fake.storage.get("auto-context-handover:handover:ses_nocreate") as { text: string }).text, "kept")
  })

  it("reports unreadable successors with their ID, retry reuses them", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_noread", { id: "ses_noread", agent: "build", history: [] })
    let reads = 0
    const realGet = fake.getBehavior
    fake.getBehavior = (sessionID: string) => {
      reads++
      if (sessionID !== "ses_noread" && reads < 3) throw new Error("not yet visible")
      return realGet(sessionID)
    }
    const event = contextEvent("ses_noread", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_noread", agent: "build" }),
      /ses_new_1.*NOT locked/,
    )
    const second = await handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_noread", agent: "build" })
    assert.equal(fake.created.length, 1)
    assert.match(String(second.content), /ses_new_1/)
  })

  it("never claims success when the lock write fails", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_nolock", { id: "ses_nolock", agent: "build", history: [] })
    fake.failSetKeys.add("auto-context-handover:lock:ses_nolock")
    const event = contextEvent("ses_nolock", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_nolock", agent: "build" }),
      /NOT locked/,
    )
    fake.failSetKeys.clear()
    const retry = await handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_nolock", agent: "build" })
    assert.equal(fake.created.length, 1)
    assert.match(String(retry.content), /Handover complete/)
  })

  it("reports prompt admission failure as locked with an uncertain successor", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_noprompt", { id: "ses_noprompt", agent: "build", history: [] })
    fake.promptBehavior = () => {
      throw new Error("inbox full")
    }
    const event = contextEvent("ses_noprompt", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_noprompt", agent: "build" }),
      /is locked.*admission failed.*inbox full/,
    )
    assert.ok(fake.storage.get("auto-context-handover:lock:ses_noprompt"))
  })

  it("still succeeds when only the visible forward link fails", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_nosynth", { id: "ses_nosynth", agent: "build", history: [] })
    fake.syntheticBehavior = () => {
      throw new Error("synthetic down")
    }
    const event = contextEvent("ses_nosynth", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const result = await handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_nosynth", agent: "build" })
    assert.match(String(result.content), /Handover complete/)
    assert.match(String(result.content), /forward link.*could not be written/)
  })

  it("rejects duplicates while a handover is in flight", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_dup", { id: "ses_dup", agent: "build", history: [] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.createBehavior = async (input: Record<string, unknown>) => {
      await gate
      fake.created.push(input)
      fake.sessions.set("ses_new_1", { id: "ses_new_1" })
      return { id: "ses_new_1" }
    }
    const event = contextEvent("ses_dup", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const first = handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_dup", agent: "build" })
    const second = await handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_dup", agent: "build" })
    assert.match(String(second.content), /already in progress/)
    release()
    const done = await first
    assert.match(String(done.content), /Handover complete/)
  })

  it("locked sessions reject handover retries without overwriting", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.storage.set("auto-context-handover:handover:ses_locked", { text: "original", summary: "o", agent: "a", model: {}, storedAt: 1 })
    fake.storage.set("auto-context-handover:lock:ses_locked", { reason: "continued in session ses_new_9", at: 1 })
    const event = contextEvent("ses_locked", { bash: {}, context_handover: {} })
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    assert.deepEqual(Object.keys(event.tools), [])
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const result = await handover.execute(
      { handover: "overwrite attempt", summary: "x" },
      { sessionID: "ses_locked", agent: "build" },
    )
    assert.match(String(result.content), /already locked/)
    assert.equal((fake.storage.get("auto-context-handover:handover:ses_locked") as { text: string }).text, "original")
  })

  it("returns subagent handovers with a persistent stop lock", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_child", { id: "ses_child", parentID: "ses_parent", agent: "build", history: [] })
    const event = contextEvent("ses_child", { bash: {}, context_handover: {} })
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const result = await handover.execute(
      { handover: "child work", summary: "child done" },
      { sessionID: "ses_child", agent: "build" },
    )
    assert.equal(fake.created.length, 0)
    assert.ok(fake.storage.get("auto-context-handover:lock:ses_child"))
    assert.match(String(result.content), /^Context handover \(incomplete\): child done/)
    assert.match(String(result.content), /NOT complete/)
    assert.match(String(result.content), /rollover/)
    assert.match(String(result.content), /read_handover\(\{"sessionID":"ses_child"\}\)/)
    assert.match(String(result.content), /same agent type/)
    assert.match(String(result.content), /original task pointer/)
    assert.match(String(result.content), /Prioritized next steps/)
    assert.match(String(result.content), /completed steps are done/)
    assert.match(String(result.content), /trusted unless marked unverified/)
    assert.match(String(result.content), /do not recast predecessor direct evidence/)
    assert.match(String(result.content), /may redirect/)
    assert.match(String(result.content), /user-owned decisions unrelated to context size/)
    assert.ok(!String(result.content).includes("(no model prescription)"))
    const later = contextEvent("ses_child", { bash: {}, context_handover: {} })
    await fake.hooks.get("context")?.(later as unknown as Record<string, unknown>)
    assert.deepEqual(Object.keys(later.tools), [])
  })

  it("reads back verbatim text with links from another session", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_src", { id: "ses_src", agent: "build", history: [] })
    fake.sessions.set("ses_other", { id: "ses_other", agent: "build", history: [] })
    const event = contextEvent("ses_src", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    const read = fake.tools.get("read_handover")
    assert.ok(handover && read)
    await handover.execute({ handover: "verbatim body", summary: "s" }, { sessionID: "ses_src", agent: "build" })
    const stored = await read.execute({ sessionID: "ses_src" }, { sessionID: "ses_other", agent: "build" })
    assert.match(String(stored.content), /verbatim body/)
    assert.match(String(stored.content), /continued in ses_new_1/)
    const missing = await read.execute({ sessionID: "ses_other" }, { sessionID: "ses_other", agent: "build" })
    assert.match(String(missing.content), /No handover stored/)
    await assert.rejects(read.execute({ sessionID: "missing" }, { sessionID: "ses_other", agent: "build" }), /does not exist/)
  })

  it("returns multi-page bodies whole with the truncation bypass flag", async () => {
    const fake = makeFake({})
    await setup(fake)
    const read = fake.tools.get("read_handover")
    assert.ok(read)
    assert.equal(read.options?.codemode, false)
    // Past the host truncation limits (50 KiB / 2000 lines): must not spill.
    const body = Array.from({ length: 2100 }, (_, i) => `line ${String(i).padStart(4, "0")} ` + "x".repeat(40)).join("\n")
    assert.ok(Buffer.byteLength(body, "utf8") > 50 * 1024)
    fake.sessions.set("ses_big", { id: "ses_big", agent: "build", history: [] })
    fake.sessions.set("ses_big_reader", { id: "ses_big_reader", agent: "build", history: [] })
    const event = contextEvent("ses_big", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await handover.execute({ handover: body, summary: "big" }, { sessionID: "ses_big", agent: "build" })
    const result = (await read.execute({ sessionID: "ses_big" }, { sessionID: "ses_big_reader", agent: "build" })) as {
      content: unknown
      metadata: unknown
    }
    assert.equal((result.metadata as { truncated?: boolean }).truncated, false)
    assert.ok(String(result.content).endsWith(body), "full body must arrive verbatim, no truncation marker")
    assert.ok(!String(result.content).includes("full output saved to"), "must not spill to a host file")
  })

  it("updates highWater in the hook and retains it across compaction", async () => {
    const fake = makeFake({ soft: 1000 })
    await setup(fake)
    const big = [assistantMessage({ input: 900, output: 100, reasoning: 50, cache: { read: 0, write: 0 } }, 4000)]
    fake.sessions.set("ses_water", { id: "ses_water", agent: "build", history: big })
    fake.storage.set("auto-context-handover:state:ses_water", { chain: 0, unproductive: 0, seedEstimate: 100, highWater: 0 })
    const event = contextEvent("ses_water", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const afterHook = fake.storage.get("auto-context-handover:state:ses_water") as { highWater: number }
    assert.ok(afterHook.highWater > 1000)
    // Compaction drops the visible estimate; highWater still proves progress.
    fake.sessions.set("ses_water", {
      id: "ses_water",
      agent: "build",
      history: [assistantMessage({ input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    fake.storage.set("auto-context-handover:link:back:ses_water", { sessionID: "ses_parent", at: 1 })
    const event2 = contextEvent("ses_water", {})
    await fake.hooks.get("context")?.(event2 as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await handover.execute({ handover: "more", summary: "s" }, { sessionID: "ses_water", agent: "build" })
    const state = fake.storage.get("auto-context-handover:state:ses_water") as { unproductive: number }
    assert.equal(state.unproductive, 0)
  })

  it("locks after the third consecutive unproductive handover without a new root", async () => {
    const fake = makeFake({ soft: 1000 })
    await setup(fake)
    fake.sessions.set("ses_loop", {
      id: "ses_loop",
      agent: "build",
      history: [assistantMessage({ input: 1100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    fake.storage.set("auto-context-handover:link:back:ses_loop", { sessionID: "ses_parent", at: 1 })
    fake.storage.set("auto-context-handover:state:ses_loop", { chain: 2, unproductive: 2, seedEstimate: 1100, highWater: 1200 })
    const event = contextEvent("ses_loop", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const result = await handover.execute({ handover: "x", summary: "s" }, { sessionID: "ses_loop", agent: "build" })
    assert.equal(fake.created.length, 0)
    assert.ok(fake.storage.get("auto-context-handover:lock:ses_loop"))
    assert.match(String(result.content), /loop guard locked/)
    assert.match(String(result.content), /no new root was created/)
    assert.ok(fake.storage.get("auto-context-handover:link:back:ses_loop"))
    assert.equal(fake.storage.get("auto-context-handover:link:forward:ses_loop"), undefined)
  })

  it("keeps the streak unchanged when the baseline is unmeasurable", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_dim", { id: "ses_dim", agent: "build", history: [] })
    fake.storage.set("auto-context-handover:link:back:ses_dim", { sessionID: "ses_parent", at: 1 })
    fake.storage.set("auto-context-handover:state:ses_dim", { chain: 1, unproductive: 1, seedEstimate: 300, highWater: 0 })
    const event = contextEvent("ses_dim", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await handover.execute({ handover: "x", summary: "s" }, { sessionID: "ses_dim", agent: "build" })
    const state = fake.storage.get("auto-context-handover:state:ses_dim") as { chain: number; unproductive: number }
    assert.deepEqual([state.chain, state.unproductive], [1, 1])
    assert.equal(fake.created.length, 1)
  })

  it("warns when the full seed exceeds half of soft", async () => {
    const fake = makeFake({ soft: 1000 })
    await setup(fake)
    fake.sessions.set("ses_seed", {
      id: "ses_seed",
      agent: "build",
      history: [assistantMessage({ input: 400, output: 50, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    const event = contextEvent("ses_seed", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const big = "x".repeat(2200)
    const result = await handover.execute({ handover: big, summary: "s" }, { sessionID: "ses_seed", agent: "build" })
    assert.match(String(result.content), /over 50% of the soft threshold/)
  })

  it("uses the hook-time snapshot, not a remeasure at tool time", async () => {
    const fake = makeFake({ soft: 1000 })
    await setup(fake)
    fake.sessions.set("ses_snap", {
      id: "ses_snap",
      agent: "build",
      history: [assistantMessage({ input: 5000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    fake.storage.set("auto-context-handover:link:back:ses_snap", { sessionID: "ses_parent", at: 1 })
    fake.storage.set("auto-context-handover:state:ses_snap", { chain: 0, unproductive: 2, seedEstimate: 300, highWater: 0 })
    const event = contextEvent("ses_snap", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    // History shrinks before the tool runs; accounting must still use the
    // pre-call snapshot (productive: 5500+ vs 300 seed).
    fake.sessions.set("ses_snap", { id: "ses_snap", agent: "build", history: [] })
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await handover.execute({ handover: "x", summary: "s" }, { sessionID: "ses_snap", agent: "build" })
    const state = fake.storage.get("auto-context-handover:state:ses_snap") as { unproductive: number }
    assert.equal(state.unproductive, 0)
  })

  it("cleans KV state on session.deleted", async () => {
    const fake = makeFake({}, [{ type: "session.deleted", data: { sessionID: "ses_gone" } }])
    fake.storage.set("auto-context-handover:handover:ses_gone", { text: "t" })
    fake.storage.set("auto-context-handover:lock:ses_gone", { reason: "r" })
    await setup(fake)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(fake.storage.get("auto-context-handover:handover:ses_gone"), undefined)
    assert.equal(fake.storage.get("auto-context-handover:lock:ses_gone"), undefined)
  })

  it("verifies, repairs, and locks a reused successor before prompting", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_re", { id: "ses_re", agent: "build", history: [] })
    fake.sessions.set("ses_old", { id: "ses_old", agent: "build", history: [] })
    fake.storage.set("auto-context-handover:link:forward:ses_re", { sessionID: "ses_old", at: 1 })
    fake.storage.set("auto-context-handover:link:back:ses_old", { sessionID: "ses_re", at: 1 })
    fake.storage.set("auto-context-handover:state:ses_old", { chain: 4, unproductive: 1, seedEstimate: 10, highWater: 0 })
    fake.failSetKeys.add("auto-context-handover:lock:ses_re")
    const event = contextEvent("ses_re", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    let atPrompt: Record<string, unknown> = {}
    fake.promptBehavior = (input: Record<string, unknown>) => {
      fake.prompted.push(input)
      atPrompt = {
        lock: fake.storage.get("auto-context-handover:lock:ses_re"),
        forward: fake.storage.get("auto-context-handover:link:forward:ses_re"),
        back: fake.storage.get("auto-context-handover:link:back:ses_old"),
        childState: fake.storage.get("auto-context-handover:state:ses_old"),
      }
      return { id: "inbox_1" }
    }
    await assert.rejects(
      handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_re", agent: "build" }),
      /source is NOT locked/,
    )
    assert.equal(fake.prompted.length, 0)
    fake.failSetKeys.clear()
    const retry = await handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_re", agent: "build" })
    assert.equal(fake.created.length, 0)
    assert.equal(fake.prompted.length, 1)
    assert.match(String(retry.content), /ses_old/)
    assert.match(String((fake.prompted[0] as { text?: unknown }).text ?? ""), /kept/)
    assert.match((atPrompt.lock as { reason: string }).reason, /continued in session ses_old/)
    assert.equal((atPrompt.forward as { sessionID: string }).sessionID, "ses_old")
    assert.equal((atPrompt.back as { sessionID: string }).sessionID, "ses_re")
    assert.equal((atPrompt.childState as { unproductive: number }).unproductive, 1)
  })

  it("repairs a missing back link on a reused successor without a second root", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_noback", { id: "ses_noback", agent: "build", history: [] })
    fake.sessions.set("ses_child", { id: "ses_child", agent: "build", history: [] })
    fake.storage.set("auto-context-handover:link:forward:ses_noback", { sessionID: "ses_child", at: 1 })
    const event = contextEvent("ses_noback", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const result = await handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_noback", agent: "build" })
    assert.equal(fake.created.length, 0)
    assert.match(String(result.content), /ses_child/)
    assert.equal((fake.storage.get("auto-context-handover:link:back:ses_child") as { sessionID: string }).sessionID, "ses_noback")
    assert.ok(fake.storage.get("auto-context-handover:state:ses_child"))
    assert.ok(fake.storage.get("auto-context-handover:lock:ses_noback"))
    assert.equal(fake.prompted.length, 1)
  })

  it("repairs missing successor state with the inherited streak", async () => {
    const fake = makeFake({ soft: 1000 })
    await setup(fake)
    fake.sessions.set("ses_nostate", { id: "ses_nostate", agent: "build", history: [] })
    fake.sessions.set("ses_kid", { id: "ses_kid", agent: "build", history: [] })
    fake.storage.set("auto-context-handover:link:forward:ses_nostate", { sessionID: "ses_kid", at: 1 })
    fake.storage.set("auto-context-handover:link:back:ses_kid", { sessionID: "ses_nostate", at: 1 })
    fake.sessions.set("ses_nostate", {
      id: "ses_nostate",
      agent: "build",
      history: [assistantMessage({ input: 500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    const event = contextEvent("ses_nostate", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_nostate", agent: "build" })
    const fullSeed = seedOf("kept", "ses_nostate")
    assert.deepEqual(fake.storage.get("auto-context-handover:state:ses_kid"), {
      chain: 0,
      unproductive: 0,
      seedEstimate: fullSeed,
      highWater: 0,
    })
    assert.equal(fake.created.length, 0)
  })

  it("reuses the in-memory successor when the forward-link write failed", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_nofwd", { id: "ses_nofwd", agent: "build", history: [] })
    fake.failSetKeys.add("auto-context-handover:link:forward:ses_nofwd")
    const event = contextEvent("ses_nofwd", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_nofwd", agent: "build" }),
      /link\/state writes failed.*NOT locked/,
    )
    assert.equal(fake.created.length, 1)
    assert.equal(fake.storage.get("auto-context-handover:link:forward:ses_nofwd"), undefined)
    assert.equal(fake.prompted.length, 0)
    fake.failSetKeys.clear()
    const retry = await handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_nofwd", agent: "build" })
    assert.equal(fake.created.length, 1)
    assert.match(String(retry.content), /ses_new_1/)
    assert.ok(fake.storage.get("auto-context-handover:link:forward:ses_nofwd"))
    assert.ok(fake.storage.get("auto-context-handover:lock:ses_nofwd"))
    assert.equal(fake.prompted.length, 1)
  })

  it("never prompts an unreadable reused successor", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_dark", { id: "ses_dark", agent: "build", history: [] })
    fake.storage.set("auto-context-handover:link:forward:ses_dark", { sessionID: "ses_ghost", at: 1 })
    const event = contextEvent("ses_dark", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_dark", agent: "build" }),
      /ses_ghost.*NOT locked/,
    )
    assert.equal(fake.created.length, 0)
    assert.equal(fake.prompted.length, 0)
    assert.equal(fake.storage.get("auto-context-handover:lock:ses_dark"), undefined)
    fake.sessions.set("ses_ghost", { id: "ses_ghost", agent: "build", history: [] })
    const retry = await handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_dark", agent: "build" })
    assert.equal(fake.created.length, 0)
    assert.equal(fake.prompted.length, 1)
    assert.match(String(retry.content), /ses_ghost/)
  })

  it("does not advance the source streak on create/readiness/lock failures", async () => {
    for (const mode of ["create", "readiness", "lock"] as const) {
      const fake = makeFake({ soft: 1000 })
      await setup(fake)
      const sourceID = `ses_fail_${mode}`
      fake.storage.set(`auto-context-handover:link:back:${sourceID}`, { sessionID: "ses_root", at: 1 })
      const original = { chain: 1, unproductive: 1, seedEstimate: 100, highWater: 200 }
      fake.storage.set(`auto-context-handover:state:${sourceID}`, { ...original })
      fake.sessions.set(sourceID, {
        id: sourceID,
        agent: "build",
        history: [assistantMessage({ input: 180, output: 20, reasoning: 0, cache: { read: 0, write: 0 } })],
      })
      const event = contextEvent(sourceID, {})
      await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
      if (mode === "create") {
        const realCreate = fake.createBehavior
        let calls = 0
        fake.createBehavior = (input: Record<string, unknown>) => {
          calls++
          if (calls === 1) throw new Error("db down once")
          return realCreate(input)
        }
      } else if (mode === "readiness") {
        const realGet = fake.getBehavior
        let calls = 0
        fake.getBehavior = (sessionID: string) => {
          calls++
          if (sessionID !== sourceID && calls === 2) throw new Error("not yet visible")
          return realGet(sessionID)
        }
      } else {
        fake.failSetKeys.add(`auto-context-handover:lock:${sourceID}`)
      }
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      await assert.rejects(
        handover.execute({ handover: "x".repeat(60), summary: "s" }, { sessionID: sourceID, agent: "build" }),
        /NOT locked/,
        mode,
      )
      assert.deepEqual(fake.storage.get(`auto-context-handover:state:${sourceID}`), original, mode)
      if (mode === "lock") fake.failSetKeys.clear()
      const retry = await handover.execute({ handover: "x".repeat(60), summary: "s" }, { sessionID: sourceID, agent: "build" })
      assert.match(String(retry.content), /Handover complete/, mode)
      assert.equal(fake.created.length, 1, mode)
      const childState = fake.storage.get("auto-context-handover:state:ses_new_1") as { chain: number; unproductive: number }
      assert.deepEqual([childState.chain, childState.unproductive], [2, 2], mode)
      assert.ok(fake.storage.get(`auto-context-handover:lock:${sourceID}`), mode)
    }
  })

  it("rotates root through three short successions, then loop-locks", async () => {
    const fake = makeFake({ soft: 100000 })
    await setup(fake)
    const rootText = "root work " + "x".repeat(200)
    const first = await driveHandover(fake, "ses_root", rootText, 50)
    assert.match(String(first.content), /ses_new_1/)
    const t1 = "s1 work " + "x".repeat(200)
    const s1 = await driveHandover(fake, "ses_new_1", t1, seedOf(rootText, "ses_root") + 50)
    assert.match(String(s1.content), /ses_new_2/)
    assert.equal((fake.storage.get("auto-context-handover:state:ses_new_2") as { unproductive: number }).unproductive, 1)
    const t2 = "s2 work " + "x".repeat(200)
    const s2 = await driveHandover(fake, "ses_new_2", t2, seedOf(t1, "ses_new_1") + 50)
    assert.match(String(s2.content), /ses_new_3/)
    assert.equal((fake.storage.get("auto-context-handover:state:ses_new_3") as { unproductive: number }).unproductive, 2)
    const t3 = "s3 work " + "x".repeat(200)
    const s3 = await driveHandover(fake, "ses_new_3", t3, seedOf(t2, "ses_new_2") + 50)
    assert.match(String(s3.content), /loop guard locked/)
    assert.equal(fake.created.length, 3)
    assert.ok(fake.storage.get("auto-context-handover:lock:ses_new_3"))
  })

  it("resets the streak on a productive handover and counts again", async () => {
    const fake = makeFake({ soft: 100000 })
    await setup(fake)
    const rootText = "root " + "x".repeat(200)
    await driveHandover(fake, "ses_proot", rootText, 50)
    const pText = "productive " + "x".repeat(200)
    const p = await driveHandover(fake, "ses_new_1", pText, seedOf(rootText, "ses_proot") + 30000)
    assert.match(String(p.content), /ses_new_2/)
    assert.equal((fake.storage.get("auto-context-handover:state:ses_new_2") as { unproductive: number }).unproductive, 0)
    const q1 = "q1 " + "x".repeat(200)
    await driveHandover(fake, "ses_new_2", q1, seedOf(pText, "ses_new_1") + 50)
    assert.equal((fake.storage.get("auto-context-handover:state:ses_new_3") as { unproductive: number }).unproductive, 1)
    const q2 = "q2 " + "x".repeat(200)
    await driveHandover(fake, "ses_new_3", q2, seedOf(q1, "ses_new_2") + 50)
    assert.equal((fake.storage.get("auto-context-handover:state:ses_new_4") as { unproductive: number }).unproductive, 2)
    const q3 = "q3 " + "x".repeat(200)
    const locked = await driveHandover(fake, "ses_new_4", q3, seedOf(q2, "ses_new_3") + 50)
    assert.match(String(locked.content), /loop guard locked/)
    assert.equal(fake.created.length, 4)
    assert.ok(fake.storage.get("auto-context-handover:lock:ses_new_4"))
  })

  it("replays only the short final reply on later hooks for a locked child", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_kid", { id: "ses_kid", parentID: "ses_parent", agent: "build", history: [] })
    const event = contextEvent("ses_kid", { bash: {}, context_handover: {} })
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const full = "child full handover body " + "z".repeat(100)
    const result = await handover.execute({ handover: full, summary: "child summary abc" }, { sessionID: "ses_kid", agent: "build" })
    assert.ok(!String(result.content).includes(full))
    const lock = fake.storage.get("auto-context-handover:lock:ses_kid") as { finalReply: string }
    assert.match(lock.finalReply, /child summary abc/)
    const later = contextEvent("ses_kid", { bash: {}, context_handover: {} })
    await fake.hooks.get("context")?.(later as unknown as Record<string, unknown>)
    assert.deepEqual(Object.keys(later.tools), [])
    const text = later.messages.map((message) => JSON.stringify(message)).join("\n")
    assert.match(text, /ONLY/)
    assert.match(text, /locked after a context handover/)
    assert.match(text, /cannot answer questions or do more work/)
    assert.match(text, /Context handover \(incomplete\):/)
    assert.match(text, /ses_kid/)
    assert.match(text, /read_handover/)
    assert.match(text, /same agent type/)
    assert.match(text, /fresh subagent/)
    assert.ok(!text.includes(full))
    assert.ok(!text.includes("child summary abc"))
  })

  it("lock mode stores the handover with a session read hint and no successor", async () => {
    const fake = makeFake({ onHandover: { primary: "lock" } })
    await setup(fake)
    fake.sessions.set("ses_lm", { id: "ses_lm", agent: "build", history: [] })
    const event = contextEvent("ses_lm", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const result = await handover.execute({ handover: "locked body", summary: "s" }, { sessionID: "ses_lm", agent: "build" })
    assert.equal(fake.created.length, 0)
    assert.ok(fake.storage.get("auto-context-handover:lock:ses_lm"))
    assert.match(String(result.content), /ses_lm/)
    assert.match(String(result.content), /read_handover/)
    assert.match(String(result.content), /[Nn]o successor/)
    const later = contextEvent("ses_lm", { bash: {} })
    await fake.hooks.get("context")?.(later as unknown as Record<string, unknown>)
    assert.deepEqual(Object.keys(later.tools), [])
  })

  it("refuses the handover when storage reads fail instead of overwriting locks", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_out", { id: "ses_out", agent: "build", history: [] })
    fake.failGetKeys.add("auto-context-handover:lock:ses_out")
    const event = contextEvent("ses_out", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "text", summary: "s" }, { sessionID: "ses_out", agent: "build" }),
      /storage unavailable/,
    )
    assert.equal(fake.storage.get("auto-context-handover:handover:ses_out"), undefined)
  })

  it("read_handover surfaces storage outage instead of 'no handover'", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_ro", { id: "ses_ro", agent: "build", history: [] })
    fake.failGetKeys.add("auto-context-handover:handover:ses_ro")
    const read = fake.tools.get("read_handover")
    assert.ok(read)
    await assert.rejects(
      read.execute({ sessionID: "ses_ro" }, { sessionID: "ses_ro", agent: "build" }),
      /storage unavailable/,
    )
  })

  it("read_handover reports host session errors instead of 'does not exist'", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.getBehavior = () => {
      throw new Error("host down")
    }
    const read = fake.tools.get("read_handover")
    assert.ok(read)
    await assert.rejects(
      read.execute({ sessionID: "ses_x" }, { sessionID: "ses_x", agent: "build" }),
      /cannot read session/,
    )
  })

  it("clears the pre-call snapshot when a new request is unmeasurable", async () => {
    const fake = makeFake({ soft: 1000 })
    await setup(fake)
    fake.storage.set("auto-context-handover:link:back:ses_clr", { sessionID: "ses_parent", at: 1 })
    fake.storage.set("auto-context-handover:state:ses_clr", { chain: 1, unproductive: 1, seedEstimate: 300, highWater: 0 })
    fake.sessions.set("ses_clr", {
      id: "ses_clr",
      agent: "build",
      history: [assistantMessage({ input: 5000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    await fake.hooks.get("context")?.(contextEvent("ses_clr", {}) as unknown as Record<string, unknown>)
    fake.sessions.set("ses_clr", { id: "ses_clr", agent: "build", history: [] })
    await fake.hooks.get("context")?.(contextEvent("ses_clr", {}) as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await handover.execute({ handover: "x", summary: "s" }, { sessionID: "ses_clr", agent: "build" })
    const state = fake.storage.get("auto-context-handover:state:ses_clr") as { chain: number; unproductive: number }
    assert.deepEqual([state.chain, state.unproductive], [1, 1])
  })

  it("does not leak request identity between plugin instances", async () => {
    const fakeA = makeFake({})
    const fakeB = makeFake({})
    await setup(fakeA)
    await setup(fakeB)
    fakeA.sessions.set("ses_iso", { id: "ses_iso", agent: "build", history: [] })
    fakeB.sessions.set("ses_iso", { id: "ses_iso", agent: "build", history: [] })
    await fakeA.hooks.get("context")?.(contextEvent("ses_iso", {}) as unknown as Record<string, unknown>)
    const handoverB = fakeB.tools.get("context_handover")
    assert.ok(handoverB)
    await assert.rejects(
      handoverB.execute({ handover: "x", summary: "s" }, { sessionID: "ses_iso", agent: "build" }),
      /no request observed/,
    )
  })

  it("returns a cleanup that closes the event stream", async () => {
    const fake = makeFake({})
    const pluginSetup = plugin as unknown as { setup: (ctx: Plugin.Context) => Promise<unknown> }
    const cleanup = await pluginSetup.setup(fake.ctx)
    assert.equal(typeof cleanup, "function")
  })

  it("fails open with no usable usage anchor", async () => {
    const fake = makeFake({ soft: 1000 })
    await setup(fake)
    fake.sessions.set("ses_anchor", {
      id: "ses_anchor",
      history: [assistantMessage({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    const event = contextEvent("ses_anchor", { bash: {}, read: {} })
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    assert.equal(event.messages.length, 0)
    assert.deepEqual(Object.keys(event.tools), ["bash", "read"])
    fake.sessions.set("ses_anchor2", { id: "ses_anchor2", history: [] })
    const event2 = contextEvent("ses_anchor2", { bash: {} })
    await fake.hooks.get("context")?.(event2 as unknown as Record<string, unknown>)
    assert.equal(event2.messages.length, 0)
    assert.deepEqual(Object.keys(event2.tools), ["bash"])
  })

  it("directs the user to paste after uncertain prompt admission, never a locked retry", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_up", { id: "ses_up", agent: "build", history: [] })
    fake.promptBehavior = () => {
      throw new Error("inbox full")
    }
    const event = contextEvent("ses_up", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_up", agent: "build" }),
      (error: unknown) => {
        const message = String((error as Error).message)
        return (
          /is locked/.test(message) &&
          /user opens ses_new_1/.test(message) &&
          /read_handover for ses_up/.test(message) &&
          !/retry/.test(message)
        )
      },
    )
    const retry = await handover.execute({ handover: "kept", summary: "s" }, { sessionID: "ses_up", agent: "build" })
    assert.match(String(retry.content), /already locked/)
  })

  it("later primary lock directive names the session and read_handover", async () => {
    const fake = makeFake({ onHandover: { primary: "lock" } })
    await setup(fake)
    fake.sessions.set("ses_lm2", { id: "ses_lm2", agent: "build", history: [] })
    const event = contextEvent("ses_lm2", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await handover.execute({ handover: "locked body", summary: "s" }, { sessionID: "ses_lm2", agent: "build" })
    const later = contextEvent("ses_lm2", { bash: {} })
    await fake.hooks.get("context")?.(later as unknown as Record<string, unknown>)
    assert.deepEqual(Object.keys(later.tools), [])
    const text = later.messages.map((message) => JSON.stringify(message)).join("\n")
    assert.match(text, /Emit ONLY the following refusal/)
    assert.match(text, /read_handover/)
    assert.match(text, /ses_lm2/)
    assert.match(text, /another session/)
    const retry = await handover.execute({ handover: "x", summary: "y" }, { sessionID: "ses_lm2", agent: "build" })
    assert.match(String(retry.content), /already locked/)
    assert.match(String(retry.content), /read_handover/)
    assert.match(String(retry.content), /ses_lm2/)
  })

  it("rejects arbitrary unsupported primary values at setup", async () => {
    const fake = makeFake({ onHandover: { primary: "archive" } })
    await assert.rejects(setup(fake), /unsupported onHandover\.primary.*new-session.*lock/)
  })

  it("loop-guard lock failure reports NOT locked with no new root", async () => {
    const fake = makeFake({ soft: 1000 })
    await setup(fake)
    fake.sessions.set("ses_lfail", {
      id: "ses_lfail",
      agent: "build",
      history: [assistantMessage({ input: 1100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    fake.storage.set("auto-context-handover:link:back:ses_lfail", { sessionID: "ses_parent", at: 1 })
    fake.storage.set("auto-context-handover:state:ses_lfail", { chain: 2, unproductive: 2, seedEstimate: 1100, highWater: 1200 })
    fake.failSetKeys.add("auto-context-handover:lock:ses_lfail")
    const event = contextEvent("ses_lfail", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    await assert.rejects(
      handover.execute({ handover: "x", summary: "s" }, { sessionID: "ses_lfail", agent: "build" }),
      /loop guard tripped.*lock write failed.*NOT locked/,
    )
    assert.equal(fake.created.length, 0)
    assert.equal(fake.storage.get("auto-context-handover:lock:ses_lfail"), undefined)
  })

  it("loop-guard lock warns when the final state write fails", async () => {
    const fake = makeFake({ soft: 1000 })
    await setup(fake)
    fake.sessions.set("ses_lwarn", {
      id: "ses_lwarn",
      agent: "build",
      history: [assistantMessage({ input: 1100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    fake.storage.set("auto-context-handover:link:back:ses_lwarn", { sessionID: "ses_parent", at: 1 })
    fake.storage.set("auto-context-handover:state:ses_lwarn", { chain: 2, unproductive: 2, seedEstimate: 1100, highWater: 1200 })
    fake.failSetKeys.add("auto-context-handover:state:ses_lwarn")
    const event = contextEvent("ses_lwarn", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    const handover = fake.tools.get("context_handover")
    assert.ok(handover)
    const result = await handover.execute({ handover: "x", summary: "s" }, { sessionID: "ses_lwarn", agent: "build" })
    assert.match(String(result.content), /loop guard locked/)
    assert.match(String(result.content), /final loop-state write failed after locking/)
    assert.ok(fake.storage.get("auto-context-handover:lock:ses_lwarn"))
  })

  it("emits namespaced rollover metadata only on successful new-session rollover", async () => {
    const fake = makeFake({})
    await setup(fake)
    const result = await driveHandover(fake, "ses_meta", "work done " + "x".repeat(200), 50)
    assert.match(String(result.content), /Handover complete/)
    assert.match(String(result.content), /Continue in ses_new_1/)
    assert.deepEqual(result.metadata, { "auto-context-handover": { successorID: "ses_new_1" } })
  })

  it("omits rollover metadata for child, lock-mode, loop-guard, and failed handovers", async () => {
    const childFake = makeFake({})
    await setup(childFake)
    childFake.sessions.set("ses_kidm", { id: "ses_kidm", parentID: "ses_parent", agent: "build", history: [] })
    const childEvent = contextEvent("ses_kidm", {})
    await childFake.hooks.get("context")?.(childEvent as unknown as Record<string, unknown>)
    const childTool = childFake.tools.get("context_handover")
    assert.ok(childTool)
    const childResult = await childTool.execute({ handover: "body", summary: "s" }, { sessionID: "ses_kidm", agent: "build" })
    assert.equal(childResult.metadata, undefined)

    const lockFake = makeFake({ onHandover: { primary: "lock" } })
    await setup(lockFake)
    lockFake.sessions.set("ses_lmm", { id: "ses_lmm", agent: "build", history: [] })
    const lockEvent = contextEvent("ses_lmm", {})
    await lockFake.hooks.get("context")?.(lockEvent as unknown as Record<string, unknown>)
    const lockTool = lockFake.tools.get("context_handover")
    assert.ok(lockTool)
    const lockResult = await lockTool.execute({ handover: "body", summary: "s" }, { sessionID: "ses_lmm", agent: "build" })
    assert.match(String(lockResult.content), /[Nn]o successor/)
    assert.equal(lockResult.metadata, undefined)

    const loopFake = makeFake({ soft: 1000 })
    await setup(loopFake)
    loopFake.sessions.set("ses_loopm", {
      id: "ses_loopm",
      agent: "build",
      history: [assistantMessage({ input: 1100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    loopFake.storage.set("auto-context-handover:link:back:ses_loopm", { sessionID: "ses_parent", at: 1 })
    loopFake.storage.set("auto-context-handover:state:ses_loopm", { chain: 2, unproductive: 2, seedEstimate: 1100, highWater: 1200 })
    const loopEvent = contextEvent("ses_loopm", {})
    await loopFake.hooks.get("context")?.(loopEvent as unknown as Record<string, unknown>)
    const loopTool = loopFake.tools.get("context_handover")
    assert.ok(loopTool)
    const loopResult = await loopTool.execute({ handover: "x", summary: "s" }, { sessionID: "ses_loopm", agent: "build" })
    assert.match(String(loopResult.content), /loop guard locked/)
    assert.equal(loopResult.metadata, undefined)

    const failFake = makeFake({})
    await setup(failFake)
    failFake.createBehavior = () => {
      throw new Error("boom")
    }
    await assert.rejects(
      driveHandover(failFake, "ses_failm", "work " + "x".repeat(200), 50),
      /successor creation failed/,
    )
  })

  describe("capped integer soft limits", () => {
    const setWindow = (fake: Fake, windowTokens: number) => {
      const ctx = fake.ctx as unknown as {
        model: {
          list: () => Promise<{
            location: Record<string, unknown>
            data: Array<{ providerID: string; id: string; limit: { context: number; input: number } }>
          }>
        }
      }
      ctx.model.list = async () => ({
        location: {},
        data: [{ providerID: "anthropic", id: "claude", limit: { context: windowTokens, input: windowTokens } }],
      })
    }

    const estimateEvent = async (
      fake: Fake,
      sessionID: string,
      tokenSum: number,
      model?: { providerID: string; id: string },
      tools: Record<string, unknown> = { bash: {} },
    ) => {
      fake.sessions.set(sessionID, {
        id: sessionID,
        history: [assistantMessage({ input: tokenSum, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })],
      })
      const event = contextEvent(sessionID, tools, model)
      await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
      return event
    }

    it("caps the 150000 default at 70% on small windows", async () => {
      const fake = makeFake({})
      await setup(fake)
      setWindow(fake, 100000)
      const quiet = await estimateEvent(fake, "ses_small_quiet", 65000)
      assert.equal(quiet.messages.length, 0)
      const nudged = await estimateEvent(fake, "ses_small_nudged", 75000)
      assert.equal(nudged.messages.length, 1)
      assert.match(messageText(nudged.messages), /Auto-context-handover (notice|warning|final warning)\./)
    })

    it("leaves the 150000 default untouched on large windows", async () => {
      const fake = makeFake({})
      await setup(fake)
      setWindow(fake, 300000)
      const quiet = await estimateEvent(fake, "ses_large_quiet", 140000)
      assert.equal(quiet.messages.length, 0)
      const nudged = await estimateEvent(fake, "ses_large_nudged", 155000)
      assert.equal(nudged.messages.length, 1)
    })

    it("caps a configured integer soft but never the hard limit", async () => {
      const fake = makeFake({ soft: 190000, hard: 195000 })
      await setup(fake)
      const quiet = await estimateEvent(fake, "ses_cap_quiet", 130000)
      assert.equal(quiet.messages.length, 0)
      const warned = await estimateEvent(fake, "ses_cap_warned", 150000)
      assert.equal(warned.messages.length, 1)
      assert.match(messageText(warned.messages), /Auto-context-handover (notice|warning|final warning)\./)
      assert.deepEqual(Object.keys(warned.tools), ["bash"])
      const hard = await estimateEvent(fake, "ses_cap_hard", 196000, undefined, { bash: {}, context_handover: {} })
      assert.deepEqual(Object.keys(hard.tools), ["context_handover"])
      assert.match(messageText(hard.messages), /Only the context_handover tool remains available/)
    })

    it("caps agent-override integers the same as global soft", async () => {
      const fake = makeFake({ agentOverrides: { build: 190000 } })
      await setup(fake)
      const quiet = await estimateEvent(fake, "ses_ovr_quiet", 130000)
      assert.equal(quiet.messages.length, 0)
      const nudged = await estimateEvent(fake, "ses_ovr_nudged", 145000)
      assert.equal(nudged.messages.length, 1)
    })

    it("leaves percentage soft values uncapped", async () => {
      const fake = makeFake({ soft: "90%" })
      await setup(fake)
      setWindow(fake, 100000)
      const quiet = await estimateEvent(fake, "ses_pct_quiet", 75000)
      assert.equal(quiet.messages.length, 0)
      const nudged = await estimateEvent(fake, "ses_pct_nudged", 95000)
      assert.equal(nudged.messages.length, 1)
    })

    it("applies integer soft with an unknown window while percent fails open", async () => {
      const integerFake = makeFake({})
      await setup(integerFake)
      const nudged = await estimateEvent(integerFake, "ses_unk_int", 155000, { providerID: "unknown", id: "nope" })
      assert.equal(nudged.messages.length, 1)
      const percentFake = makeFake({ soft: "70%" })
      await setup(percentFake)
      const quiet = await estimateEvent(percentFake, "ses_unk_pct", 155000, { providerID: "unknown", id: "nope" })
      assert.equal(quiet.messages.length, 0)
      assert.deepEqual(Object.keys(quiet.tools), ["bash"])
    })
  })

  describe("child continuation default", () => {
    it("keeps root rollover wording while adding the child continuation note", async () => {
      const fake = makeFake({})
      await setup(fake)
      const tool = fake.tools.get("context_handover") as unknown as { description?: unknown }
      const description = String(tool.description)
      assert.match(description, /primary root session rotates/)
      assert.match(description, /onHandover\.primary=lock/)
      assert.match(description, /Child continuation default/)
      assert.match(description, /rollover, not task completion/)
      assert.match(description, /Context handover \(incomplete\):/)
      assert.match(description, /same-agent-type successor/)
      assert.match(description, /original task pointer/)
      assert.match(description, /Prioritized next steps/)
      assert.match(description, /completed steps are done/)
      assert.match(description, /trusted unless marked unverified/)
      assert.match(description, /do not recast predecessor direct evidence/)
      assert.match(description, /user-owned decisions unrelated to context size/)
    })

    it("shares the executable next-steps rule", () => {
      assert.match(HANDOVER_DESCRIPTION, /steps the successor can execute directly/)
      assert.match(HANDOVER_DESCRIPTION, /not a roadblock/)
      assert.match(HANDOVER_DESCRIPTION, /never a reason to ask the user/)
      assert.match(HANDOVER_DESCRIPTION, /only a user-owned decision that is independent of the context limit/)
    })

    it("prefixes the child short reply once and keeps the reader call exact", async () => {
      assert.equal(
        buildSubagentReturn("Context handover (incomplete): almost done", "ses_prefix"),
        buildSubagentReturn("almost done", "ses_prefix"),
      )
      const fake = makeFake({})
      await setup(fake)
      fake.sessions.set("ses_prefix", { id: "ses_prefix", parentID: "ses_parent", agent: "build", history: [] })
      const event = contextEvent("ses_prefix", {})
      await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      const plain = await handover.execute(
        { handover: "work", summary: "almost done" },
        { sessionID: "ses_prefix", agent: "build" },
      )
      assert.match(String(plain.content), /^Context handover \(incomplete\): almost done/)
      assert.match(String(plain.content), /read_handover\(\{"sessionID":"ses_prefix"\}\)/)
    })

    it("pins byte-identical root nudge and hard-directive wording", () => {
      assert.equal(
        buildNudge("warn1"),
        "Auto-context-handover notice. Context is filling. " +
          "Finish the current unit of work, then call the context_handover tool with the full handover text. " +
          "Do not start new work after this unit.",
      )
      assert.equal(
        buildNudge("warn2"),
        "Auto-context-handover warning. Wrap up now: complete only the step in progress, " +
          "then call the context_handover tool with the full handover text. Starting new work risks losing state to compaction.",
      )
      assert.equal(
        buildNudge("warn3"),
        "Auto-context-handover final warning. Stop after this step and call the context_handover tool " +
          "with the full handover text. Do not defer the handover past this response.",
      )
      assert.equal(
        buildHardDirective(undefined),
        "Context window hard limit reached. " +
          "Only the context_handover tool remains available. " +
          "Call it now with the full handover text, then stop. Do not attempt any other tool call; they are disabled.",
      )
    })

    it("frames only real-child nudges, leaving root text byte-identical", async () => {
      const fake = makeFake({ soft: 1000 })
      await setup(fake)
      fake.sessions.set("ses_root_nudge", {
        id: "ses_root_nudge",
        history: [assistantMessage({ input: 900, output: 100, reasoning: 50, cache: { read: 0, write: 0 } })],
      })
      const rootEvent = contextEvent("ses_root_nudge", { bash: {} })
      await fake.hooks.get("context")?.(rootEvent as unknown as Record<string, unknown>)
      assert.ok(messageText(rootEvent.messages).includes(JSON.stringify(buildNudge("warn1"))))
      fake.sessions.set("ses_child_nudge", {
        id: "ses_child_nudge",
        parentID: "ses_parent",
        agent: "build",
        history: [assistantMessage({ input: 900, output: 100, reasoning: 50, cache: { read: 0, write: 0 } })],
      })
      const childEvent = contextEvent("ses_child_nudge", { bash: {} })
      await fake.hooks.get("context")?.(childEvent as unknown as Record<string, unknown>)
      const childText = messageText(childEvent.messages)
      assert.ok(childText.includes(JSON.stringify(buildChildNudge("warn1"))))
      assert.match(childText, /rollover, not completion/)
      assert.match(childText, /normally continues in a successor/)
      assert.match(childText, /not guaranteed/)
      assert.match(childText, /Context handover \(incomplete\):/)
      assert.match(childText, /prioritized executable next steps/)
      assert.match(childText, /never turn context size/)
      assert.ok(!/%/.test(childText))
    })

    it("frames the child hard gate while the root directive stays byte-identical", async () => {
      const fake = makeFake({ soft: 1000, hard: 1500 })
      await setup(fake)
      fake.sessions.set("ses_child_hard", {
        id: "ses_child_hard",
        parentID: "ses_parent",
        agent: "build",
        history: [assistantMessage({ input: 1200, output: 300, reasoning: 100, cache: { read: 0, write: 0 } })],
      })
      const childEvent = contextEvent("ses_child_hard", { bash: {}, context_handover: {} })
      await fake.hooks.get("context")?.(childEvent as unknown as Record<string, unknown>)
      assert.deepEqual(Object.keys(childEvent.tools), ["context_handover"])
      const childText = messageText(childEvent.messages)
      assert.ok(childText.includes(JSON.stringify(buildChildHardDirective(1500))))
      assert.match(childText, /Only the context_handover tool remains available/)
      assert.match(childText, /normally continues in a successor/)
    })
  })

  describe("locked child follow-up and honest status", () => {
    it("keeps the initial child return as continuation while locked follow-ups are explicit", async () => {
      const fake = makeFake({})
      await setup(fake)
      fake.sessions.set("ses_init", { id: "ses_init", parentID: "ses_parent", agent: "build", history: [] })
      await fake.hooks.get("context")?.(contextEvent("ses_init", {}) as unknown as Record<string, unknown>)
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      const first = await handover.execute({ handover: "body", summary: "work done" }, { sessionID: "ses_init", agent: "build" })
      assert.match(String(first.content), /^Context handover \(incomplete\): work done/)
      assert.match(String(first.content), /NOT complete/)
      const retry = await handover.execute({ handover: "more", summary: "x" }, { sessionID: "ses_init", agent: "build" })
      assert.match(String(retry.content), /locked after a context handover/)
      assert.match(String(retry.content), /cannot answer questions or do more work/)
      assert.match(String(retry.content), /read_handover/)
      assert.match(String(retry.content), /ses_init/)
      assert.match(String(retry.content), /Handover not recorded/)
    })

    it("replaces legacy stored replies with explicit locked text, never replaying summaries", async () => {
      const fake = makeFake({})
      await setup(fake)
      fake.storage.set("auto-context-handover:handover:ses_legacy", { text: "legacy body", summary: "legacy summary", agent: "build", model: {}, storedAt: 1 })
      fake.storage.set("auto-context-handover:lock:ses_legacy", { reason: "subagent handover returned to parent", at: 1, finalReply: "Context handover (incomplete): legacy summary legacy" })
      fake.sessions.set("ses_legacy", { id: "ses_legacy", parentID: "ses_parent", agent: "build", history: [] })
      const later = contextEvent("ses_legacy", { bash: {} })
      await fake.hooks.get("context")?.(later as unknown as Record<string, unknown>)
      const text = later.messages.map((message) => JSON.stringify(message)).join("\n")
      assert.match(text, /locked after a context handover/)
      assert.match(text, /cannot answer questions/)
      assert.match(text, /Context handover \(incomplete\):.*locked after/)
      assert.ok(!text.includes("legacy summary legacy"))
      const read = fake.tools.get("read_handover")
      assert.ok(read)
      fake.sessions.set("ses_reader", { id: "ses_reader", agent: "build", history: [] })
      const out = await read.execute({ sessionID: "ses_legacy" }, { sessionID: "ses_reader", agent: "build" })
      assert.match(String(out.content), /legacy body/)
      assert.match(String(out.content), /Diagnostics: reason=unknown, stage=unknown, estimated-context-tokens=unknown, soft-limit=unknown/)
    })

    it("requires honest status in the shared template without rewriting stored text", async () => {
      assert.ok(HANDOVER_DESCRIPTION.includes("instruction deviations"))
      assert.ok(HANDOVER_DESCRIPTION.includes("stop conditions"))
      assert.ok(HANDOVER_DESCRIPTION.includes("failed or erroring calls"))
      assert.ok(HANDOVER_DESCRIPTION.includes("unverified claims"))
      assert.ok(HANDOVER_DESCRIPTION.includes("never mark work PASS or complete"))
      assert.ok(HANDOVER_DESCRIPTION.includes("summary must not claim more than the body"))
    })

    it("locks the child directive text to the exact builder", async () => {
      const built = buildLockedChildDirective("subagent handover returned to parent", "ses_exact")
      assert.ok(built.includes(JSON.stringify("ses_exact")))
      assert.match(built, /locked after a context handover/)
      assert.match(buildLockedChildReturn("ses_exact"), /^Context handover \(incomplete\):/)
    })
  })

  describe("handover diagnostics", () => {
    it("marks nudged handovers with stage, estimate, and soft from the pre-call snapshot", async () => {
      const fake = makeFake({ soft: 1000 })
      await setup(fake)
      fake.sessions.set("ses_diag_nudged", {
        id: "ses_diag_nudged",
        agent: "build",
        history: [assistantMessage({ input: 900, output: 100, reasoning: 50, cache: { read: 0, write: 0 } })],
      })
      await fake.hooks.get("context")?.(contextEvent("ses_diag_nudged", {}) as unknown as Record<string, unknown>)
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      await handover.execute({ handover: "tiny", summary: "s" }, { sessionID: "ses_diag_nudged", agent: "build" })
      const stored = fake.storage.get("auto-context-handover:handover:ses_diag_nudged") as { diag: { reason: string; stage: string; estimate: number; soft: number } }
      assert.equal(stored.diag.reason, "nudged")
      assert.equal(stored.diag.stage, "warn1")
      assert.equal(stored.diag.estimate, 1050)
      assert.equal(stored.diag.soft, 1000)
      fake.sessions.set("ses_diag_reader", { id: "ses_diag_reader", agent: "build", history: [] })
      const read = fake.tools.get("read_handover")
      assert.ok(read)
      const out = await read.execute({ sessionID: "ses_diag_nudged" }, { sessionID: "ses_diag_reader", agent: "build" })
      assert.match(String(out.content), /Diagnostics: reason=nudged, stage=warn1, estimated-context-tokens=1050, soft-limit=1000/)
    })

    it("marks quiet handovers not-nudged with the ok stage snapshot", async () => {
      const fake = makeFake({ soft: 100000 })
      await setup(fake)
      fake.sessions.set("ses_diag_quiet", {
        id: "ses_diag_quiet",
        agent: "build",
        history: [assistantMessage({ input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } })],
      })
      await fake.hooks.get("context")?.(contextEvent("ses_diag_quiet", {}) as unknown as Record<string, unknown>)
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      await handover.execute({ handover: "tiny", summary: "s" }, { sessionID: "ses_diag_quiet", agent: "build" })
      const stored = fake.storage.get("auto-context-handover:handover:ses_diag_quiet") as { diag: { reason: string; stage: string } }
      assert.equal(stored.diag.reason, "not-nudged")
      assert.equal(stored.diag.stage, "ok")
    })

    it("uses the snapshot, not the handover payload size, and stays unknown when unmeasurable", async () => {
      const fake = makeFake({ soft: 1000 })
      await setup(fake)
      fake.sessions.set("ses_diag_snap", {
        id: "ses_diag_snap",
        agent: "build",
        history: [assistantMessage({ input: 900, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })],
      })
      await fake.hooks.get("context")?.(contextEvent("ses_diag_snap", {}) as unknown as Record<string, unknown>)
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      const big = "x".repeat(20000)
      await handover.execute({ handover: big, summary: "s" }, { sessionID: "ses_diag_snap", agent: "build" })
      const stored = fake.storage.get("auto-context-handover:handover:ses_diag_snap") as { diag: { estimate: number } }
      assert.equal(stored.diag.estimate, 900 + 100)
      fake.sessions.set("ses_diag_unknown", { id: "ses_diag_unknown", agent: "build", history: [] })
      await fake.hooks.get("context")?.(contextEvent("ses_diag_unknown", {}) as unknown as Record<string, unknown>)
      await handover.execute({ handover: "tiny", summary: "s" }, { sessionID: "ses_diag_unknown", agent: "build" })
      const missing = fake.storage.get("auto-context-handover:handover:ses_diag_unknown") as { diag: { reason: string; stage: string; estimate: unknown; soft: unknown } }
      assert.equal(missing.diag.reason, "unknown")
      assert.equal(missing.diag.stage, "unknown")
      assert.equal(missing.diag.estimate, "unknown")
      assert.equal(missing.diag.soft, 1000)
    })

    it("keeps reason unknown with no snapshot and preserves known soft", async () => {
      const fake = makeFake({ soft: 1000 })
      await setup(fake)
      fake.sessions.set("ses_diag_nosnap", { id: "ses_diag_nosnap", agent: "build", history: [] })
      // Fresh instance observes the soft but has no usable usage anchor.
      await fake.hooks.get("context")?.(contextEvent("ses_diag_nosnap", {}) as unknown as Record<string, unknown>)
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      await handover.execute({ handover: "tiny", summary: "s" }, { sessionID: "ses_diag_nosnap", agent: "build" })
      const stored = fake.storage.get("auto-context-handover:handover:ses_diag_nosnap") as { diag: { reason: string; stage: string; estimate: unknown; soft: number } }
      assert.equal(stored.diag.reason, "unknown")
      assert.equal(stored.diag.stage, "unknown")
      assert.equal(stored.diag.estimate, "unknown")
      assert.equal(stored.diag.soft, 1000)
    })

    it("adds trailing chars at chars/4 without changing nudge text", async () => {
      const fake = makeFake({ soft: 1000 })
      await setup(fake)
      fake.sessions.set("ses_diag_trail", {
        id: "ses_diag_trail",
        agent: "build",
        history: [assistantMessage({ input: 900, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, 400)],
      })
      const event = contextEvent("ses_diag_trail", { bash: {} })
      await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
      assert.equal(event.messages.length, 1)
      const before = JSON.stringify(event.messages[0])
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      await handover.execute({ handover: "tiny", summary: "s" }, { sessionID: "ses_diag_trail", agent: "build" })
      const stored = fake.storage.get("auto-context-handover:handover:ses_diag_trail") as { diag: { estimate: number; stage: string; reason: string } }
      assert.equal(stored.diag.estimate, 1000 + Math.ceil(400 / 4))
      assert.equal(stored.diag.stage, "warn2")
      assert.equal(stored.diag.reason, "nudged")
      assert.equal(JSON.stringify(event.messages[0]), before)
    })

    it("resolves cap, later stages, and hard in diagnostics only", async () => {
      const fake = makeFake({ soft: 190000, hard: 195000 })
      await setup(fake)
      const ctx = fake.ctx as unknown as {
        model: { list: () => Promise<{ location: Record<string, unknown>; data: Array<{ providerID: string; id: string; limit: { context: number; input: number } }> }> }
      }
      ctx.model.list = async () => ({
        location: {},
        data: [{ providerID: "anthropic", id: "claude", limit: { context: 100000, input: 100000 } }],
      })
      fake.sessions.set("ses_diag_cap", {
        id: "ses_diag_cap",
        agent: "build",
        history: [assistantMessage({ input: 74000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } })],
      })
      const event = contextEvent("ses_diag_cap", { bash: {} })
      await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
      assert.equal(event.messages.length, 1)
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      await handover.execute({ handover: "tiny", summary: "s" }, { sessionID: "ses_diag_cap", agent: "build" })
      const capped = fake.storage.get("auto-context-handover:handover:ses_diag_cap") as { diag: { soft: number; stage: string; reason: string } }
      assert.equal(capped.diag.soft, 70000)
      assert.equal(capped.diag.stage, "warn1")
      assert.equal(capped.diag.reason, "nudged")
      fake.sessions.set("ses_diag_hard", {
        id: "ses_diag_hard",
        agent: "build",
        history: [assistantMessage({ input: 194000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } })],
      })
      const hardEvent = contextEvent("ses_diag_hard", { bash: {}, context_handover: {} })
      await fake.hooks.get("context")?.(hardEvent as unknown as Record<string, unknown>)
      assert.deepEqual(Object.keys(hardEvent.tools), ["context_handover"])
      await handover.execute({ handover: "tiny", summary: "s" }, { sessionID: "ses_diag_hard", agent: "build" })
      const hard = fake.storage.get("auto-context-handover:handover:ses_diag_hard") as { diag: { stage: string; reason: string } }
      assert.equal(hard.diag.stage, "hard")
      assert.equal(hard.diag.reason, "nudged")
    })

    it("keeps an estimate when the soft window is unknown", async () => {
      const fake = makeFake({ soft: "70%" })
      await setup(fake)
      fake.sessions.set("ses_diag_pct", {
        id: "ses_diag_pct",
        agent: "build",
        history: [assistantMessage({ input: 5000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } })],
      })
      const event = contextEvent("ses_diag_pct", { bash: {} }, { providerID: "unknown", id: "nope" })
      await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
      assert.equal(event.messages.length, 0)
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      await handover.execute({ handover: "tiny", summary: "s" }, { sessionID: "ses_diag_pct", agent: "build" })
      const stored = fake.storage.get("auto-context-handover:handover:ses_diag_pct") as { diag: { estimate: number; soft: unknown; stage: string; reason: string } }
      assert.equal(stored.diag.estimate, 5500)
      assert.equal(stored.diag.soft, "unknown")
      assert.equal(stored.diag.stage, "unknown")
      assert.equal(stored.diag.reason, "unknown")
    })

    it("observes the latest pre-call request, never the handover payload", async () => {
      const fake = makeFake({ soft: 1000 })
      await setup(fake)
      fake.sessions.set("ses_diag_latest", {
        id: "ses_diag_latest",
        agent: "build",
        history: [assistantMessage({ input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } })],
      })
      await fake.hooks.get("context")?.(contextEvent("ses_diag_latest", {}) as unknown as Record<string, unknown>)
      fake.sessions.set("ses_diag_latest", {
        id: "ses_diag_latest",
        agent: "build",
        history: [assistantMessage({ input: 5000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } })],
      })
      await fake.hooks.get("context")?.(contextEvent("ses_diag_latest", {}) as unknown as Record<string, unknown>)
      const handover = fake.tools.get("context_handover")
      assert.ok(handover)
      await handover.execute({ handover: "x".repeat(50000), summary: "s" }, { sessionID: "ses_diag_latest", agent: "build" })
      const stored = fake.storage.get("auto-context-handover:handover:ses_diag_latest") as { diag: { estimate: number; reason: string } }
      assert.equal(stored.diag.estimate, 5500)
      assert.equal(stored.diag.reason, "nudged")
    })
  })
})
