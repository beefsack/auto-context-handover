# Qwen Code adapter assessment

Status (2026-10-29): **subagent-first MVP; pinned source contract**.
Target `@qwen-code/qwen-code@0.26.3`, tag `v0.26.3` / commit
`eeee1443a7e36ab22b2f1dcded8dec64b621a7ee`. Roots receive continuation
context and read access only. Installation/MCP connection were observed without
a model; fixtures never establish model compliance or parent receipt.

## Primary sources

- [H] [Official hooks guide](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/),
  [pinned event/payload types](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/hooks/types.ts),
  [hook identity and dispatch](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/hooks/hookEventHandler.ts#L1205-L1234).
- [T] [Child transcript path](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/agents/agent-transcript.ts#L64-L104),
  [synchronous writer](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/agents/agent-transcript.ts#L695-L805),
  [usage emission before tool execution](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/agents/runtime/agent-core.ts#L1327-L1365).
- [E] [Official extension guide](https://github.com/QwenLM/qwen-code/blob/v0.26.3/docs/users/extension/getting-started-extensions.md),
  [native bundled classic-hook loading](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/extension/extensionManager.ts#L2025-L2109),
  [extension hook registration](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/hooks/hookRegistry.ts#L316-L330).
- [C] [Compaction hooks](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/services/chatCompressionService.ts),
  [hook execution owner](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/hooks/hook-execution-context.ts),
  [Stop usage validation](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/hooks/context-usage.ts).
- [M] [MCP execution](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/tools/mcp-tool.ts),
  [whole-input hook replacement](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/hooks/hook-sequential-input.ts),
  [native child execution/delivery](https://github.com/QwenLM/qwen-code/blob/v0.26.3/packages/core/src/tools/agent/agent.ts).
- [Q] [Qwen Mods compatibility](https://github.com/QwenLM/qwen-code/blob/v0.26.3/docs/users/extension/mods.md).
  This adapter does not use that separate main-session-only turn-event surface.

## Capability table

Documented/source-established contracts below were also inspected in the installed
package's bundled JavaScript. Observed means non-model CLI/protocol behavior only.

| Capability | Documented / pinned-source established | Observed / unverified |
| --- | --- | --- |
| Per-request hooks / usage | No Gemini `BeforeModel`, `BeforeToolSelection` or `BeforeAgent` in the 22-event enum [H]. `Stop` alone carries optional `input_tokens/context_limit/context_usage`; no usage in tool/compact hooks. | Do not inherit Gemini's capability rows. Adapter ignores Stop's shared last-writer telemetry and uses child records instead. |
| Child measurement | Child `ROUND_TEXT` persists `usageMetadata`, `sessionId`, `agentId`, `agentRunId`, `agentRound` synchronously before `processFunctionCalls` [T]. Latest `promptTokenCount + candidatesTokenCount`, not cumulative totals/cache subsets. | Parser/identity/invalid-latest fixtures. No trailing tool-result estimate or child-window discovery; provider accuracy/actual host cadence unverified. |
| Transcript identity | Base `transcript_path` is the root; `agent_id` comes from host execution ownership [H]. Child path is project/subagents/session/agent-id.jsonl [T]. | Derive only for strict safe ids and expected root layout; verify record identity. Reader ids are opaque `session:agent` composites, not authored caller ids. |
| Injection / denial | SessionStart/SubagentStart and PostToolUse `additionalContext`; PreToolUse deny and whole-input replacement [H,M]. | Fixture-covered introductions/notices/binding. No system-priority or actual model-compliance claim. |
| Packaging / MCP | Native `qwen-extension.json`, `${extensionPath}` MCP, bundled `hooks/hooks.json` and `${CLAUDE_PLUGIN_ROOT}` command substitution [E]. Loader also accepts Gemini manifest conversion; native manifest takes precedence. | Native directory link/list and host MCP connection observed. Separate Qwen directory avoids the existing Claude root hook manifest. No build; intact checkout required. |
| Subagents / receipt | Host child identity, native final-text result and bounded SubagentStop continuation loop [H,M]. | Short receipt + one stop correction fixture-covered; no deterministic final rewrite, classifier handback or observed parent receipt. |
| Compaction | PreCompact adds instructions to compression; PostCompact is observational [C]. Neither offers a model-written handover substitute. | Adapter checkpoints child transcript length at both events, then requires later records. Native compaction unchanged and may precede nudging. |
| Storage / continuation | MCP tools permit adapter-owned private files; parents can spawn native replacement children [E,M]. | Reuses Codex immutable store/capability implementation in a separate HOME-based directory. Parent continuation is advisory, not automatic plugin spawning. |

## Implementation boundaries and review

- Positive integer soft only, default `150000`, uncapped because child window
  attribution is unestablished. Shared soft/1.1/1.2 stages at PostToolUse only;
  no hard token gate. Invalid configuration disables notices, keeps binding,
  stores internal soft `0`, and reads unknown threshold/stage/estimate.
- Both tools require a single-use PreToolUse capability holding the original
  arguments and host caller. Raw calls/replay/cross-tool substitution fail.
  Roots cannot write; any live bound caller may read any retained composite id.
  Closed callers are denied by MCP and supported tool hooks. Not a same-user
  filesystem sandbox; disabled/failed hooks are not universal stop enforcement.
- HOME `.qwen/auto-context-handover` holds hashed-id immutable handover+summary+
  closure, mutable observations/checkpoints and pending capabilities. Reuse
  `codex/store.ts` without changing Codex behavior. New directories/files are
  0700/0600; no quota, TTL, eviction, deletion cleanup or fsync guarantee.
  Abandoned pending/temp files can remain; retention is manual.
- Native child transcripts are append-only event traces, not reconstructed
  active-history prompts. Use only their latest response usage. Malformed/torn
  reads, foreign usage and corrupt checkpoints suppress measurement. A failed
  checkpoint write logs and can retain an older floor; ordinary hooks fail open.
  File replacement/truncation can suppress notices until growth passes the floor.
  No tail estimate, media correction or additional reasoning count is claimed.
- Compact parent default; `full:true` returns verbatim text once with shared
  reference/no-repeat/predecessor-evidence framing. Shared >50%-of-soft seed
  warning is advisory. Type/effective model/override remain unknown; parent
  preserves original spawn parameters. No captured original, lineage, successor
  classification, automatic root rollover or UI following.
- Independent review found unbound-reader bypass, duplicate/mislabelled batch
  notices, invented invalid-config soft and stale fallback on corrupt/torn reads.
  Resolved by requiring binding for both tools, PostToolUse-only notices, unknown
  invalid-config diagnostics and conservative parser/checkpoint reads. Logged
  checkpoint-write loss remains the explicit fail-open limitation above.

## Non-model verification

With required `ISO` (isolated state) and `REPO` (intact checkout) absolute paths,
run outside the checkout; no credentials or model selection are needed:

```sh
: "${ISO:?}" "${REPO:?}"
mkdir -p "$ISO/home" "$ISO/config" "$ISO/cache" "$ISO/data"
cd "$ISO"
export HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config"
export XDG_CACHE_HOME="$ISO/cache" XDG_DATA_HOME="$ISO/data"
export npm_config_cache="$ISO/npm-cache"
npm install --prefix "$ISO/host" @qwen-code/qwen-code@0.26.3
node "$ISO/host/node_modules/@qwen-code/qwen-code/cli.js" --version
node "$ISO/host/node_modules/@qwen-code/qwen-code/cli.js" extensions link "$REPO/qwen"
node "$ISO/host/node_modules/@qwen-code/qwen-code/cli.js" extensions list
node "$ISO/host/node_modules/@qwen-code/qwen-code/cli.js" mcp list
```

Observed: version `0.26.3`, extension linked/enabled as `0.1.0`, stdio server
Connected. Separate real SDK stdio probe lists `context_handover/read_handover`
and refuses both unbound calls (`isError:true`). Foreign-cwd/spaced-path manual
hook probes returned valid JSON and a 64-hex bound token. These manual probes
are not proof of host hook discovery/firing. Final typecheck passes; full suite
753 passed (45 Qwen), zero failures/skips. Existing Claude plugin validation
passes with pre-existing author/icon warnings. No model compliance, actual
child hook routing or end-to-end continuation is established.
