# Codex CLI adapter assessment and evidence

Status (2026-10-28): **subagent-first MVP shipped; pinned-source contract**.
Roots receive continuation context and can read handovers, but are not measured
or rolled over. Model compliance, actual hook firing and parent continuation
are unverified. Installation/discovery and MCP registration were checked without
a model. Fixtures are not live compliance.

## Primary sources and release

`npm view @openai/codex version` returned `0.165.0`; the CLI reports
`codex-cli 0.165.0`. Source tag `rust-v0.165.0` resolves to
`e374836b2728d9b7aa981c2902649e640a2edaa8`. This refresh supersedes the
`rust-v0.164.0` Codex assessment in [prior art](prior-art.md), not the other
harness rows. Source links below are pinned; public docs were read on 2026-10-28.

- [H] [Hooks](https://developers.openai.com/codex/hooks): discovery, trust,
  additional context, tool coverage, rewriting and stop semantics.
- [P] [Plugin packaging](https://developers.openai.com/plugins/build/plugins):
  portable root manifests, local marketplaces, compatibility overlays and hooks.
- [A] [App server](https://developers.openai.com/codex/app-server): thread/turn
  APIs, not a hook-local rollover API.
- [U] [Usage protocol](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/protocol/src/protocol.rs#L2391-L2490)
  and [recording](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/state/session.rs#L228-L264).
- [M] [Model-request events](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/events/model_request.rs#L1-L168)
  and [dispatch ordering](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/session/turn.rs#L2704-L2738).
- [I] [Host subagent identity](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/hook_runtime.rs#L1065-L1127),
  [tool-hook stdin](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/events/pre_tool_use.rs#L169-L190)
  and [stop paths](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/hook_runtime.rs#L374-L428).
- [R] [MCP input rewriting](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/tools/handlers/mcp.rs#L503-L535),
  [dispatch gate](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/tools/registry.rs#L801-L840)
  and [MCP calls without caller identity](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/codex-mcp/src/connection_manager.rs#L1183-L1243).
- [E] [Plugin stdio environment/path expansion](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/codex-mcp/src/agent_plugin_config.rs#L150-L230)
  and [hook environment](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/engine/discovery.rs#L298-L319).
- [T] [Execution-time plugin trust](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/engine/plugin_trust.rs#L1-L69).
- [D] [Native wait behavior](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L39-L174)
  and [mailbox delivery](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/session/input_queue.rs#L327-L460).
  [Completion status](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/agent/status.rs#L6-L12)
  retains the last assistant message;
  [completion formatting](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/session_prefix.rs#L20-L42)
  uses that text and [parent routing](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/agent/control/completion.rs#L92-L141)
  queues it best-effort (not independent parent-receipt evidence).
- [F] [Upstream observer fixtures](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/tests/suite/hooks.rs#L6085-L6147)
  assert exact `status`, `token_usage` and `session_id` payload keys. These are
  upstream tests inspected as source, not tests executed for this adapter.

## Capability assessment

`Documented` means public documentation; `Source-established` means pinned code;
`Observed` means a non-model CLI/protocol check; `Unverified` is not a negative
capability claim. The 12-requirement matrix is in [adapters](../adapters.md#codex-subagent-first-mvp).

| Capability | Documented / source-established | Observed / unverified |
| --- | --- | --- |
| Current context measurement | `TokenUsageRecord.usage` is the latest completed response; `turn_token_usage` and `thread_token_usage` are cumulative. `TokenUsageInfo.last_token_usage` is per response; `.total_token_usage` accumulates [U]. Use input + output; cached input and reasoning output are subsets, not additional tokens. | Fixtures cover overlap, zero/invalid usage and latest-response replacement. Provider accuracy unverified. |
| Hook-readable usage at tool boundaries | Synchronous `PostModelRequest` carries status and `token_usage`; synchronous dispatch defers tool execution until it completes [M]. It includes host child ids [I]. Observation-only: stdout cannot inject or gate. | **Absent from the public hooks event list** [H]. The docs warning concerns moving `main` schemas, not a prohibition on pinned source. Adapter deliberately depends on this version-specific source contract; real observer firing unverified. |
| Transcript alternative and window | `transcript_path` is documented, but JSONL is explicitly unstable [H]. Source [U] establishes its per-response/cumulative record shapes; model info exposes a usable context window. Child tool hooks use their own rollout; SubagentStop instead has parent `transcript_path` plus `agent_transcript_path` [I]. | Adapter does not poll JSONL, assume flush timing, or borrow the root window. Hook payload has no established child window, so integer-only soft is uncapped. Compaction clears adapter measurements; native compaction remains untouched. |
| Native subagents and delivery | Thread-spawn children have `agent_id = thread_id`, role-derived `agent_type` [I]. SubagentStop exposes latest assistant message. Native mailbox delivery carries messages; `wait_agent` is a wake/status path, not itself a rich handback result [D]. | Final native text is the candidate short-return path. No Claude-style classifier handback contract is claimed. Actual receipt and successor spawning unverified. |
| Trusted introduction | SessionStart/SubagentStart output is extra developer context before work; later tool hooks also support additionalContext [H]. Output normally spills beyond approximately 2500 tokens. | Intro/notices fixture-covered. No system-prompt rewrite or model-trust guarantee. Keep reference payloads in the reader, not start-context injection. |
| MCP tools and caller binding | Raw MCP calls contain tool arguments, not trusted session/child identity [R]. Host PreToolUse receives identity and original arguments, and can rewrite the MCP arguments [I,R]. Hooks can fail open. | Bridge fixtures bind immutable arguments to host identity with random single-use capabilities. Missing/disabled/untrusted hooks leave unbound MCP calls, which are rejected. Real hook-to-MCP dispatch remains unverified. |
| Packaging and storage | Portable `plugin.json` + `mcp.json`; explicit OpenAI hook override replaces default `hooks/hooks.json` [P]. Hook/MCP processes get PLUGIN_ROOT and writable PLUGIN_DATA [E]. Hooks require review of definition/content hashes [H,T]. | CLI installation, enabled plugin, expanded stdio paths and plugin data env observed. Data resolved under `$CODEX_HOME/plugins/data/agent-plugins/<id>`; do not derive this path yourself. No noninteractive hook validator/listing was established. |
| Rotation / optional enforcement | PreToolUse deny exists but specialized/hosted paths can bypass tool hooks [H]. Stop/SubagentStop block requests another pass; `continue:false` wins. App-server thread/start/fork/resume exist outside hooks [A]. | MVP has persistent closure plus supported-tool denial, no hard token gate, root rollover or automatic spawn. Stop correction is bounded guidance, not deterministic delivery. |

## Smallest safe MCP bridge

The server must not trust a caller id echoed by a model. `PreToolUse` instead:

1. Captures the host caller, exact original arguments, tool name and diagnostics.
2. Publishes that immutable request privately under a random 32-byte capability.
3. Rewrites tool arguments to only `{capability: ...}`.

The server atomically claims and deletes the request, checks the bound tool and
live caller, then validates the original arguments. Direct calls, replay,
cross-tool substitution and model-supplied caller fields fail. The handover and
closure publish together with exclusive first-writer semantics. A failed write
is not a successful handover. Hook failure cannot authorize an unbound MCP call.
Concurrent unrelated hook rewrites may break a call, but cannot manufacture an
authorized request. This bridge is fixture-covered, not host-live-verified.

This is caller correlation, not a sandbox against another program running as
the same OS user. Reader access is intentionally open: any live bound caller
may read any stored child id; closed callers cannot read. Parent-only or
ancestor-only authorization is not claimed.

## Storage and limitations

- PLUGIN_DATA owns `handovers/`, `observations/` and `pending/`, private
  directories/files (0700/0600). Id filenames are hashed. No model-supplied path
  is accepted. Stored handover and summary remain verbatim.
- Handovers and closure have no TTL or automatic eviction. Unconsumed requests
  (for example, another hook blocks execution) and crash-leftover temporary
  files may remain. There is no disk quota or automatic deletion contract;
  cleanup belongs to the plugin-data owner and can remove closure/history.
- Atomic publication is not a crash-durability/fsync guarantee. Failure to
  observe a notice remains unknown, not proof that the model ignored it.
- Measurement is latest response input + output only; no trailing-tool-result
  estimate or child-window discovery. Unknown usage suppresses nudges. Fixed
  stages use soft, soft x 1.1 and soft x 1.2. Invalid soft config errors instead
  of silently choosing a default, so binding also becomes unavailable.
- Compact reader carries diagnostics, host-observed type/effective model,
  summary title and a bounded next-steps excerpt; pending user decisions are
  explicitly unknown and require full read. Full read contains headers and the
  handover once. Reference prompts explicitly request full text. No original
  task capture, chain lineage, requested-model-override capture or automatic
  successor recognition. Parent uses its original spawn parameters.
- Closure denies supported tool calls; disabled/untrusted/failed hooks and
  specialized tool paths weaken that work backstop. The MCP server still
  enforces closure and requires a capability. Plain-text questions after
  handover are advisory-only; never claim a universal session stop.

## Isolated non-model validation

`ISO` and `REPO` below are required absolute paths: isolated state and this
repository (with `npm install` already completed). Use a directory under
`/tmp/opencode` for ISO. No credentials or model selection are required.

```sh
: "${ISO:?}" "${REPO:?}"
mkdir -p "$ISO/home" "$ISO/codex" "$ISO/config" "$ISO/cache" "$ISO/claude"
cd "$ISO"
export HOME="$ISO/home" CODEX_HOME="$ISO/codex"
export XDG_CONFIG_HOME="$ISO/config" XDG_CACHE_HOME="$ISO/cache"
export npm_config_cache="$ISO/npm-cache" CLAUDE_CONFIG_DIR="$ISO/claude"
npm view @openai/codex version
npx --yes @openai/codex@0.165.0 --version
npx --yes @openai/codex@0.165.0 --help
npx --yes @openai/codex@0.165.0 plugin marketplace add "$REPO"
npx --yes @openai/codex@0.165.0 plugin add auto-context-handover@auto-context-handover
npx --yes @openai/codex@0.165.0 plugin list
npx --yes @openai/codex@0.165.0 mcp list
npx --yes @openai/codex@0.165.0 mcp get auto_context_handover --json
claude plugin validate "$REPO"
```

Observed: marketplace registration accepts the existing root
`.claude-plugin/marketplace.json`; plugin is installed/enabled version 0.1.0;
MCP server is stdio `node`, with expanded installed-root script/cwd and reserved
PLUGIN_ROOT/PLUGIN_DATA. All listed checks exit 0. A separate SDK stdio client
initialized the installed server, listed `context_handover` and `read_handover`,
and received `isError:true` for an unbound call. Direct command-hook probes from
a foreign cwd (including a spaced data path) returned valid start-context JSON.

`plugin add` is marketplace-based, not a direct folder installer. A preliminary
custom marketplace placed at `marketplace.json` failed; the recognized portable
location is `.agents/plugins/marketplace.json` (legacy `.claude-plugin/` also
works). `doctor` did not validate hook events: a bogus event was ignored, so it
is not acceptance evidence. Missing CODEX_HOME failed before the final probe;
creating it resolved the setup error. A temporary-directory helper-alias warning
did not prevent the successful non-model checks.

Hook discovery/override is documented and source-established; installation and
MCP listing do **not** prove hook trust, execution or tool-boundary ordering in
the installed host. Review hooks using `/hooks` before expecting the workflow.
Plugin changes require renewed review, including changes to bundled code [T].
No bypass-trust install instruction is used.

Final repository checks: `npm run typecheck` passed all four adapter projects;
`npm test` passed 434 tests (64 Codex fixtures), zero failures/skips. Claude
`plugin validate` passed with existing author/icon warnings. An independent
read-only review found no security defects; its payload-schema evidence request
is addressed by [I,M,F], its dead observer branch was removed, and reader
extraction/seed-boundary edge fixtures were added. Crash-leftover claims remain
the disclosed storage limitation, not an unconsumed capability replay path.
