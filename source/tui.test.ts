// TUI follow tests: mocked TUI context, no host, no network, no model.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Plugin } from "@opencode/plugin/tui"
import { extractRollover, ROLLOVER_METADATA_KEY, setupFollow } from "./tui-follow.ts"

type Handler = (event: Record<string, unknown>) => void

interface TuiFake {
  ctx: Plugin.Context
  handlers: Map<string, Handler>
  route: { type: string; sessionID?: string }
  navigated: Array<Record<string, unknown>>
  getCalls: Array<string>
  getBehavior: (sessionID: string) => unknown
  unsubscribed: number
}

const makeTuiFake = (): TuiFake => {
  const fake = {} as TuiFake
  fake.handlers = new Map()
  fake.route = { type: "session", sessionID: "ses_source" }
  fake.navigated = []
  fake.getCalls = []
  fake.getBehavior = (sessionID: string) => ({ id: sessionID })
  fake.unsubscribed = 0
  const ctx = {
    data: {
      on: (type: string, handler: Handler) => {
        fake.handlers.set(type, handler)
        return () => {
          fake.unsubscribed += 1
          fake.handlers.delete(type)
        }
      },
    },
    ui: {
      router: {
        current: () => ({ ...fake.route }),
        navigate: (destination: Record<string, unknown>) => {
          fake.navigated.push(destination)
        },
      },
    },
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          fake.getCalls.push(sessionID)
          return fake.getBehavior(sessionID)
        },
      },
    },
  }
  fake.ctx = ctx as unknown as Plugin.Context
  return fake
}

const tick = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const successEvent = (sourceID: string, successor: unknown): Record<string, unknown> => ({
  type: "session.tool.success",
  data: {
    sessionID: sourceID,
    metadata: { [ROLLOVER_METADATA_KEY]: successor },
  },
})

const fire = (fake: TuiFake, event: Record<string, unknown>): void => {
  const handler = fake.handlers.get("session.tool.success")
  assert.ok(handler, "follow must subscribe to session.tool.success")
  handler(event)
}

describe("extractRollover", () => {
  it("accepts a namespaced successor different from the source", () => {
    assert.deepEqual(extractRollover(successEvent("ses_a", { successorID: "ses_b" })), {
      sourceID: "ses_a",
      successorID: "ses_b",
    })
  })

  it("rejects unrelated and malformed events", () => {
    const bad: Array<unknown> = [
      undefined,
      null,
      42,
      "event",
      {},
      { data: null },
      { data: {} },
      { data: { sessionID: "", metadata: { [ROLLOVER_METADATA_KEY]: { successorID: "ses_b" } } } },
      { data: { sessionID: "ses_a" } },
      { data: { sessionID: "ses_a", metadata: null } },
      { data: { sessionID: "ses_a", metadata: "text" } },
      { data: { sessionID: "ses_a", metadata: {} } },
      { data: { sessionID: "ses_a", metadata: { [ROLLOVER_METADATA_KEY]: null } } },
      { data: { sessionID: "ses_a", metadata: { [ROLLOVER_METADATA_KEY]: "ses_b" } } },
      { data: { sessionID: "ses_a", metadata: { [ROLLOVER_METADATA_KEY]: {} } } },
      { data: { sessionID: "ses_a", metadata: { [ROLLOVER_METADATA_KEY]: { successorID: "" } } } },
      { data: { sessionID: "ses_a", metadata: { [ROLLOVER_METADATA_KEY]: { successorID: 7 } } } },
      { data: { sessionID: "ses_a", metadata: { [ROLLOVER_METADATA_KEY]: { successorID: "ses_a" } } } },
    ]
    for (const event of bad) assert.equal(extractRollover(event), undefined, JSON.stringify(event))
  })
})

describe("setupFollow", () => {
  it("navigates to the verified successor when viewing the source", async () => {
    const fake = makeTuiFake()
    const cleanup = setupFollow(fake.ctx)
    try {
      fire(fake, successEvent("ses_source", { successorID: "ses_next" }))
      await tick()
      assert.deepEqual(fake.getCalls, ["ses_next"])
      assert.deepEqual(fake.navigated, [{ type: "session", sessionID: "ses_next" }])
    } finally {
      cleanup()
    }
  })

  it("ignores unrelated and malformed events without a session lookup", async () => {
    const fake = makeTuiFake()
    const cleanup = setupFollow(fake.ctx)
    try {
      fire(fake, { type: "session.tool.success", data: { sessionID: "ses_source" } })
      fire(fake, successEvent("ses_source", { successorID: "ses_source" }))
      fire(fake, successEvent("ses_source", { successorID: "" }))
      await tick()
      assert.deepEqual(fake.getCalls, [])
      assert.deepEqual(fake.navigated, [])
    } finally {
      cleanup()
    }
  })

  it("ignores rollovers for home and other sessions", async () => {
    const fake = makeTuiFake()
    const cleanup = setupFollow(fake.ctx)
    try {
      fake.route = { type: "home" }
      fire(fake, successEvent("ses_source", { successorID: "ses_next" }))
      fake.route = { type: "session", sessionID: "ses_other" }
      fire(fake, successEvent("ses_source", { successorID: "ses_next" }))
      await tick()
      assert.deepEqual(fake.getCalls, [])
      assert.deepEqual(fake.navigated, [])
    } finally {
      cleanup()
    }
  })

  it("does not yank another session when the route changes during lookup", async () => {
    const fake = makeTuiFake()
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => {
      release = resolve
    })
    fake.getBehavior = () => gate
    const cleanup = setupFollow(fake.ctx)
    try {
      fire(fake, successEvent("ses_source", { successorID: "ses_next" }))
      await tick(1)
      assert.deepEqual(fake.getCalls, ["ses_next"])
      fake.route = { type: "session", sessionID: "ses_elsewhere" }
      release({ id: "ses_next" })
      await tick()
      assert.deepEqual(fake.navigated, [])
    } finally {
      cleanup()
    }
  })

  it("ignores failed, missing, and wrong successor responses", async () => {
    for (const behavior of [
      () => {
        throw new Error("gone")
      },
      () => undefined,
      () => ({ id: "ses_wrong" }),
    ]) {
      const fake = makeTuiFake()
      fake.getBehavior = behavior
      const cleanup = setupFollow(fake.ctx)
      try {
        fire(fake, successEvent("ses_source", { successorID: "ses_next" }))
        await tick()
        assert.deepEqual(fake.navigated, [], String(behavior))
      } finally {
        cleanup()
      }
    }
  })

  it("coalesces duplicate in-flight events for the same rollover", async () => {
    const fake = makeTuiFake()
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => {
      release = resolve
    })
    fake.getBehavior = () => gate
    const cleanup = setupFollow(fake.ctx)
    try {
      const event = successEvent("ses_source", { successorID: "ses_next" })
      fire(fake, event)
      fire(fake, successEvent("ses_source", { successorID: "ses_next" }))
      await tick(1)
      assert.deepEqual(fake.getCalls, ["ses_next"])
      release({ id: "ses_next" })
      await tick()
      assert.deepEqual(fake.navigated, [{ type: "session", sessionID: "ses_next" }])
    } finally {
      cleanup()
    }
  })

  it("cleanup unsubscribes and prevents late navigation", async () => {
    const fake = makeTuiFake()
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => {
      release = resolve
    })
    fake.getBehavior = () => gate
    const cleanup = setupFollow(fake.ctx)
    fire(fake, successEvent("ses_source", { successorID: "ses_next" }))
    await tick(1)
    cleanup()
    assert.equal(fake.unsubscribed, 1)
    release({ id: "ses_next" })
    await tick()
    assert.deepEqual(fake.navigated, [])
  })
})
