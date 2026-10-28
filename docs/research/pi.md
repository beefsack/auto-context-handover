# Pi adapter assessment and evidence

Status (2026-10-28): **root-session MVP shipped; command-driven rollover**.
Measurement, advisory wording, storage and continuation callbacks are
fixture-covered. Package installation and extension registration are observed
without a model call. Model compliance and end-to-end rollover are unverified.
This refresh supersedes the earlier Pi package/version claims in
[prior art](prior-art.md); it does not reinterpret third-party subagents as core.

## Primary sources

`npm view @mariozechner/pi-coding-agent@0.73.1 version repository gitHead --json`
returned version `0.73.1`, repository `badlogic/pi-mono`, directory
`packages/coding-agent`, gitHead
`781152fc24841dc54b22284514604048ebe5e2c9`. The installed CLI reports `0.73.1`.
The shipped docs, `dist/` implementations and declarations were inspected;
source citations below are pinned to that npm gitHead, not moving `main`.

- [E] [Extensions](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/extensions.md):
  `before_agent_start`, `context`, `before_provider_request`, `getContextUsage`,
  `appendEntry`, command contexts, session replacement and tool blocking.
- [C] [Compaction](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/compaction.md):
  native threshold `contextWindow - reserveTokens`, default reserve 16384;
  `compaction.enabled:false` and `session_before_compact` are available but unused.
- [T] [Extension types](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/extensions/types.ts):
  `ExtensionContext`, `ExtensionCommandContext`, `ReplacedSessionContext`,
  `ContextUsage`, `registerTool`, `registerCommand`, `appendEntry`.
  Shipped declarations: `dist/core/extensions/types.d.ts:192-290,710-739,816-861`.
- [A] [AgentSession](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/agent-session.ts):
  `prompt`, `sendUserMessage`, `getContextUsage`, extension bindings.
  Shipped JS: `dist/core/agent-session.js:696-737,995-1025,2377-2416`.
- [R] [Runtime replacement](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/agent-session-runtime.ts):
  `newSession`, teardown, setup, rebind and `withSession` ordering.
- [S] [SessionManager](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/session-manager.ts):
  branch-local custom entries, JSONL persistence and `parentSession`.
  Shipped JS: `dist/core/session-manager.js:549-572,633-643,755-766`.
- [M] [Estimator](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/compaction/compaction.ts):
  `estimateContextTokens`, latest usable usage plus trailing chars/4;
  absent an anchor, heuristic message estimation, not billing-weighted totals.
- [P] [Packages](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/packages.md):
  local package install and `package.json` `pi.extensions` discovery.

## Capability assessment

| Capability | Documented/source-established | Observed or unverified |
| --- | --- | --- |
| Current context and window | `getContextUsage()` returns estimated `tokens`, `contextWindow`, `percent`; absent model/window returns undefined; post-compaction tokens are null until usable new assistant usage [E,T,A,M]. | Real types compile. Fake fixtures cover unknowns. Accuracy on actual requests unverified. |
| Per-request timing | `context` transforms message lists; `before_provider_request` can rewrite provider payloads [E,T]. | Adapter uses `context`, appending one transient notice, not rewriting payloads/system prefix. Fixture-covered. |
| Trusted introduction | `before_agent_start` injects a persistent custom message before the loop [E]. It is not a one-time session-start hook or system-priority guarantee. | Fixture-covered authorship; host persists one intro per user prompt. Model acceptance unverified. |
| Staged soft limit | Host estimator plus shared stages can drive notices. | Fixed soft, soft x 1.1, soft x 1.2; fixture-covered. No hard gate shipped. |
| Handover storage | Directly registered tool; `appendEntry` persists custom state outside LLM context [E,T,S]. | Tools observed in real host; model-authored text retention fixture-covered. No standalone external storage or arbitrary-file reader. |
| Continuation | Only command context exposes `newSession`; setup seeds messages; fresh `withSession` can `sendUserMessage` [E,T,R]. | `/handover` registered in real host; callbacks fixture-covered. Actual replacement and continuation unverified. |
| Event-driven rollover | No `newSession` in tool/event `ExtensionContext`; command-only restriction prevents deadlocks [E,T]. | Unsupported in this MVP, not an impossibility claim for future APIs. See dispatch discrepancy below. |
| Optional gate | `tool_call` can block; `setActiveTools` changes active declarations [E,T]. | Omitted: advisory-first MVP needs no tool-set restoration or execution gate. |
| Compaction | Cancel/custom summary hook and disable setting exist [C,E]. | Adapter registers no compaction hooks and changes no settings. Native summarization can still occur. |
| Native subagents | No core subagent primitive established; shipped example spawns separate Pi processes. | No child identity, native handback or third-party extension integration claimed. |

### Why rollover needs an actual command

The pinned extensions guide's tool-to-reload example calls
`pi.sendUserMessage('/reload-runtime', {deliverAs:'followUp'})` [E]. Source
does not implement that as command dispatch: `sendUserMessage` sets
`expandPromptTemplates:false`; `prompt` dispatches extension commands only
when that option is true [A]. Queued text never re-enters command dispatch.
An isolated probe observed direct `/inner` executing its command, but
`/outer` calling `sendUserMessage('/inner', ...)` never executed `/inner` and
instead reached missing-API-key validation. No model response occurred.

Do not use the guide example to claim automatic rollover, retain an old
command context for use in events, or queue a slash command as literal model
input. `/handover` must actually be submitted by the user. After that command,
seeding and the continuation prompt are automatic, with no extra confirmation.

## Storage and lifecycle limits

- `context_handover` stores both input strings verbatim. Latest current-branch
  custom entry wins; malformed newest payloads are reported, never replaced
  silently with older text. Reload reads the host branch, not transient caches.
- `read_handover({})` reads only the active branch, with host-recorded source
  session/effective model and diagnostics. No cross-session id/path arguments,
  parent-only authorization claim, original-task capture or child lineage.
- Pi owns JSONL lifetime; no adapter eviction/quota policy. Session deletion
  removes its backing file; ephemeral sessions retain state in memory only.
  Host writes are synchronous, not transactional: entry indexing precedes disk
  append; a failed write can leave an in-memory entry. Initial files flush only
  once an assistant message exists [S]. This is not crash-safe storage.
- Intro messages persist per prompt; stage notices do not. Usage includes host
  messages, not an exact estimate of later extensions' provider payload changes.
  `getSystemPrompt()` likewise cannot see later provider rewrites [E].
- Diagnostics describe the latest hook snapshot, not proof the model received
  a notice. Missing/reloaded snapshots are `unknown`; no billing weighting or
  accumulated-session token sum is introduced.
- `/handover` waits for idle before reading the branch, seeds full text once,
  records a source backlink, then uses only the fresh replacement context.
  It does not force a model selection; Pi owns replacement model resolution.
  Exact active-model/override preservation is not guaranteed by the adapter.
- Cancellation leaves the source intact. Errors after teardown may leave an
  open/partially seeded replacement; old-context error notifications can fail.
  Check the current session, reopen the source and read its stored handover to
  recover. No retry/idempotency, forward-link, lock or loop guard is promised.
- A seed above 50% of soft warns only. No fixed generation cap. A returned
  handover is advisory: the host is not forced to stop the model or sibling tools.

## Isolated non-model validation

`ISO`, `REPO`, `PI` and `CLAUDE` below are required absolute inputs: an isolated
directory, repository directory and installed binaries. All harness state is
redirected under `ISO`. The commands below used Pi `0.73.1`; no model selection,
credentials or model requests were needed for the registration check.

```sh
: "${ISO:?}" "${REPO:?}" "${PI:?}" "${CLAUDE:?}"
cd "$ISO"
env -i PATH="$PATH" HOME="$ISO/home" npm_config_cache="$ISO/npm-cache" \
  npm view @mariozechner/pi-coding-agent@0.73.1 version repository gitHead --json
env -i PATH="$PATH" HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" \
  PI_CODING_AGENT_DIR="$ISO/agent" PI_OFFLINE=1 PI_TELEMETRY=0 "$PI" --version
env -i PATH="$PATH" HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" \
  PI_CODING_AGENT_DIR="$ISO/agent" PI_OFFLINE=1 PI_TELEMETRY=0 "$PI" install "$REPO"
env -i PATH="$PATH" HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" \
  PI_CODING_AGENT_DIR="$ISO/agent" PI_OFFLINE=1 PI_TELEMETRY=0 "$PI" list
env -i PATH="$PATH" HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" \
  PI_CODING_AGENT_DIR="$ISO/agent" PI_OFFLINE=1 PI_TELEMETRY=0 "$PI" --help
env -i PATH="$PATH" HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" \
  PI_CODING_AGENT_DIR="$ISO/agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
  "$PI" -e ./verify.ts --handover-soft 4096 -p /verify-handover
env -i PATH="$PATH" HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" \
  CLAUDE_CONFIG_DIR="$ISO/claude" "$CLAUDE" plugin validate "$REPO"
```

The temporary `verify.ts` registers a command, not a model task:

```ts
export default function (pi) {
  pi.registerCommand('verify-handover', { handler: async () => {
    const tools = pi.getAllTools().map(t => t.name);
    const commands = pi.getCommands().map(c => c.name);
    for (const name of ['context_handover', 'read_handover']) {
      if (!tools.includes(name)) throw new Error(`Missing ${name}`);
    }
    if (!commands.includes('handover')) throw new Error('Missing /handover');
    console.log(JSON.stringify({tools: tools.filter(n => n.includes('handover')), command: 'handover'}));
  }});
}
```

All commands exited 0. Results: version `0.73.1`; install succeeded; `list`
showed the local package; help exposed `--handover-soft <value>`; command output
was `{"tools":["context_handover","read_handover"],"command":"handover"}`
with no extension-load errors. Explicit `--no-extensions -e "$REPO/pi/index.ts"`
plus the same observer also registered both tools and the command.
Claude validation passed with existing attribution/icon warnings, not errors.
`npm run typecheck` passed all three projects; `npm test` passed 370 tests,
including 28 Pi fixtures. Neither registration nor fixtures establish model
compliance, live handover authorship or end-to-end continuation.

## Subagent extensions worth separate assessment

The shipped [subagent example](https://github.com/badlogic/pi-mono/tree/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/examples/extensions/subagent)
is the primary subprocess reference. Two independently packaged candidates:

| Extension | Package metadata observed 2026-10-28 | Popularity signal |
| --- | --- | --- |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | [`pi-subagents@0.83.1`](https://www.npmjs.com/package/pi-subagents), async delegation/artifacts/session sharing | [GitHub API](https://api.github.com/repos/nicobailon/pi-subagents): 4087 stars, 832 forks |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | [`@tintinweb/pi-subagents@0.22.0`](https://www.npmjs.com/package/@tintinweb/pi-subagents), parallel workflows/steering | [GitHub API](https://api.github.com/repos/tintinweb/pi-subagents): 1374 stars, 336 forks |

These signals justify investigating compatibility, not a suitability ranking
or native Pi capability claim. Neither extension was installed or integrated;
their child storage, caller identity and delivery contracts remain unverified.
