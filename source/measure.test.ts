// Pure-logic tests: node --test source/measure.test.ts (no host, no network).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  applyToolGate,
  inheritStreak,
  loopLockRequired,
  measureSession,
  narrow,
  nextLoopState,
  parseThreshold,
  productiveHandover,
  resolveModelWindow,
  resolveSoftTokens,
  resolveThresholdTokens,
  seedTooLarge,
  selectThresholdValue,
  stageOf,
} from "./measure.ts"

describe("parseThreshold", () => {
  it("accepts percent strings", () => {
    assert.deepEqual(parseThreshold("70%"), { kind: "percent", ratio: 0.7 })
  })
  it("accepts positive absolute integers", () => {
    assert.deepEqual(parseThreshold(40000), { kind: "tokens", tokens: 40000 })
  })
  it("rejects ratios, zero, negatives, and garbage", () => {
    for (const bad of [0, -5, 1.5, 0.7, "0%", "0.7", "wide", "", null, undefined, {}, "101%"]) {
      assert.throws(() => parseThreshold(bad), /threshold/, String(bad))
    }
  })
})

describe("resolveModelWindow", () => {
  const models = [
    { providerID: "anthropic", id: "claude", limit: { context: 200000, input: 190000 } },
    { providerID: "openai", id: "gpt", limit: { context: 128000 } },
  ]
  it("prefers the positive input limit", () => {
    assert.equal(resolveModelWindow(models, "anthropic", "claude"), 190000)
  })
  it("falls back to the context limit", () => {
    assert.equal(resolveModelWindow(models, "openai", "gpt"), 128000)
  })
  it("fails open on unknown models", () => {
    assert.equal(resolveModelWindow(models, "nope", "missing"), undefined)
    assert.equal(resolveModelWindow(undefined, "anthropic", "claude"), undefined)
  })
})

describe("selectThresholdValue", () => {
  const input = {
    soft: "70%",
    modelOverrides: { claude: "50%", "anthropic/claude": "60%" },
    agentOverrides: { build: 9000 },
  }
  it("ranks agent above scoped model above bare model above soft", () => {
    assert.equal(selectThresholdValue(input, { agent: "build", providerID: "anthropic", modelID: "claude" }), 9000)
    assert.equal(selectThresholdValue(input, { agent: "other", providerID: "anthropic", modelID: "claude" }), "60%")
    assert.equal(selectThresholdValue(input, { agent: "other", providerID: "other", modelID: "claude" }), "50%")
    assert.equal(selectThresholdValue(input, { agent: "other", providerID: "other", modelID: "x" }), "70%")
  })
})

describe("resolveSoftTokens", () => {
  it("caps integers at 70% of the window", () => {
    assert.equal(resolveSoftTokens({ kind: "tokens", tokens: 150000 }, 200000), 140000)
    assert.equal(resolveSoftTokens({ kind: "tokens", tokens: 190000 }, 200000), 140000)
    assert.equal(resolveSoftTokens({ kind: "tokens", tokens: 70000 }, 100000), 70000)
  })
  it("leaves integers below the cap untouched", () => {
    assert.equal(resolveSoftTokens({ kind: "tokens", tokens: 150000 }, 300000), 150000)
    assert.equal(resolveSoftTokens({ kind: "tokens", tokens: 1000 }, 200000), 1000)
  })
  it("applies integers with an unknown window", () => {
    assert.equal(resolveSoftTokens({ kind: "tokens", tokens: 150000 }, undefined), 150000)
  })
  it("resolves percents against the window without a 70% cap", () => {
    assert.equal(resolveSoftTokens({ kind: "percent", ratio: 0.9 }, 100000), 90000)
    assert.equal(resolveSoftTokens({ kind: "percent", ratio: 0.7 }, 200000), 140000)
  })
  it("fails open for percents with an unknown window", () => {
    assert.equal(resolveSoftTokens({ kind: "percent", ratio: 0.7 }, undefined), undefined)
  })
})

describe("resolveThresholdTokens", () => {
  it("resolves percent against the window", () => {
    assert.equal(resolveThresholdTokens({ kind: "percent", ratio: 0.7 }, 200000), 140000)
  })
  it("passes absolute tokens through uncapped (hard limits)", () => {
    assert.equal(resolveThresholdTokens({ kind: "tokens", tokens: 12345 }, 200000), 12345)
    assert.equal(resolveThresholdTokens({ kind: "tokens", tokens: 190000 }, 200000), 190000)
  })
})

describe("narrow", () => {
  it("counts user text as unmeasured", () => {
    assert.deepEqual(narrow({ type: "user", text: "hello" }), { kind: "user", ownChars: 5, resultChars: 0 })
  })
  it("splits anchor text from settled tool results", () => {
    const mapped = narrow({
      type: "assistant",
      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
      content: [
        { type: "text", text: "abc" },
        { type: "reasoning", text: "de" },
        {
          type: "tool",
          state: { status: "completed", input: { q: 1 }, content: [{ type: "text", text: "fghij" }] },
        },
      ],
    })
    assert.equal(mapped.kind, "assistant")
    // own text is usage-measured; only the settled tool output trails the anchor.
    assert.ok(mapped.ownChars > 0)
    assert.equal(mapped.resultChars, 5)
  })
  it("ignores in-flight tool states for results but counts their input", () => {
    const mapped = narrow({
      type: "assistant",
      content: [{ type: "tool", state: { status: "running", input: { q: "abc" }, metadata: {} } }],
    })
    assert.equal(mapped.resultChars, 0)
    assert.ok(mapped.ownChars > 0)
  })
})

describe("measureSession", () => {
  const anchor = {
    kind: "assistant",
    tokens: { input: 100000, output: 20000, reasoning: 5000, cache: { read: 40000, write: 1000 } },
    ownChars: 800,
    resultChars: 400,
  }
  it("anchors on the latest usable usage and adds trailing chars/4", () => {
    const measured = measureSession([
      { kind: "user", ownChars: 100, resultChars: 0 },
      anchor,
      { kind: "assistant", ownChars: 4000, resultChars: 0 },
    ])
    assert.ok(measured)
    assert.equal(measured.anchorIndex, 1)
    // 100000 + 20000 + 5000 + 40000 + 1000 = 166000; trailing = 400 + 4000 = 4400 -> 1100
    assert.equal(measured.measuredTokens, 166000)
    assert.equal(measured.trailingChars, 4400)
    assert.equal(measured.estimate, 167100)
  })
  it("treats all-zero usage as unknown and scans older", () => {
    const measured = measureSession([
      anchor,
      {
        kind: "assistant",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        ownChars: 10,
        resultChars: 0,
      },
    ])
    assert.ok(measured)
    assert.equal(measured.anchorIndex, 0)
    assert.equal(measured.measuredTokens, 166000)
  })
  it("returns undefined with no usable anchor (fail open)", () => {
    assert.equal(measureSession([{ kind: "user", ownChars: 10, resultChars: 0 }]), undefined)
    assert.equal(
      measureSession([
        {
          kind: "assistant",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          ownChars: 10,
          resultChars: 0,
        },
      ]),
      undefined,
    )
    assert.equal(measureSession([]), undefined)
  })
  it("never aggregates totals across assistants", () => {
    const older = {
      kind: "assistant",
      tokens: { input: 900000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      ownChars: 0,
      resultChars: 0,
    }
    const measured = measureSession([older, anchor])
    assert.ok(measured)
    assert.equal(measured.measuredTokens, 166000)
  })
})

describe("stageOf", () => {
  it("warns at soft, +10%, +20% and gates at hard", () => {
    assert.equal(stageOf(139999, 140000), "ok")
    assert.equal(stageOf(140000, 140000), "warn1")
    assert.equal(stageOf(154000, 140000), "warn2")
    assert.equal(stageOf(168000, 140000), "warn3")
    assert.equal(stageOf(999999, 140000, 500000), "hard")
    assert.equal(stageOf(100, 140000, 500000), "ok")
  })
})

describe("applyToolGate", () => {
  it("keeps only the handover tool on hard, strips all on lock", () => {
    const tools: Record<string, unknown> = { bash: 1, read: 2, context_handover: 3 }
    assert.deepEqual(applyToolGate(tools, ["context_handover"]).sort(), ["bash", "read"])
    assert.deepEqual(Object.keys(tools), ["context_handover"])
    const locked: Record<string, unknown> = { context_handover: 1, other: 2 }
    assert.deepEqual(applyToolGate(locked, null).sort(), ["context_handover", "other"])
    assert.deepEqual(Object.keys(locked), [])
  })
})

describe("loop guard", () => {
  it("does not count the root first handover", () => {
    const state = nextLoopState(undefined, { addedTokens: 0, softTokens: 100000, isRoot: true, seedEstimate: 1000, highWater: 0 })
    assert.deepEqual(state, { chain: 0, unproductive: 0, seedEstimate: 1000, highWater: 0 })
    assert.equal(loopLockRequired(state), false)
  })
  it("locks after 3 consecutive unproductive successions", () => {
    let state = nextLoopState(undefined, { addedTokens: 0, softTokens: 100000, isRoot: true, seedEstimate: 1000, highWater: 0 })
    for (let i = 0; i < 2; i++) {
      state = nextLoopState(state, { addedTokens: 1000, softTokens: 100000, isRoot: false, seedEstimate: 1000, highWater: 2000 })
      assert.equal(loopLockRequired(state), false)
    }
    state = nextLoopState(state, { addedTokens: 1000, softTokens: 100000, isRoot: false, seedEstimate: 1000, highWater: 2000 })
    assert.equal(loopLockRequired(state), true)
    assert.equal(state.chain, 3)
  })
  it("resets on productive successions (25% of soft beyond seed)", () => {
    assert.equal(productiveHandover(25000, 100000), true)
    assert.equal(productiveHandover(24999, 100000), false)
    let state = nextLoopState(undefined, { addedTokens: 0, softTokens: 100000, isRoot: true, seedEstimate: 1000, highWater: 0 })
    state = nextLoopState(state, { addedTokens: 10, softTokens: 100000, isRoot: false, seedEstimate: 1000, highWater: 1200 })
    state = nextLoopState(state, { addedTokens: 50000, softTokens: 100000, isRoot: false, seedEstimate: 1000, highWater: 60000 })
    assert.equal(state.unproductive, 0)
  })
  it("inherits the updated streak into the successor", () => {
    const updated = nextLoopState(undefined, { addedTokens: 10, softTokens: 100000, isRoot: false, seedEstimate: 1000, highWater: 2000 })
    assert.deepEqual(inheritStreak(updated, 500), { chain: 1, unproductive: 1, seedEstimate: 500, highWater: 0 })
  })
  it("warns when the seed alone exceeds 50% of soft without blocking", () => {
    assert.equal(seedTooLarge(60000, 100000), true)
    assert.equal(seedTooLarge(50000, 100000), false)
  })
})
