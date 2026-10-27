// Config validation tests: node --test source/config.test.ts.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseConfig } from "./config.ts"

describe("parseConfig", () => {
  it("applies nested defaults", () => {
    const config = parseConfig({})
    assert.equal(config.soft, "70%")
    assert.equal(config.hard, undefined)
    assert.equal(config.primary, "new-session")
    assert.equal(config.subagent, "return")
    assert.deepEqual(config.stages, [0, 0.1, 0.2])
  })
  it("accepts absolute thresholds and nested actions", () => {
    const config = parseConfig({
      soft: 50000,
      hard: "95%",
      onHandover: { primary: "lock", subagent: "return" },
      stages: [0, 0.05, 0.15],
    })
    assert.equal(config.soft, 50000)
    assert.equal(config.primary, "lock")
    assert.deepEqual(config.stages, [0, 0.05, 0.15])
  })
  it("rejects flat onHandover and unsupported actions with setup errors", () => {
    assert.throws(() => parseConfig({ onHandover: "new-session" }), /nested/)
    assert.throws(() => parseConfig({ onHandover: "lock" }), /nested/)
    assert.throws(() => parseConfig({ onHandover: { primary: "reset" } }), /unsupported onHandover\.primary/)
    assert.throws(() => parseConfig({ onHandover: { primary: "archive" } }), /unsupported onHandover\.primary.*new-session.*lock/)
    assert.throws(() => parseConfig({ onHandover: { subagent: "reset" } }), /unsupported onHandover\.subagent/)
    assert.throws(() => parseConfig({ onHandover: { subagent: "quarantine" } }), /unsupported onHandover\.subagent/)
  })
  it("accepts lock and new-session primaries while keeping reset rejected", () => {
    assert.equal(parseConfig({ onHandover: { primary: "lock" } }).primary, "lock")
    assert.equal(parseConfig({ onHandover: { primary: "new-session" } }).primary, "new-session")
  })
  it("requires stages to start at 0 and ascend", () => {
    assert.throws(() => parseConfig({ stages: [0.1, 0.2, 0.3] }), /"stages"/)
    assert.throws(() => parseConfig({ stages: [0, 0.2, 0.1] }), /"stages"/)
    assert.throws(() => parseConfig({ stages: [0, 0.1] }), /"stages"/)
  })
  it("validates each override map independently", () => {
    assert.throws(() => parseConfig({ modelOverrides: { "a/b": "lots" } }), /"modelOverrides".*"a\/b"/)
    assert.throws(() => parseConfig({ agentOverrides: { build: 0.7 } }), /"agentOverrides".*build/)
    assert.throws(() => parseConfig({ modelOverrides: ["x"] }), /"modelOverrides" must be an object/)
  })
  it("rejects bad thresholds", () => {
    assert.throws(() => parseConfig({ soft: 0.7 }), /invalid "soft"/)
    assert.throws(() => parseConfig({ hard: -1 }), /invalid "hard"/)
  })
})
