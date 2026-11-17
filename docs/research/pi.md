# Pi adapter assessment and evidence

Status (2026-11-17): **automatic root rollover by default on Pi 1.x**, with
manual `/handover` fallback. An isolated Pi 1.5.2 offline-provider probe observed
the real handover tool, settled-event command dispatch, seeded successor and
admitted continuation with zero load diagnostics. Real-model compliance and
interactive end-to-end behavior remain unverified. The original 0.73.1 dispatch
failure below is historical, not a current restriction. No third-party subagent
integration is claimed.

## Pi 1.5.2 reassessment

- Current package: `@earendil-works/pi-coding-agent@1.5.2`, repository
  `earendil-works/pi`, `packages/coding-agent`; host Node requirement >=22.19.0.
  The old `@mariozechner/pi-coding-agent@0.73.1` package is deprecated in favor
  of the canonical scope. Development types target `^1`; Pi and `typebox`
  remain host-provided `*` peers. Pi imports are type-only, so the plugin's
  root Node floor is unchanged; running Pi still requires the host's floor.
- Shipped `docs/extensions.md` documents command-only replacement at
  lines 1320-1500 and the tool/settled-command pattern at lines 1538-1572.
  `examples/extensions/reload-runtime.ts` uses the same pattern. Legacy
  package names map to the canonical modules in the host loader.
- `sendUserMessage('/handover', {expandPromptTemplates:true})` from
  `agent_settled` is actual command dispatch. Without explicit expansion,
  including the old `deliverAs`-only example, slash text is plain model input.
  `dist/core/agent-session.js` defers settled-handler messages until all such
  handlers finish, then dispatches the command. No old command context is
  retained for events.
- Successful storage sets one in-memory request scoped to run, session/file
  and the stored entry's active-branch membership, and returns `terminate:true`.
  Settlement consumes it once. Aborts, lifecycle changes and uncertain branch
  attribution do not roll over. Stored/historical entries alone never trigger
  a request; reload does not replay them. No automatic retries.
- The existing `/handover` command remains the only replacement implementation:
  wait for idle, read the fresh branch snapshot, seed full text once plus
  backlink, then send kickoff only through fresh `withSession` context.
  Source text is retained. Cancellation reports unchanged source and fallback.
  Synchronous dispatch errors and command/continuation failures identify source
  recovery. `pi.sendUserMessage` returns `void`; asynchronous dispatch failures
  go to Pi's extension-error surface, not the surrounding try/catch. The tool
  result already identifies `/handover` fallback. A preflight notice explains
  recovery before replacement; stale-context notification failures throw to
  the host error surface rather than disappearing silently.
- `dist/core/agent-session-runtime.js` tears down the old runtime before setup
  and `withSession`. Old `pi`/`ctx` access is stale. The interactive host's
  `dist/modes/interactive/interactive-mode.js` binds command actions to runtime
  replacement and rebinds its current session/view after switching. Thus TUI
  following is source-established, not an observed interactive run. Its
  `newSession` wrapper catches replacement errors, displays a fatal error and
  exits before the plugin's catch can run. Preflight recovery guidance is
  therefore essential. Relaunch if needed and inspect sessions before recovery.
- No Pi chain guard is implemented. `source/measure.ts` already supplies
  first-root exclusion, >=25%-of-soft productivity and three-unproductive
  thresholds. Exact behavior also needs persisted predecessor/pre-call/high-water
  state and a choice of stop behavior without Pi source locks. That port remains
  a proposal, not invented parameters or an implicit new lifecycle decision.

### Current isolated non-model evidence

A temporary SDK harness used isolated `HOME` and `PI_CODING_AGENT_DIR`, an
in-memory settings manager, private session files, fresh services per runtime,
and `ModelRuntime` with `modelsPath:null`, `allowModelNetwork:false` and
`refreshOnCreate:false`. Its faux provider streamed a deterministic call to the
real `context_handover` tool, then a successor response. No network request or
real-model invocation occurred. Command actions were bound to
`AgentSessionRuntime`, matching the interactive host's ownership contract.
The resource loader loaded the repository's real `pi/index.ts`, not a copy or
replacement implementation.

With `ISO` the isolated directory and `PROBE` that temporary harness:

```sh
: "${ISO:?}" "${PROBE:?}"
env HOME="$ISO/home" PI_CODING_AGENT_DIR="$ISO/agent" \
  PROBE_REPORT=probe-tool-report.json node "$PROBE"
```

Exit 0: stored text/summary verbatim, actual `/handover` command reached,
one different successor, seed once with source id/file backlink and host
`parentSession`, kickoff admitted and offline successor response received.
Two faux streams total; loader diagnostics `[]`, extension/runtime errors `[]`.
A separate manifest-discovery `DefaultResourceLoader` check loaded the package
with errors `[]` and warnings `[]`. Separate synthetic and pre-integration
command probes corroborated the 1.5.2 dispatch contract. Fake-API tests cover
one-shot requests, no historical replay, attribution/lifecycle skips, storage
and synchronous dispatch failures, cancellation and stale-context error
propagation. The SDK probe binds replacement directly to `AgentSessionRuntime`;
it does not exercise the interactive host's fatal replacement-error wrapper. `npm run typecheck` and
`npm test` passed (781 tests, including 36 Pi fixtures).

This is host integration evidence, not proof that a real model will obey
notices, write a good handover, or continue correctly. Exact model/settings
preservation and interactive TUI navigation still need user-run checks.

## Historical 0.73.1 primary sources

`npm view @mariozechner/pi-coding-agent@0.73.1 version repository gitHead --json`
returned version `0.73.1`, repository `badlogic/pi-mono`, directory
`packages/coding-agent`, gitHead
`781152fc24841dc54b22284514604048ebe5e2c9`. The then-installed CLI reported `0.73.1`.
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
| Continuation | Only command context exposes `newSession`; setup seeds messages; fresh `withSession` can `sendUserMessage` [E,T,R]. | Pi 1.5.2 offline-provider probe observed actual seeded replacement and continuation admission; real-model/interactive continuation unverified. |
| Event-driven rollover | No `newSession` in tool/event context; command-only restriction prevents deadlocks [E,T]. Current host documents settled-event dispatch into a command. | Pi 1.5.2 real tool -> settled -> `/handover` -> successor path observed. Original 0.73.1 limitation below is historical. |
| Optional gate | `tool_call` can block; `setActiveTools` changes active declarations [E,T]. | Omitted: advisory-first MVP needs no tool-set restoration or execution gate. |
| Compaction | Cancel/custom summary hook and disable setting exist [C,E]. | Adapter registers no compaction hooks and changes no settings. Native summarization can still occur. |
| Native subagents | No core subagent primitive established; shipped example spawns separate Pi processes. | No child identity, native handback or third-party extension integration claimed. |

### Historical 0.73.1 dispatch limitation

The pinned extensions guide's tool-to-reload example calls
`pi.sendUserMessage('/reload-runtime', {deliverAs:'followUp'})` [E]. Source
does not implement that as command dispatch: `sendUserMessage` sets
`expandPromptTemplates:false`; `prompt` dispatches extension commands only
when that option is true [A]. Queued text never re-enters command dispatch.
An isolated probe observed direct `/inner` executing its command, but
`/outer` calling `sendUserMessage('/inner', ...)` never executed `/inner` and
instead reached missing-API-key validation. No model response occurred.

That release required the user to submit `/handover`; the original adapter
therefore shipped manual initiation. Pi 1.5.2 re-establishes actual dispatch
with explicit `expandPromptTemplates:true` as described above. Do not retain
an old command context for events or queue a literal slash command as model
input.

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
  open/partially seeded replacement. Recovery guidance is emitted before
  replacement, and failed stale-context notifications propagate to the host
  error surface. Check the current session and session list, then reopen the
  source and read its stored handover to recover. No retry/idempotency,
  forward-link, lock or loop guard is promised.
- A seed above 50% of soft warns only. No fixed generation cap. The current
  tool returns `terminate:true` to settle the agent loop; it does not add an
  ordinary tool gate or source lock.

## Historical 0.73.1 isolated non-model validation

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
