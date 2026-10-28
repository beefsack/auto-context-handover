import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { HANDOVER_SECTIONS, OPENCODE_WARN1, OPENCODE_WARN2, OPENCODE_WARN3, SEED_FRAMING } from "./shared/handover-text.ts"

const python = readFileSync(new URL("../openhands/handover_adapter.py", import.meta.url), "utf8")

test("OpenHands Python handover template matches shared text", () => {
  assert.equal(python.match(/HANDOVER_SECTIONS = """([\s\S]*?)"""/)?.[1], HANDOVER_SECTIONS)
})

test("OpenHands Python continuation framing and stage leads match shared text", () => {
  for (const [name, expected] of Object.entries({ SEED_FRAMING, OPENCODE_WARN1, OPENCODE_WARN2, OPENCODE_WARN3 })) {
    const block = python.match(new RegExp(`^${name} = \\(\\n([\\s\\S]*?)^\\)`, "m"))?.[1]
    assert.ok(block, `missing Python constant ${name}`)
    const actual = [...block.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(match => JSON.parse(match[0]) as string).join("")
    assert.equal(actual, expected, name)
  }
})
