# Crush adapter assessment and evidence

Status (2026-10-29): **root-session MVP** in `crush/`, assessed against release `v0.98.2`.
The local server provides workspace/session reads, root creation and detached
prompt admission. Explicit installation enables the adapter to control that
Unix socket API and continue in a background root. The TUI does not follow.
Native children bypass hooks and are unsupported. Actual host hook firing,
model compliance and end-to-end continuation remain unverified. Non-model
server/config/MCP checks and fixtures do not establish them.

License: `FSL-1.1-MIT` (`LICENSE.md`). Reimplement ideas only; never
vendor Crush code.

## Release vs nightly (read first)

The assessed release is `v0.98.2` (commit
`d6329fbd900a5c63a452797b74ff8d1c499aebef`). At that tag, hooks are **PreToolUse-only**: the
release
[README](https://github.com/charmbracelet/crush/blob/v0.98.2/docs/hooks/README.md#L22-L22)
states "Crush currently supports just one hook, `PreToolUse`";
[hooks.go](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/hooks/hooks.go)
defines only `EventPreToolUse`; the
[payload](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/hooks/input.go)
is event/session/cwd/tool/input only. The lifecycle commits
(`48c0224d` session/turn/permission/compaction hooks, `bdc53ce0`
PostToolUse, `40f57825` unified Event/Runner, `9dac45bd` event-list
validation) are not ancestors of `v0.98.2`.

The adapter targets latest stable releases within major 0; its server guard
accepts `v0.<minor>.<patch>` (optional `v`), not an exact patch or a nightly.

Historical lifecycle investigation below also covers **unreleased**
nightly `3538c722ffce86ce41543df72c6efa4ea5e1672e` (supersedes prior
nightly `6366afc8`; binary reports
`v0.98.3-0.20261027134723-3538c722ffce`). Nightly links are not a
released contract and must be re-verified before any support claim. Implementation
uses only release PreToolUse, static context, MCP and local-server routes.
Historical nightly-only lifecycle findings are not compatibility promises.

## Primary sources

- [H] [Hooks (nightly)](https://raw.githubusercontent.com/charmbracelet/crush/3538c722ffce86ce41543df72c6efa4ea5e1672e/docs/hooks/README.md):
  13 events, payload/output shapes, exit codes, aggregation.
- [E] [Events](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/hooks/events.go#L6-L118):
  13 event names, tool-carrying map, `Event`/`ToolCall` structs.
- [P] [Payload](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/hooks/input.go#L25-L99):
  stdin JSON and environment; **no usage/token/window fields**.
- [O] [Output](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/hooks/input.go#L107-L155):
  `decision`, `halt`, `reason`, `context`, `updated_input`,
  `updated_output`, Claude Code compat (`decision:"block"`,
  `continue:false`, `hookSpecificOutput`).
- [G] [Aggregation](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/hooks/hooks.go#L89-L158):
  `Blocked()` = deny or halt; deny > allow > none; halt sticky;
  shallow-merge `updated_input`; last-writer `updated_output`.
- [T] [Tool interception](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/hooked_tool.go#L54-L100):
  PreToolUse gate, input rewrite, allow pre-approval, PostToolUse
  output replace and context feedback, `StopTurn` on halt. No
  YOLO/skip reference exists in `hooked_tool.go` or `internal/hooks`:
  hooks fire whenever configured, regardless of YOLO (YOLO only sets
  `SkipRequests` on the permission service).
- [S] [Subagent exclusion](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/coordinator.go#L975-L980)
  and [turn exclusion](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/turn_hooks.go#L21-L31):
  sub-agent tools and turns never fire hooks; the outer `agent` tool
  call is hooked. `[release]`: same exclusion at
  [v0.98.2 hooked_tool.go](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/agent/hooked_tool.go#L29-L32)
  and
  [v0.98.2 coordinator.go](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/agent/coordinator.go#L982-L982).
- [N] [Child non-interactive](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/coordinator.go#L1676-L1687):
  `runSubAgent` runs with `NonInteractive: true`; `fireTurnHook`
  returns early for non-interactive calls [S]. The exclusion is
  structural, not a matcher the adapter can opt out of.
- [A] [Subagent run](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/coordinator.go#L1643-L1700):
  `agent` task tool creates a child session via `CreateTaskSession`
  with parent linkage and returns final text as the tool result.
- [U] [Usage](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/agent.go#L1991-L2042):
  `updateSessionTokenCounters` **replaces** (not accumulates) nonzero
  `CompletionTokens` (= latest output) and `PromptTokens` (= input +
  cache-read + cache-create); zero-usage fallback in
  `internal/agent/usage_fallback.go`. `[release]`: same replacement
  semantics at
  [v0.98.2 agent.go](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/agent/agent.go#L1964-L2004).
- [V] [Save sites](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/agent.go#L1100-L1112):
  per-step usage is saved to the session DB in `OnStepFinish`
  (`updateSessionUsage` then `sessions.Save`); the second save site is
  post-compaction
  ([agent.go](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/agent.go#L1522-L1530)).
   The pinned `charm.land/fantasy v0.45.1`
   [stream loop](https://github.com/charmbracelet/fantasy/blob/v0.45.1/agent.go#L1050-L1070)
   invokes `OnStepFinish` after `processStepStream` returns; that function
   already executed the
   [tools](https://github.com/charmbracelet/fantasy/blob/v0.45.1/agent.go#L1674-L1713).
   Both PreToolUse and PostToolUse therefore precede the requesting
   response's DB usage save. Counters at those hooks lag one response
   in the normal step sequence (initial counters may be zero; nonzero
   replacement can retain older values). This ordering is source-established,
   not observed with a model.
- [W] [Window](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/agent.go#L1116-L1140):
  auto-summarize threshold from `CatwalkCfg.ContextWindow`; unknown
  (0) skips. `--context-window` model flag in
  `internal/shellconfig/model.go`.
- [D] [Storage](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/db/connect.go#L93-L178):
  sqlite `crush.db` under the data directory (default `.crush`);
  sessions carry `prompt_tokens`/`completion_tokens`
  (`internal/db/migrations/20250424200609_initial.sql`); `EstimatedUsage`
  is an in-memory service map (`internal/session/session.go`), not a column.
- [M] [MCP tools](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/tools/mcp-tools.go#L24-L60):
  names are `mcp_<server>_<tool>`; all filtered tools (including MCP)
  pass through `wrapToolsWithHooks`.
- [C] [Config validation](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/config/hooks.go#L13-L49):
  unknown events rejected; matchers only on tool events.
- [F] [Static context files](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/config/config.go#L30-L46):
  default `context_paths` include `CRUSH.md` and `AGENTS.md` variants;
  loaded into the system prompt at agent build
  ([prompt.go](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/prompt/prompt.go#L166-L172),
  [coordinator.go](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/coordinator.go#L843-L845)).
  This is a genuine standing-guidance channel with system-prompt
  placement, but it is static and build-time: mid-session file edits
  have no established reload cadence (unverified). It does not carry
  per-request measurement or staged notices.
- [R] [Non-interactive surface](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/cmd/run.go#L61-L134):
  `crush run [--session ID | --continue] "prompt"`. `Summarize`
  takes only a session id (host-generated summary; no
  caller-supplied-summary parameter) at
  [agent.go](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/agent.go#L1392-L1399)
  and
  [coordinator.go](https://github.com/charmbracelet/crush/blob/3538c722ffce86ce41543df72c6efa4ea5e1672e/internal/agent/coordinator.go#L1460-L1475).
   There is no supplied-summary compaction parameter. Separate local-server
   create/prompt routes below enable fresh-session continuation.
   `session` CLI offers delete/last/list/rename/show (observed).
- [API] [Released server handlers](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/server/proto.go):
  GET version/workspaces/session/agent and POST workspace/session/agent.
  [Backend admission](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/backend/agent.go#L16-L60)
  validates then dispatches a workspace-owned goroutine. HTTP 202 acknowledges
  admission, not successful model execution; disconnect does not cancel it.
  No adapter idempotency key exists for creation or admission.
- [HOST] [Released server command](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/cmd/server.go)
  accepts an explicit Unix socket host. Adapter transport is absolute Unix
  socket only, with no discovery or TCP. The
  [current-session endpoint](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/server/proto.go#L109-L132)
  records a calling client's selection, not safe TUI auto-follow.
- [REL] Release integration contracts:
  [hook payload/output](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/hooks/input.go),
  [shallow merging](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/hooks/hooks.go),
  [interception](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/agent/hooked_tool.go),
  [MCP naming](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/agent/tools/mcp-tools.go),
  [static context](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/agent/prompt/prompt.go),
  [hook config](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/shellconfig/hook.go),
  [MCP config](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/shellconfig/mcp.go),
  [context-path option](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/shellconfig/options.go).

## Capability assessment

`Documented` means public docs; `Source-established` means pinned code
(nightly unless `[release]`); `Observed` means a non-model
binary/config check; `Unverified` is not a negative capability claim.

| Capability | Documented / source-established | Observed / unverified |
| --- | --- | --- |
| Current context measurement | Session counters replace nonzero values from the **latest** response: completion = output, prompt = input + cache-read + cache-create [U]. Window from model `ContextWindow`; unknown skips auto-summarize [W]. `EstimatedUsage` flags zero-provider-usage fallback [U]. | Hook payloads carry **no** usage/token/window fields [P]. DB polling sees latest saved values, not cumulative totals; `EstimatedUsage` is not in the DB [D]. Requesting-response usage is saved only after its tools/hooks finish [V]; provider accuracy unverified. |
| Hook-readable usage at tool boundaries | Release PreToolUse carries session/cwd/tool/input, no usage [REL]. Server GET session/agent exposes saved counters/window [API]. | Release zero-counter root and unknown-window agent observed. API reads, not SQLite/transcript polling. Tools/hooks precede requesting-response usage save [V]; real timing/model behavior unverified. |
| Transcript alternative and window | Server session messages/history and model context_window exist [API]; SQLite remains host-owned [D]. | Transcript polling not used. Model-free agent reports context_window=0; configured-model accuracy unverified. Unknown percentages stay unresolved. |
| Native subagents and delivery | `agent` task tool with parent-linked child session; final text returned as tool result [A]. Outer `agent` call fires PreToolUse with `tool_name=agent` and caller session id; inner tools/turns fire nothing, structurally (`NonInteractive: true`) [S,N]. | **Blocked**: no hook inside the child means no child measurement point, no child notices, no per-child MCP capability binding. Actual parent receipt of long outputs unverified. |
| Trusted introduction | Static context-path files load at agent build [REL,F]; install loads crush/CONTEXT.md. PreToolUse context is tool-result-adjacent [REL]. | Exact context-path config observed; reload cadence and model trust/compliance unverified. Nightly SessionStart/TurnStart results ignored. No per-request injection. |
| MCP tools and caller binding | MCP names mcp_<server>_<tool>, wrapped by root hooks; updated_input shallow-merges original args [REL]. | Real SDK stdio lists two tools. Single-use immutable-argument root binding fixture-covered; manual hook stdin/read integration checked separately from unverified host firing. No child binding. |
| Packaging and storage | `crushrc` shell-config builtins: `hook add <event> --command ... [--matcher ...] [--name ...] [--timeout N]`, `mcp add <name> --type stdio ...` [C plus `internal/shellconfig/hook.go`, `mcp.go`]. Unknown events and lifecycle matchers rejected at load [C]. | Valid crushrc loads cleanly; bogus event and lifecycle matcher produce config errors (observed, isolated). No quota/eviction contract found. |
| Rotation / optional enforcement | Server creates roots and admits detached prompts [API]. Release PreToolUse deny/halt closes supported source tool paths [REL]. | Root creation observed without a model. POST agent wire/202/failures fixture-covered only; real admission/continuation unverified. No TUI switch, child rotation or hard token gate. Compaction unchanged. |

## Implemented root scope

The initial assessment-only stop was superseded by [API]: child exclusion does
not prevent root creation plus one seeded background prompt. The active model
authors the full handover. Storage/closure precede creation; successor id
precedes admission; no automatic retries. Workspace owns model resolution.
No original task capture, child lineage, TUI following, hard gate or loop guard.

Integer soft defaults to 200000 and caps at 70% of a known window; percentages
remain explicit. Unknown usage suppresses notices; unknown-window percentages
stay unresolved and integers uncapped. Invalid configuration errors. Shared
seed-size advice uses the full actual seed at ceil(chars/4), warns above 50% of
known soft and never gates or rewrites model text.
Unknown soft does not disable explicit handover/readback. Diagnostics retain
known estimate/stage/soft, but reason is always unknown: separate hook processes
do not persist notice provenance. Current over-limit state is not proof of a
prior appended notice, much less model receipt.

## Hook-bound MCP bridge

`PreToolUse` on exact adapter tool names captures the root caller, original
arguments and
tool name; publishes that immutable request privately under a random
32-byte capability; and merges a `capability` key into the tool arguments.
Original fields survive Crush's shallow merge [G]. The server must ignore
those untrusted runtime fields and validate only the immutable original
arguments in its bound request. It atomically claims and deletes the
request, checks the bound tool and live caller, then validates the
original arguments. Direct calls, replay, cross-tool substitution and
model-supplied caller fields fail. No input scrubbing is specified:
scrubbing provides no security promise here; safety comes from
immutability plus single-use consumption. Hook failure cannot authorize
an unbound MCP call. Implementation and regression fixtures live in `crush/`.

## Storage and limitations

- Session token counters are latest-response replacement, not
  cumulative; history beyond the latest response is unavailable from
  counters (messages table is the only history) [U,D].
- Requesting-response usage is not saved until after its tools/hooks
  finish; DB counters at those hooks normally lag one response [V].
- `EstimatedUsage` is memory-only and lost on restart [D].
- Measurement fails open on unknown usage; percentages
   must remain unresolved when the window is unknown.
- Closure/denial covers only hooked top-level paths; sub-agent
  internals are structurally unhooked [S,N]. No YOLO bypass is claimed:
  hooks fire regardless of YOLO [T].
- Plain-text follow-ups after handover are advisory-only; never claim a
  universal session stop.
- Release `v0.98.2` cannot host lifecycle behavior (PreToolUse only);
   nightly is an unreleased contract, not a supported release.
- Handover, summary and closure are first-writer immutable private files;
  status is separate. Directories 0700/files 0600, hashed session ids, no quota,
  TTL or eviction; abandoned pending/temp files can remain. Same-user storage
  is not a sandbox; deletion removes history and closure, no fsync guarantee.
- Any live bound root may read any retained id; closed roots cannot read/work.
  Ordinary lock checks fail open on storage errors; MCP storage/closure checks
  are strict. Uncertain create/admission requires inspection before manual
  recovery; source stays closed and admission does not prove run success.
  A crash between root creation and link persistence can orphan an unrecorded
  successor. No cross-server/filesystem transaction is claimed.

## Isolated non-model validation

### Release root/API and adapter integration

Use the [README installation snippet](../../README.md#crush-root-session-adapter)
in a scratch project with all HOME/XDG directories isolated. The exact snippet
was parsed by release v0.98.2, including an installation path containing spaces;
GET workspace config exposed the expected hook command, MCP argument and static
context path. The project hook was also invoked manually with representative
stdin, separately from unverified automatic host execution.

Reproducible server checks (set absolute isolated paths first; no credentials
or model configuration required):

```sh
: "${ISO_HOME:?}" "${ISO_CFG:?}" "${ISO_CACHE:?}" "${ISO_DATA:?}"
: "${ISO_STATE:?}" "${ISO_RUNTIME:?}" "${BIN:?}" "${PROJ:?}"
export HOME="$ISO_HOME" XDG_CONFIG_HOME="$ISO_CFG" XDG_CACHE_HOME="$ISO_CACHE"
export XDG_DATA_HOME="$ISO_DATA" XDG_STATE_HOME="$ISO_STATE"
export XDG_RUNTIME_DIR="$ISO_RUNTIME"
export AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET="$ISO_RUNTIME/crush.sock"
cd "$PROJ"
"$BIN" --version
"$BIN" session list
"$BIN" dirs
"$BIN" server --host "unix://$AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET"
# In another terminal with the same environment, once the socket is ready:
curl --fail --unix-socket "$AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET" http://localhost/v1/health
curl --fail --unix-socket "$AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET" http://localhost/v1/version
curl --fail --unix-socket "$AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET" http://localhost/v1/docs/openapi.json
CLIENT_ID=$(node -p 'require("node:crypto").randomUUID()')
jq -n --arg path "$PROJ" --arg client_id "$CLIENT_ID" \
  '{path:$path,client_id:$client_id}' > workspace-request.json
curl --fail --unix-socket "$AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET" \
  -H 'Content-Type: application/json' -d @workspace-request.json \
  http://localhost/v1/workspaces > workspace.json
WID=$(jq -er '.id' workspace.json)
curl --fail --unix-socket "$AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET" \
  -H 'Content-Type: application/json' -d '{"title":"Non-model fixture"}' \
  "http://localhost/v1/workspaces/$WID/sessions" > session.json
SID=$(jq -er '.id' session.json)
curl --fail --unix-socket "$AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET" \
  "http://localhost/v1/workspaces/$WID/sessions/$SID"
curl --fail --unix-socket "$AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET" \
  "http://localhost/v1/workspaces/$WID/agent"
"$BIN" session show "$SID" --json
```

Observed release results: version `v0.98.2`; health 200; OpenAPI 69 paths;
workspace/root creation 200; root parent id empty, prompt/completion counters 0;
GET session matches created id; agent `is_ready:false`, empty model id/window 0;
CLI JSON counters agree. No prompt was sent to a real server. POST agent
`{session_id,prompt}` with expected 202, unexpected status and timeout behavior
are tested only against fake HTTP sockets. Actual continuation remains unverified.

SDK stdio checks list `context_handover` and `read_handover`, reject an unbound
read, and accept a manually hook-bound read returning a missing-handover result.
This proves executable integration, not actual host hook dispatch or model use.

### Historical release/nightly CLI checks

`ISO_HOME`, `ISO_CFG`, `ISO_CACHE`, `ISO_DATA`, `ISO_STATE`, `BIN`,
`PROJ` below are required absolute paths: isolated home/config/cache/
data/state, the `crush` binary, and a scratch project directory. No
credentials or model calls are required.

```sh
: "${ISO_HOME:?}" "${ISO_CFG:?}" "${ISO_CACHE:?}" "${ISO_DATA:?}" "${ISO_STATE:?}" "${BIN:?}" "${PROJ:?}"
export HOME="$ISO_HOME" XDG_CONFIG_HOME="$ISO_CFG" XDG_CACHE_HOME="$ISO_CACHE"
export XDG_DATA_HOME="$ISO_DATA" XDG_STATE_HOME="$ISO_STATE"
mkdir -p "$PROJ" && cd "$PROJ"
"$BIN" --version
"$BIN" --help
"$BIN" dirs
"$BIN" session list
"$BIN" stats
"$BIN" models
"$BIN" session --help
"$BIN" run --help
printf 'hook add PreToolUse --matcher "^bash$" --command "./hooks/no.sh" --name "t"\nhook add TurnStart --command "./hooks/s.sh"\nmcp add probe --type stdio --command "node" --args "server.js"\n' > crushrc
"$BIN" session list   # valid crushrc loads cleanly
printf 'hook add BogusEvent --command "./x.sh"\n' > crushrc
"$BIN" session list   # config error: unknown event
printf 'hook add TurnStart --matcher "^bash$" --command "./x.sh"\n' > crushrc
"$BIN" session list   # config error: matcher only on tool events
```

Observed (nightly binary `v0.98.3-0.20261027-3538c72`; install surface
also checked on release binary `v0.98.2`): `dirs` shows isolated
config/data paths; `session list` empty-clean; `stats` reports no
sessions; `models` lists provider models; there is no `hook` or `mcp`
CLI command (both are `crushrc` builtins). Valid lifecycle+tool+MCP
crushrc exits 0; `BogusEvent` fails with `hook BogusEvent: unknown
event`; a matcher on `TurnStart` fails with `matcher is only supported
on tool events`. Automatic host hook/MCP dispatch and any
model behavior remain unverified. Lifecycle config examples in this historical
block apply only to nightly, not release. The release adapter uses the separately
validated README PreToolUse-only snippet above.

Binary provenance (both verified by sha256 against published
`checksums.txt` at download time):

- Release: `https://github.com/charmbracelet/crush/releases/download/v0.98.2/crush_0.98.2_Linux_x86_64.tar.gz`
  (`ebc8fb462c0ed749e6bfd66c08c4e5a1408ac477b72f52c831d86d1a419a53b8`),
  checksums at `https://github.com/charmbracelet/crush/releases/download/v0.98.2/checksums.txt`.
- Nightly: `https://github.com/charmbracelet/crush/releases/download/nightly/crush_0.99.0-nightly_Linux_x86_64.tar.gz`
  (`3d05cc3a813e814f98a33e3a3c79231ed4ace7b13eadbf0008e030e9817ce212`),
  checksums at `https://github.com/charmbracelet/crush/releases/download/nightly/checksums.txt`.
