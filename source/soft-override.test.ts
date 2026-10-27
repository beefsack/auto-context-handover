// Subagent soft-marker tests: node --test source/soft-override.test.ts.
// Pure parsing plus harness tests driving the real plugin setup with a fake host.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Plugin } from "@opencode/plugin"
import plugin from "./index.ts"
import { matchSoftMarker, parseSoftMarker } from "./soft-marker.ts"
import { SUBAGENT_BANNER } from "./soft-marker.ts"

const assistantMessage = (tokens: Record<string, unknown>) => ({
  type: "assistant",
  tokens,
  content: [{ type: "text", text: "x".repeat(100) }],
})

interface Fake {
  ctx: Plugin.Context
  hooks: Map<string, (event: Record<string, unknown>) => Promise<void> | void>
  storage: Map<string, unknown>
  failSetKeys: Set<string>
  sessions: Map<string, { id: string; parentID?: string; agent?: string; history: Array<Record<string, unknown>> }>
  created: Array<Record<string, unknown>>
  prompted: Array<Record<string, unknown>>
}

const makeFake = (options: unknown, events: Array<Record<string, unknown>> = []): Fake => {
  const hooks = new Map<string, (event: Record<string, unknown>) => Promise<void> | void>()
  const storage = new Map<string, unknown>()
  const failSetKeys = new Set<string>()
  const sessions = new Map<string, { id: string; parentID?: string; agent?: string; history: Array<Record<string, unknown>> }>()
  const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }>()
  const fake = {
    hooks,
    storage,
    failSetKeys,
    sessions,
    created: [] as Array<Record<string, unknown>>,
    prompted: [] as Array<Record<string, unknown>>,
  } as unknown as Fake
  const ctx = {
    options,
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (tool: { name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }) => tools.set(tool.name, tool) })
        const bound = { tools, execute: async (name: string, input: unknown, context: unknown) => tools.get(name)?.execute(input, context) }
        ;(fake as unknown as { runner: unknown }).runner = bound
        return { dispose: async () => undefined }
      },
    },
    session: {
      hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void> | void) => {
        hooks.set(name, callback)
        return { dispose: async () => undefined }
      },
      get: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID),
      create: async (input: Record<string, unknown>) => {
        fake.created.push(input)
        const id = `ses_new_${fake.created.length}`
        sessions.set(id, { id, history: [] })
        return { id }
      },
      prompt: async (input: Record<string, unknown>) => {
        fake.prompted.push(input)
        return { id: "inbox_1" }
      },
      synthetic: async () => ({ id: "inbox_2" }),
      context: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID)?.history ?? [],
    },
    model: {
      list: async () => ({
        location: {},
        data: [{ providerID: "anthropic", id: "claude", limit: { context: 200000, input: 200000 } }],
      }),
    },
    storage: {
      get: async (key: string) => storage.get(key),
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

const setup = (fake: Fake) => (plugin as unknown as { setup: (ctx: Plugin.Context) => Promise<void> }).setup(fake.ctx)

const promptEvent = (sessionID: string, text: string) => ({
  sessionID,
  messageID: "msg_1",
  prompt: { text },
  delivery: "steer",
})

const contextEvent = (sessionID: string, tools: Record<string, unknown> = {}) => ({
  sessionID,
  agent: "build",
  model: { providerID: "anthropic", id: "claude" },
  system: [],
  messages: [] as Array<unknown>,
  options: {},
  tools,
})

const handoverTool = (fake: Fake) => {
  const runner = (fake as unknown as { runner: { tools: Map<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }> } }).runner
  return runner.tools.get("context_handover")
}

const promptHook = (fake: Fake) => {
  const hook = fake.hooks.get("prompt")
  assert.ok(hook)
  return hook
}

describe("parseSoftMarker", () => {
  it("accepts absolute integers and strips the marker", () => {
    assert.deepEqual(parseSoftMarker("[auto-context-handover-test soft=4096] do work"), { value: 4096, text: "do work" })
  })
  it("accepts percent strings", () => {
    assert.deepEqual(parseSoftMarker("[auto-context-handover-test soft=70%] do work"), { value: "70%", text: "do work" })
  })
  it("strips a bannered marker but keeps the banner", () => {
    const parsed = parseSoftMarker(`${SUBAGENT_BANNER}\n[auto-context-handover-test soft=4096]\nreal task`)
    assert.deepEqual(parsed, { value: 4096, text: `${SUBAGENT_BANNER}\nreal task` })
  })
  it("returns undefined without a marker prefix (no scanning)", () => {
    assert.equal(parseSoftMarker("do work"), undefined)
    assert.equal(parseSoftMarker('discuss "[auto-context-handover-test soft=1]" syntax'), undefined)
    assert.equal(parseSoftMarker("> [auto-context-handover-test soft=1]"), undefined)
    assert.equal(parseSoftMarker("do [auto-context-handover-test soft=1] later"), undefined)
    assert.equal(matchSoftMarker(`${SUBAGENT_BANNER} extra\n[auto-context-handover-test soft=1]`), undefined)
  })
  it("rejects empty markers", () => {
    assert.throws(() => parseSoftMarker("[auto-context-handover-test]"), /at least one/)
    assert.throws(() => parseSoftMarker("[auto-context-handover-test   ]"), /at least one/)
  })
  it("rejects malformed pairs", () => {
    for (const bad of ["soft", "soft=", "=5", "soft 4096"]) {
      assert.throws(() => parseSoftMarker(`[auto-context-handover-test ${bad}]`), /malformed/, bad)
    }
  })
  it("rejects an unclosed namespaced marker prefix", () => {
    assert.throws(() => parseSoftMarker("[auto-context-handover-test soft=4096"), /unclosed.*closing/)
    assert.throws(() => parseSoftMarker("[auto-context-handover-test soft=4096 and more prose"), /unclosed/)
    assert.throws(() => parseSoftMarker("[auto-context-handover-test"), /unclosed/)
    assert.throws(
      () => parseSoftMarker(`${SUBAGENT_BANNER}\n[auto-context-handover-test soft=1`),
      /unclosed/,
    )
  })
  it("leaves glued and other namespaces untouched", () => {
    assert.equal(parseSoftMarker("[auto-context-handover-testsoft=1] work"), undefined)
    assert.equal(parseSoftMarker("[auto-context-handover-tests soft=1] work"), undefined)
    assert.equal(parseSoftMarker("[auto-context-handover-test-foo soft=1] work"), undefined)
  })
  it("rejects unknown keys", () => {
    assert.throws(() => parseSoftMarker("[auto-context-handover-test hard=1000]"), /unknown key "hard"/)
    assert.throws(() => parseSoftMarker("[auto-context-handover-test soft=1 hard=2]"), /unknown key "hard"/)
  })
  it("rejects duplicate keys", () => {
    assert.throws(() => parseSoftMarker("[auto-context-handover-test soft=1 soft=2]"), /duplicate/)
  })
  it("rejects invalid soft values", () => {
    for (const bad of ["lots", "0", "-5", "0.7", "0%", "101%"]) {
      assert.throws(() => parseSoftMarker(`[auto-context-handover-test soft=${bad}]`), /invalid soft/, bad)
    }
  })
})

describe("subagent soft-marker hook", () => {
  it("stores the override and strips a bannered child initial prompt", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_kid", { id: "ses_kid", parentID: "ses_parent", history: [] })
    const event = promptEvent("ses_kid", `${SUBAGENT_BANNER}\n[auto-context-handover-test soft=4096]\nreal task`)
    await promptHook(fake)(event as unknown as Record<string, unknown>)
    const stored = fake.storage.get("auto-context-handover:soft-override:ses_kid") as { value: unknown; at: number }
    assert.equal(stored.value, 4096)
    assert.equal(typeof stored.at, "number")
    assert.equal(event.prompt.text, `${SUBAGENT_BANNER}\nreal task`)
  })

  it("accepts a bannerless child initial prompt", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_bare", { id: "ses_bare", parentID: "ses_parent", history: [] })
    const event = promptEvent("ses_bare", "[auto-context-handover-test soft=70%] do work")
    await promptHook(fake)(event as unknown as Record<string, unknown>)
    assert.equal((fake.storage.get("auto-context-handover:soft-override:ses_bare") as { value: unknown }).value, "70%")
    assert.equal(event.prompt.text, "do work")
  })

  it("ignores markers on root sessions", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_root", { id: "ses_root", history: [] })
    const text = "[auto-context-handover-test soft=4096] root work"
    const event = promptEvent("ses_root", text)
    await promptHook(fake)(event as unknown as Record<string, unknown>)
    assert.equal(fake.storage.get("auto-context-handover:soft-override:ses_root"), undefined)
    assert.equal(event.prompt.text, text)
  })

  it("ignores markers on later prompts", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_later", {
      id: "ses_later",
      parentID: "ses_parent",
      history: [{ type: "user", text: "first" }],
    })
    const text = "[auto-context-handover-test soft=4096] second"
    const event = promptEvent("ses_later", text)
    await promptHook(fake)(event as unknown as Record<string, unknown>)
    assert.equal(fake.storage.get("auto-context-handover:soft-override:ses_later"), undefined)
    assert.equal(event.prompt.text, text)
  })

  it("leaves quoted and mid-text markers alone on a child initial prompt", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_quote", { id: "ses_quote", parentID: "ses_parent", history: [] })
    const text = 'discuss "[auto-context-handover-test soft=1]" syntax'
    const event = promptEvent("ses_quote", text)
    await promptHook(fake)(event as unknown as Record<string, unknown>)
    assert.equal(fake.storage.get("auto-context-handover:soft-override:ses_quote"), undefined)
    assert.equal(event.prompt.text, text)
  })

  it("rejects unknown, duplicate, and invalid scoped markers with no stored override", async () => {
    for (const marker of [
      "[auto-context-handover-test hard=1000]",
      "[auto-context-handover-test soft=1 soft=2]",
      "[auto-context-handover-test soft=lots]",
      "[auto-context-handover-test]",
      "[auto-context-handover-test soft=4096",
    ]) {
      const fake = makeFake({})
      await setup(fake)
      fake.sessions.set("ses_bad", { id: "ses_bad", parentID: "ses_parent", history: [] })
      const event = promptEvent("ses_bad", `${marker} work`)
      await assert.rejects(async () => { await promptHook(fake)(event as unknown as Record<string, unknown>) }, /unknown key|duplicate|invalid soft|at least one|unclosed/)
      assert.equal(fake.storage.get("auto-context-handover:soft-override:ses_bad"), undefined)
      assert.equal(event.prompt.text, `${marker} work`)
    }
  })

  it("blocks admission when the override write fails, marker intact", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_fail", { id: "ses_fail", parentID: "ses_parent", history: [] })
    fake.failSetKeys.add("auto-context-handover:soft-override:ses_fail")
    const text = "[auto-context-handover-test soft=4096] work"
    const event = promptEvent("ses_fail", text)
    await assert.rejects(async () => { await promptHook(fake)(event as unknown as Record<string, unknown>) }, /NOT admitted/)
    assert.equal(fake.storage.get("auto-context-handover:soft-override:ses_fail"), undefined)
    assert.equal(event.prompt.text, text)
  })

  it("re-parses and replaces a stored override on retry with empty history", async () => {
    const same = makeFake({})
    await setup(same)
    same.sessions.set("ses_re", { id: "ses_re", parentID: "ses_parent", history: [] })
    same.storage.set("auto-context-handover:soft-override:ses_re", { value: 4096, at: 1 })
    const sameEvent = promptEvent("ses_re", "[auto-context-handover-test soft=4096] work")
    await promptHook(same)(sameEvent as unknown as Record<string, unknown>)
    assert.equal((same.storage.get("auto-context-handover:soft-override:ses_re") as { value: unknown }).value, 4096)
    assert.equal(sameEvent.prompt.text, "work")
    const changed = makeFake({})
    await setup(changed)
    changed.sessions.set("ses_ch", { id: "ses_ch", parentID: "ses_parent", history: [] })
    changed.storage.set("auto-context-handover:soft-override:ses_ch", { value: 1000, at: 1 })
    const changedEvent = promptEvent("ses_ch", "[auto-context-handover-test soft=70%] work")
    await promptHook(changed)(changedEvent as unknown as Record<string, unknown>)
    assert.equal((changed.storage.get("auto-context-handover:soft-override:ses_ch") as { value: unknown }).value, "70%")
    assert.equal(changedEvent.prompt.text, "work")
  })

  it("invalid retry after a stored override rejects without clobbering", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_inv", { id: "ses_inv", parentID: "ses_parent", history: [] })
    fake.storage.set("auto-context-handover:soft-override:ses_inv", { value: 4096, at: 7 })
    const text = "[auto-context-handover-test soft=lots] work"
    const event = promptEvent("ses_inv", text)
    await assert.rejects(async () => { await promptHook(fake)(event as unknown as Record<string, unknown>) }, /invalid soft/)
    assert.deepEqual(fake.storage.get("auto-context-handover:soft-override:ses_inv"), { value: 4096, at: 7 })
    assert.equal(event.prompt.text, text)
  })

  it("corrupt stored record does not bypass validation and is replaced on valid retry", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_cor", { id: "ses_cor", parentID: "ses_parent", history: [] })
    fake.storage.set("auto-context-handover:soft-override:ses_cor", { unexpected: true })
    const text = "[auto-context-handover-test soft=lots] work"
    const event = promptEvent("ses_cor", text)
    await assert.rejects(async () => { await promptHook(fake)(event as unknown as Record<string, unknown>) }, /invalid soft/)
    const retry = promptEvent("ses_cor", "[auto-context-handover-test soft=4096] work")
    await promptHook(fake)(retry as unknown as Record<string, unknown>)
    assert.equal((fake.storage.get("auto-context-handover:soft-override:ses_cor") as { value: unknown }).value, 4096)
    assert.equal(retry.prompt.text, "work")
  })

  it("later history with a stored override is still ignored", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_old", { id: "ses_old", parentID: "ses_parent", history: [{ type: "user", text: "first" }] })
    fake.storage.set("auto-context-handover:soft-override:ses_old", { value: 4096, at: 7 })
    const text = "[auto-context-handover-test soft=70%] second"
    const event = promptEvent("ses_old", text)
    await promptHook(fake)(event as unknown as Record<string, unknown>)
    assert.deepEqual(fake.storage.get("auto-context-handover:soft-override:ses_old"), { value: 4096, at: 7 })
    assert.equal(event.prompt.text, text)
  })
})

describe("soft override precedence and lifecycle", () => {
  const estimate1100 = [assistantMessage({ input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })]

  it("outranks agent, model, and global soft while hard stays configured", async () => {
    const fake = makeFake({ soft: 100000, hard: 1500, agentOverrides: { build: 90000 }, modelOverrides: { claude: 80000 } })
    await setup(fake)
    fake.sessions.set("ses_prec", { id: "ses_prec", parentID: "ses_parent", history: estimate1100 })
    const quiet = contextEvent("ses_prec", {})
    await fake.hooks.get("context")?.(quiet as unknown as Record<string, unknown>)
    assert.equal(quiet.messages.length, 0)
    fake.storage.set("auto-context-handover:soft-override:ses_prec", { value: 1000, at: 1 })
    const nudged = contextEvent("ses_prec", {})
    await fake.hooks.get("context")?.(nudged as unknown as Record<string, unknown>)
    assert.equal(nudged.messages.length, 1)
    assert.match(JSON.stringify(nudged.messages[0]), /Auto-context-handover (notice|warning|final warning)\./)
    // Hard still gates at the configured 1500, untouched by the soft override.
    fake.sessions.set("ses_prec", {
      id: "ses_prec",
      parentID: "ses_parent",
      history: [assistantMessage({ input: 1500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    const hard = contextEvent("ses_prec", { bash: {}, context_handover: {} })
    await fake.hooks.get("context")?.(hard as unknown as Record<string, unknown>)
    assert.deepEqual(Object.keys(hard.tools), ["context_handover"])
  })

  it("starts no nudge on the first request without a usable anchor", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.storage.set("auto-context-handover:soft-override:ses_first", { value: 1000, at: 1 })
    fake.sessions.set("ses_first", { id: "ses_first", parentID: "ses_parent", history: [{ type: "user", text: "hi" }] })
    const event = contextEvent("ses_first", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    assert.equal(event.messages.length, 0)
    fake.sessions.set("ses_first", { id: "ses_first", parentID: "ses_parent", history: estimate1100 })
    const later = contextEvent("ses_first", {})
    await fake.hooks.get("context")?.(later as unknown as Record<string, unknown>)
    assert.equal(later.messages.length, 1)
  })

  it("survives setup reload and compaction with no inheritance to other sessions", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_kid", { id: "ses_kid", parentID: "ses_parent", history: [] })
    const admitted = promptEvent("ses_kid", "[auto-context-handover-test soft=1000] work")
    await promptHook(fake)(admitted as unknown as Record<string, unknown>)
    // Simulate restart: fresh setup closure over the same stored KV map.
    const stored = new Map(fake.storage)
    const reloaded = makeFake({})
    for (const [key, value] of stored) reloaded.storage.set(key, value)
    reloaded.sessions.set("ses_kid", { id: "ses_kid", parentID: "ses_parent", history: estimate1100 })
    await setup(reloaded)
    const nudged = contextEvent("ses_kid", {})
    await reloaded.hooks.get("context")?.(nudged as unknown as Record<string, unknown>)
    assert.equal(nudged.messages.length, 1)
    // Compaction replaces history; the KV override still applies.
    reloaded.sessions.set("ses_kid", { id: "ses_kid", parentID: "ses_parent", history: estimate1100 })
    const after = contextEvent("ses_kid", {})
    await reloaded.hooks.get("context")?.(after as unknown as Record<string, unknown>)
    assert.equal(after.messages.length, 1)
    // No inheritance: an unrelated session with the same estimate stays quiet.
    reloaded.sessions.set("ses_other", { id: "ses_other", history: estimate1100 })
    const other = contextEvent("ses_other", {})
    await reloaded.hooks.get("context")?.(other as unknown as Record<string, unknown>)
    assert.equal(other.messages.length, 0)
    assert.equal(reloaded.storage.get("auto-context-handover:soft-override:ses_other"), undefined)
  })

  it("does not inherit a parent override into an unmarked descendant", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.storage.set("auto-context-handover:soft-override:ses_parent", { value: 1000, at: 1 })
    fake.sessions.set("ses_desc", { id: "ses_desc", parentID: "ses_parent", history: estimate1100 })
    const event = contextEvent("ses_desc", {})
    await fake.hooks.get("context")?.(event as unknown as Record<string, unknown>)
    assert.equal(event.messages.length, 0)
    assert.equal(fake.storage.get("auto-context-handover:soft-override:ses_desc"), undefined)
  })

  it("does not copy the override to handover successors", async () => {
    const fake = makeFake({})
    await setup(fake)
    fake.sessions.set("ses_src", { id: "ses_src", parentID: "ses_parent", agent: "build", history: [] })
    fake.storage.set("auto-context-handover:soft-override:ses_src", { value: 1000, at: 1 })
    await fake.hooks.get("context")?.(contextEvent("ses_src", {}) as unknown as Record<string, unknown>)
    const tool = handoverTool(fake)
    assert.ok(tool)
    await tool.execute({ handover: "child work", summary: "done" }, { sessionID: "ses_src", agent: "build" })
    assert.equal(fake.created.length, 0)
    assert.equal(fake.storage.get("auto-context-handover:soft-override:ses_new_1"), undefined)
  })

  it("cleans the override on session.deleted", async () => {
    const fake = makeFake({}, [{ type: "session.deleted", data: { sessionID: "ses_gone" } }])
    fake.storage.set("auto-context-handover:soft-override:ses_gone", { value: 1000, at: 1 })
    fake.storage.set("auto-context-handover:handover:ses_gone", { text: "t" })
    await setup(fake)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(fake.storage.get("auto-context-handover:soft-override:ses_gone"), undefined)
    assert.equal(fake.storage.get("auto-context-handover:handover:ses_gone"), undefined)
  })

  it("caps a stored integer child override at 70% of the window", async () => {
    const fake = makeFake({})
    await setup(fake)
    // Window is 200000, so soft=190000 caps at 140000.
    fake.storage.set("auto-context-handover:soft-override:ses_cap", { value: 190000, at: 1 })
    fake.sessions.set("ses_cap", {
      id: "ses_cap",
      parentID: "ses_parent",
      history: [assistantMessage({ input: 130000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    const quiet = contextEvent("ses_cap", {})
    await fake.hooks.get("context")?.(quiet as unknown as Record<string, unknown>)
    assert.equal(quiet.messages.length, 0)
    fake.sessions.set("ses_cap", {
      id: "ses_cap",
      parentID: "ses_parent",
      history: [assistantMessage({ input: 145000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })],
    })
    const nudged = contextEvent("ses_cap", {})
    await fake.hooks.get("context")?.(nudged as unknown as Record<string, unknown>)
    assert.equal(nudged.messages.length, 1)
  })
})
