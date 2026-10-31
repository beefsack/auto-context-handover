# auto-context-handover

Measured soft-limit handover plugin for OpenCode V2 (verified against 2.1.4).

Also includes a [Pi root-session adapter](#pi-root-session-adapter) (assessed
against 0.73.1, manual command rollover), a [Codex child adapter](#codex-cli-subagent-first-adapter)
and a [Claude child adapter](#claude-code-subagent-only-adapter), plus a
[Crush root adapter](#crush-root-session-adapter) and an
[AiderDesk root adapter](#aiderdesk-root-agent-task-adapter) and a
[Cline CLI/SDK root adapter](#cline-clisdk-root-adapter), plus an
[Amp focused-root adapter](#amp-focused-root-adapter), a
[Goose root adapter](#goose-root-session-adapter), a
[Kilo root adapter](#kilo-root-session-adapter) and a
[Qwen child adapter](#qwen-code-subagent-first-adapter), plus an
[OpenHands SDK adapter](#openhands-sdk-adapter) (not a CLI plugin).

The session's own model writes the handover; a linked fresh session continues it automatically, or lock mode stops without a successor. Subagents return only a summary to the parent.

The plugin only measures, warns, hard-gates, and rotates.
`compaction.auto` stays on and untouched. Activation
is runtime only: the plugin registers hooks and tools on host load, no model
calls. The bundled TUI companion follows successful root rollovers when you
are still viewing the old session. It never switches you away from another
session or shows review/confirmation UI. Desktop and web do not auto-follow.

## Supported harnesses

Non-OpenCode adapters have no hard token gate; live model compliance remains unverified.

| Harness | Status | Scope | Known issues / missing functionality |
| --- | --- | --- | --- |
| [OpenCode (primary)](#behavior) | Supported | Automatic root rollover + subagents; opt-in hard limit | Held at `~2.1` (2.2.0 removed `Message`); root successors cannot resume background children |
| [Claude Code](#claude-code-subagent-only-adapter) | Supported | Subagents only; roots intro/read only | 10-35% batch overshoot; hard limit pending, parent continuation advisory |
| [Codex CLI](#codex-cli-subagent-first-adapter) | Supported | Subagent-first | Undocumented source-only `PostModelRequest`; integer-only uncapped soft, live untested |
| [GitHub Copilot CLI](#github-copilot-cli-subagent-first-adapter) | Supported | Child-first | Experimental extension API, live untested; general-purpose children lack lifecycle hooks |
| [Cline CLI/SDK](#cline-clisdk-root-adapter) | Supported | Root advisory; manual continuation | Chars/4 estimate; VS Code extension unsupported, live untested |
| [Pi](#pi-root-session-adapter) | Supported | Root; user `/handover`, then automatic seeded successor | No subagent support; live untested |
| [Kilo](#kilo-root-session-adapter) | Supported | Root advisory; manual continuation | Experimental transform hook; extension runtime unverified, live untested |
| [AiderDesk](#aiderdesk-root-agent-task-adapter) | WIP/untested | Root Agent mode; manual continuation | Automatic fresh-task initialization unverified |
| [Amp](#amp-focused-root-adapter) | WIP/untested | Focused root; automatic successor thread | No chain cap |
| [Crush](#crush-root-session-adapter) | WIP/untested | Root; opt-in automatic successor via local server socket | Native children unsupported; one-response counter lag, no chain cap |
| [Qwen Code](#qwen-code-subagent-first-adapter) | WIP/untested | Subagent-first | Integer-only uncapped soft |
| [Goose](#goose-root-session-adapter) | WIP/untested | Root; manual continuation | Notices only via opt-in Stop denials |
| [OpenHands](#openhands-sdk-adapter) | WIP/untested | Python SDK helper; manual continuation | No CLI; notices only on next user prompt |
| Antigravity CLI | Blocked | No adapter | No hook-readable child measurement/parent identity; MCP caller binding unestablished |
| Cursor | Blocked | Editor/CLI; no adapter | No measured pre-compaction boundary |
| Cline VS Code extension | Blocked | No adapter | File hooks lack usage/per-request measurement |
| Hermes Agent | Planned | To assess | No adapter |
| Windsurf/Devin Desktop | Planned | To assess | No adapter |
| Warp | Planned | To assess | No adapter |
| Kiro | Not pursued | No adapter | - |
| Zed | Not pursued | No adapter | - |
| Mistral Vibe | Not pursued | No adapter | - |
| OpenClaw | Not pursued | No adapter | - |
| Aider | Not pursued | No adapter | - |
| Gemini CLI | Dropped | No adapter | Replaced by Antigravity CLI |
| Roo Code | Dropped | No adapter | Discontinued |

## Install (local directory)

Adapters target the latest harness releases and accept update breakage. Exact
versions below identify assessment evidence, not installation pins. Necessary
compatibility ranges stop at major or major.minor: OpenCode currently uses
`~2.1` because 2.2.0 removes the `@opencode/ai` `Message` export used here.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/auto-context-handover", "options": {
      "soft": 200000
    } }
  ]
}
```

Run `npm install` once in this directory (runtime deps for the plugin host).
No build step: the host resolves the root `index.ts` shim and loads `source/`
directly. Node >= 22.18 is required for the `.ts` tests.
The root `tui.ts` companion loads automatically from the same `plugins` entry;
no separate install, `cli.json` entry, or additional option is required.
Local source changes are watched for automatic plugin reload. Keep related
edits coherent: a failed import can leave the previous generation active.
In one live check, a stale missing-export failure persisted across saves until
a clean host restart; inspect load errors before accepting live test evidence.

## Config reference

| Key | Default | Meaning |
| --- | --- | --- |
| `soft` | `200000` | Warn threshold: positive integer tokens or a percentage string. No ratios. Integers resolve as `min(value, floor(0.7 * window))`; percentages use their requested percentage without the cap. Precedence: child prompt marker > agent override > `"provider/model"` > bare `"model"` > this value, resolved against the request's model only. |
| `hard` | unset | Opt-in hard gate, same formats. Past it, every tool except `context_handover` is removed for that request. |
| `modelOverrides` | `{}` | e.g. `{"anthropic/claude-opus-4-6": "60%", "gpt-5": 90000}`; validated independently. |
| `agentOverrides` | `{}` | e.g. `{"build": "80%"}` (highest configured precedence); validated independently. |
| `stages` | `[0, 0.1, 0.2]` | Nudge boundaries relative to soft: warn at soft, then soft*(1+offset). Must be 3 ascending offsets starting at 0; stage texts are fixed. |
| `onHandover.primary` | `"new-session"` | `"new-session"` starts a linked successor; `"lock"` stops with no tools. Other values (including removed actions, `reset` or the old flat string) are setup errors listing the supported actions. |
| `onHandover.subagent` | `"return"` | Only `"return"` is supported. Anything else is a setup error. |
| `handoverDescription` | built-in | Overrides the `context_handover` tool description template wholesale. |

Full example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/auto-context-handover", "options": {
      "soft": 200000,
      "hard": "95%",
      "modelOverrides": { "anthropic/claude-opus-4-6": "60%" },
      "agentOverrides": { "build": "80%" },
      "stages": [0, 0.1, 0.2],
      "onHandover": { "primary": "new-session", "subagent": "return" }
    } }
  ]
}
```

Low-threshold testing: `{ "soft": 2000, "hard": 4000 }` forces warn/hard
quickly. Thresholds resolve against the model catalog window (`limit.input`
preferred, else `limit.context`). Integer soft values resolve as
`min(value, floor(0.7 * window))`, so the default is 200000 tokens or 70% of
the window, whichever is smaller. The same cap applies to configured integers;
explicit percentages remain uncapped. Hard limits are uncapped and take priority
when reached, even if below soft. With an unknown window, integer soft still
applies, percentage soft fails open, and hard gating is disabled. All-zero
provider usage counts as unknown; without usable usage there is no nudge or gate.

### Per-child test override

Start a new subagent's spawn prompt with a namespaced marker line:

```text
[auto-context-handover-test soft=4096]
Complete the bounded task below...
```

`soft` accepts the same capped integer tokens or uncapped percentage strings as
configuration, with the same unknown-window behavior.
The whitespace-separated `key=value` syntax reserves room for future options;
only `soft` is implemented. Unknown keys, duplicate keys, malformed pairs and
invalid values reject the initial child prompt with an explicit error.

The plugin recognizes only the beginning of a real child's initial prompt,
allowing OpenCode's standard subagent banner. It awaits session-keyed storage
before removing the marker from admitted text. Root prompts, later prompts,
quoted material and tool results are not scanned. The override outranks all
configured soft values without changing `hard`, nudges or child return behavior.
It needs no configuration edit or restart, survives reload and compaction,
and is deleted with the child. Descendants and successors do not inherit it.
The first request still needs usable assistant usage before it can be nudged:
give tests at least two model turns, for example by requiring successive tool
calls before completion.

## Behavior

- Measure the latest assistant's normalized input, cache read/write, output,
  and reasoning once, plus trailing text at chars/4, including settled tool
  results. No usage anchor means no warning or hard gate.
- Append a stable, per-request stage nudge to the END of messages, not the
  initial system prompt. The model finishes its unit and calls
  `context_handover({handover, summary})`; text is stored verbatim.
- Primary rollover creates a ROOT with the active agent/model/variant and original
  directory. Readiness, links, and source lock precede successor prompting.
  The seed carries the full handover and backlink; the old session records
  `continued in session <id>`. The TUI follows only if it is still showing the
   source when the successful rollover arrives and after successor lookup.
- Initial child continuation uses reference seeding: the parent reads the full
  handover, then spawns a same-agent-type successor using the same model and
  variant/effort, with a prompt instructing
  it to call `read_handover` with the predecessor session ID and continue
  from "Prioritized next steps"; the handover is never pasted into the spawn
  prompt. Both treat the original task as reference context: completed steps
  are done and must not be repeated; predecessor facts are trusted unless
  marked unverified, without relabelling their evidence as the successor's
  direct verification. Targeted re-reads of already-covered material may
  resolve open questions, not repeat completed steps. Continue from
  "Prioritized next steps", independent of section numbering.
- OpenCode readback, root seeds and child replies state the observed
  variant/effort and require reuse. Unavailable values are `unknown`; reuse
  the predecessor's original spawn parameters including effort, never usage-based guesses.
- Lock mode creates no successor. A child handover replaces its required
  final report for that session; before storage, read-only task instructions
  still allow the handover tool because it writes only plugin storage. The
  tool result tells the child to end its turn now with exactly the following
  continuation text as its final message and then stop. The native parent
  receives the child's latest completed assistant text, not the tool result.
  The reply carries the short summary, child session ID, and exact
  `read_handover` call plus the reference-seeding successor instruction. A
  successor continues and replaces its predecessor as the same logical
  subagent, not an additional subagent under subagent-count limits. Ask only
  about handover-listed user-owned decisions, except checking in is allowed
  if progress stalls or remaining work grows. The child stop-lock refuses
  later questions or work explicitly, with the exact reader call and a
  successor/fresh-subagent continuation hint, not the old summary. Claude
  native `SubagentHandback` delivery is unchanged.
- The default handover template requires plain disclosure of deviations,
  triggered stop conditions, failed calls and unverified claims. Unresolved
  deviations/stops preclude PASS or completion; summaries must not overclaim.
  Keep open questions explicitly. Do not author your own agent/model/chain
  provenance: the plugin records it; its record takes precedence over prose.
- EXPERIMENTAL loop guard: three consecutive successors adding <25% of soft
  beyond their seed lock instead of rotating. Productive handovers
  reset the streak; the first root handover never counts. Seed >50% of soft
  only warns.

## Kilo (root-session adapter)

Targets latest **Kilo CLI** (`@kilocode/cli`) and the current CLI-backed
**Kilo Code VS Code extension** plugin contract (assessed against 7.8.23). CLI loading/registration
is observed; extension loading and model compliance are unverified. Legacy
Roo-derived Kilo extension releases are not supported. The OpenCode V2 root
entry does not load on Kilo's different API; use `kilo/index.ts` instead.

Run `npm install` in this intact checkout, then merge into project `kilo.json`
(or the Kilo user config). No build, separate MCP server or marketplace install:

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": [
    ["file:///absolute/path/to/auto-context-handover/kilo/index.ts", { "soft": 200000 }]
  ]
}
```

- Keep the checkout and dependencies together; do not copy `kilo/` alone or
  install the repository root as a Kilo plugin. `KILO_PURE=1` disables external
  plugins. Kilo's key is singular `plugin`, unlike OpenCode V2 `plugins`.
- Root sessions only: host tool context supplies session/agent identity;
  `session.get` must confirm a matching parentless session before writing.
  Children cannot write; any equipped caller may read any retained id.
- Latest ordinary assistant's normalized input/cache/output/reasoning plus
  trailing text and settled tool outputs at chars/4 estimates the active
  compaction-filtered history. This is not cumulative billing or exact tokens;
  later host overhead/media/pruning changes are not modeled. Summary-worker
  usage and pre-summary retained-tail anchors are excluded; after compaction
  measurement waits for fresh ordinary usage. Unknowns produce no notice.
- `soft` defaults to 200000; integers cap at 70% of the request model's catalog
  context window. Percentage strings use their explicit percentage. Unknown
  window: integers uncapped, percentages silent. The tuple option overrides
  `AUTO_CONTEXT_HANDOVER_SOFT`; invalid values disable notices, not tools.
- Intro text is added to the first root user message per plugin registration;
  a reload can introduce it again. Stable transient tail notices escalate at
  soft, soft x 1.1 and soft x 1.2. Native compaction is unchanged and may happen
  first; an observation-only hook skips its separate summarizer transform.
- The model calls `context_handover({handover, summary})` and ends its turn.
  No automatic rollover, source lock, hard gate or UI following. Open a
  **fresh equipped root**, not a resumed history, and submit:

  ```text
  Call read_handover({"sessionID":"SOURCE_ID"}) and continue from "Prioritized next steps".
  ```

- Full verbatim text returns once with shared no-repeat/evidence framing.
  Handover-only chars/4 above 50% of recorded soft warns/advises compression,
  never rewrites or gates. No original-task capture, child lineage or
  model-override preservation promise. Diagnostics record notice append, not
  model receipt; transient loss after reload stays unknown.
- Immutable hashed-id records live under `~/.kilo/auto-context-handover/`.
  New directories/files use 0700/0600; first-writer atomic publication is not
  fsync durability or a same-user sandbox. No quota/TTL/eviction/deletion
  cleanup; retention is manual and interrupted writes can leave temporary files.

[Capabilities, pinned citations and non-model checks](docs/research/kilo.md).
Actual hook dispatch, model compliance and manual fresh-root continuation
remain unverified. The host's older Zod preserves required string schemas but
drops per-argument descriptions; the complete tool descriptions remain intact.

## Goose (root-session adapter)

Targets latest Goose (assessed against v1.56.0). Requires Node >=22.18 and `npm install` in this
intact checkout; no build. Install only the Goose subdirectory, not the
repository root (its manifests serve other harnesses). For project scope:

```sh
mkdir -p .agents/plugins
ln -s /absolute/path/to/auto-context-handover/goose .agents/plugins/auto-context-handover
```

For user scope use `~/.agents/plugins/auto-context-handover` instead; with
`GOOSE_PATH_ROOT`, use its `.agents/plugins/` directory. Do not rename the
plugin directory or copy `goose/` alone: shared imports resolve through the
checkout. Goose discovers `plugin.json`, `.mcp.json` and `hooks/hooks.json`.
Do not install the whole repository using `goose plugin install`.

**Stop denials are opt-in, not passive nudges.** To enable measured notices,
set these in the environment that launches Goose (including its CLI binary on
PATH). The host-wide cap also affects other Stop hooks:

```sh
export AUTO_CONTEXT_HANDOVER_GOOSE_STOP=1
export AUTO_CONTEXT_HANDOVER_SOFT=200000
export GOOSE_STOP_HOOK_BLOCK_CAP=1
# Optional if goose is not on PATH:
export AUTO_CONTEXT_HANDOVER_GOOSE_BIN=/absolute/path/to/goose
```

- Root `user` sessions only. The writer binds the host's per-session MCP
  process identity and call metadata, then verifies a matching root via native
  JSON session export. Children/unknown attribution cannot write. Any equipped
  host-bound caller, including children, may read any retained id.
- `Stop` reads the last persisted provider usage, never cumulative billing.
  Fixed stages at soft, soft x 1.1 and soft x 1.2. Integer-only soft defaults to
  200000, uncapped (window unknown). Invalid configuration logs an error and
  disables notices, not storage/readback. Unknown usage/export failures allow
  stopping. Export is bounded to 15 seconds/16 MiB.
- A denial forces another model turn; it is hidden from the user but visible
  to the model. The host limits consecutive blocks (default 8; setup above
  chooses 1). No PreToolUse gate or per-request injection. SessionStart's
  banner is user-visible, **not** model-visible. Native compaction is unchanged
  and may happen first.
- The model calls
  `auto-context-handover_auto-context-handover__context_handover({handover, summary})`
  and ends its turn. Storage is immutable; no source lock, automatic successor
  or UI following. Manually open a **fresh equipped root**, not resume/duplicate
  history, and submit:

  ```text
  Call auto-context-handover_auto-context-handover__read_handover({"sessionID":"SOURCE_ID"}) and continue from "Prioritized next steps".
  ```

- Full text returns once with shared no-repeat/evidence framing; payload
  chars/4 above 50% of recorded soft warns only. No original-task capture,
  lineage or model-override preservation promise. Diagnostics reason remains
  unknown (current stage does not prove notice delivery).
- Private hashed-id records live under
  `$XDG_DATA_HOME/auto-context-handover-goose`, else
  `~/.local/share/auto-context-handover-goose`; override with absolute
  `AUTO_CONTEXT_HANDOVER_GOOSE_DATA`. New directories/files are 0700/0600.
  No quota/TTL/eviction/deletion cleanup; retention is manual. Atomic publication
  is not fsync durability or a same-user sandbox; crash-leftover temps may remain.

[Capabilities, citations and isolated non-model evidence](docs/research/goose.md).
Actual Stop dispatch, model compliance and fresh-root continuation remain
unverified; executable checks and fixtures do not establish them.

## Amp (focused-root adapter)

Targets latest `@ampcode/plugin` (assessed against `0.0.0-20261028101742-g93a0da1`);
offline load checked
with Amp CLI `0.0.1793203246-g5eab6d`. Amp runs TypeScript directly; no build
or runtime package import is needed. Keep this checkout intact (shared imports
are outside `amp/`). Create this real forwarding file in
`$XDG_CONFIG_HOME/amp/plugins/auto-context-handover/index.ts`, or
`~/.config/amp/plugins/auto-context-handover/index.ts` when XDG is unset:

```ts
export { default } from "/absolute/path/to/auto-context-handover/amp/index.ts";
```

Use the `plugins: reload` palette command after changing it; `amp plugins list`
lists registered plugins when connected. Do not copy only `amp/index.ts`.

- **Focused parentless threads only.** Host thread handles bind writes; known
  children, background threads and unknown focus/parentage cannot hand over.
  Deleted parents can appear parentless; this is not universal child detection.
- `agent.start` appends an introduction and any notice after user content;
  `tool.result` appends notices to supported string/text-block outputs without
  changing their status. No system-priority claim. Active inference-view text,
  thinking, tool inputs/results use chars/4, never compacted-away history.
  System prompt, tool schemas, deferred modules and image tokens are excluded:
  this can undercount and is not a mathematical lower bound or exact usage.
- `AUTO_CONTEXT_HANDOVER_SOFT` accepts positive integer tokens only, default
  `200000`, uncapped (window unknown). Set below the model's compaction budget
  before launching Amp. Invalid/empty values log and disable notices, not tools.
  Shared stages apply at soft, soft x 1.1 and soft x 1.2; unknowns fail open.
- The model calls `context_handover({handover, summary})` after a notice or
  explicit handover request, then ends its turn. First successful write wins;
  both strings remain verbatim. At a successful `agent.end`, while still focused
  and parentless, the source agent creates a fresh root with `show:true` and
  receives one full seed automatically. No model is selected/overridden;
  exact setting preservation and client UI following remain unverified.
- Storage: `~/.amp/auto-context-handover/<sha256(thread-id)>/`, following HOME
  rather than XDG. New directories/files 0700/0600; immutable handover/claim,
  separate best-effort continuation status. No quota/TTL/eviction/deletion
  cleanup or fsync guarantee; same-user files are not a sandbox.
- Reload, cancellation, focus changes or failures can require manual recovery:
  in an equipped fresh thread use
  `Call read_handover({"threadID":"SOURCE_ID"}) and continue from "Prioritized next steps".`
  Inspect recorded status/existing successors first: uncertain create/seed
  admission is never automatically retried. A claim prevents duplicate attempts.
  Any equipped caller can read any retained id. Oversized seeds warn only.
- No source lock, forced stop, hard gate or child workflow. Native compaction
  is unchanged and may precede a notice. Offline load and fixtures do not prove
  authenticated routing, model compliance or continuation.
  [Capabilities and evidence](docs/research/amp.md).

## Cline CLI/SDK (root adapter)

Targets latest official `cline` and `@cline/sdk` (assessed against `cline@3.0.74`
and `@cline/sdk@0.2.0`), not legacy `clite`.
Install this repository as a package, not just `cline/index.ts` (which imports
shared files). Node >=22.18; no build step. From this repository run `npm install`,
then:

```sh
npm install -g cline@latest
cline plugin install /absolute/path/to/auto-context-handover --cwd /absolute/path/to/project
```

This installs a copy: reinstall after code changes; start a new session to load
it. Omit `--cwd` for global installation. For an existing SDK application, add
the absolute `cline/index.ts` path to `config.pluginPaths` on `cline.start`,
keeping its existing model/runtime configuration. Direct `extensions` users
must call `createClineHandoverPlugin()` once per session, never reuse an instance.

- **Root-only, advisory/manual.** `beforeRun` introduces the workflow;
  `beforeModel` appends transient staged notices without rewriting the system
  prefix. The complete exposed request's serialized chars/4 is a heuristic,
  not provider usage. No window is exposed: `AUTO_CONTEXT_HANDOVER_SOFT` accepts
  positive integer tokens only, default `200000`, uncapped. Set it below the
  configured model's compaction budget before starting Cline. Invalid/empty
  explicit values log an error and disable notices, not tools.
- The session's model calls `context_handover({handover, summary})` after a
  notice or explicit handover request, not ordinary completion, then ends its
  turn. Both strings stay verbatim; first successful storage wins, no overwrite.
  Root host identity/snapshot is required; unsupported callers fail explicitly.
- **Continue manually:** create a fresh session with this plugin and prompt it:
  `Call read_handover({"sessionID":"SOURCE_ID"}) and continue from "Prioritized next steps".`
  Reader guidance preserves completed work and predecessor evidence; no pasted
  full seed is needed. Any equipped caller can read any retained id. Full text
  appears once with source identity and diagnostics; missing observations stay
  unknown. Handover-only seed >50% of recorded soft warns, never gates/rewrites.
- Storage: `~/.cline/auto-context-handover/<sha256(session-id)>/handover.json`,
  new directories/files 0700/0600. This path follows HOME, not host `--data-dir`
  or XDG overrides. No quota/TTL/eviction/session-deletion cleanup; retention is
  manual. Same-user files are not a sandbox; interrupted writes may leave temps,
  and atomic publication is not fsync durability.
- No automatic creation/UI switching, source lock, hard gate, stop interception,
  model/override preservation or child integration. Native compaction is
  unchanged and can run before measurement. Real model compliance/continuation
  remain unverified. [Capabilities and non-model evidence](docs/research/cline.md).

## Pi (root-session adapter)

Latest Pi package `@mariozechner/pi-coding-agent` (assessed against 0.73.1) loads `pi/index.ts` directly,
using the root `package.json` `pi.extensions` manifest. No build or OpenCode
process is needed. From this repository, run `npm install`, then:

```sh
pi install /absolute/path/to/auto-context-handover
pi --handover-soft 200000
```

For a single launch without package installation:

```sh
pi -e /absolute/path/to/auto-context-handover/pi/index.ts --handover-soft '70%'
```

- Root-oriented only: no integration with third-party Pi subagent extensions.
  Pi has no core subagent primitive. Tools register directly, with no loader.
- A `before_agent_start` introduction explains the installed workflow before
  each loop. Pi persists this custom message per user prompt; it is not a
  system-prefix rewrite or a system-priority guarantee. Every provider-request
  `context` hook appends a transient stage notice at the end when over soft.
- `--handover-soft` accepts positive integer tokens or percentage strings.
  Default `200000`; integers cap at 70% of the host context window, percentages
  are uncapped. Fixed stages: soft, soft x 1.1, soft x 1.2. Unknown tokens
  suppress notices; unknown windows permit integers but not percentages.
  Invalid values report a session-start error and disable advisories, rather
  than silently substituting a threshold. Measurement uses Pi's own estimator.
- The active model calls `context_handover({handover, summary})` after a notice
  or an explicit user request, not ordinary task completion. Both strings are
  stored verbatim as a session custom entry. `read_handover({})` returns the
  latest active-branch handover plus diagnostics and host source-session/model
  metadata; it cannot read arbitrary files or other sessions. Reload and native
  compaction do not delete these entries. Ephemeral sessions store only in memory.
- **Rollover needs a user command:** after storage, submit `/handover` with no
  arguments. It waits for idle, creates a fresh session with a source backlink,
  seeds the full handover once and automatically sends a next-step continuation
  prompt using the replacement context. The command does not ask for review.
  Without stored text it reports an error and makes no model call. Cancellation
  preserves the source; partial replacement failures require inspecting the
  current session and recovering from the source's stored handover.
- No automatic tool/event-driven rollover, lock, hard gate, original-task
  capture, child lineage or loop guard. No model selection is forced; Pi owns
  replacement model resolution. Native compaction stays enabled and unchanged.
  A seed estimate above 50% of soft warns only. Pi owns file retention; there
  is no adapter quota/eviction policy, and writes are not crash-atomic.
- Real Pi installation/load/registration is non-model-verified; 28 fake-API
  tests cover behavior. Model compliance and end-to-end rollover are unverified.

Pinned contracts, command-dispatch caveat, checklist and reproducible non-model
checks: [Pi assessment](docs/research/pi.md).

## Codex CLI (subagent-first adapter)

Targets latest `@openai/codex` (assessed against 0.165.0). Run `npm install` in this repository first;
Node >=22.18 is required. No build or OpenCode host is involved. Register the
existing repository marketplace and install the root plugin:

```sh
npx --yes @openai/codex@latest plugin marketplace add /absolute/path/to/auto-context-handover
npx --yes @openai/codex@latest plugin add auto-context-handover@auto-context-handover
npx --yes @openai/codex@latest mcp get auto_context_handover
```

Review and trust the installed hooks in Codex `/hooks` before expecting them to
run. Installation alone does not trust them. Code/definition changes can require
renewed hash review; do not bypass trust as an installation shortcut. Codex uses
an installed copy, not this working tree. Complete dependency installation before
trust review; if a distribution omitted `node_modules`, install dependencies in
that installed plugin copy as well.

- **Pinned-source caveat:** measurement depends on synchronous
  `PostModelRequest`, present in `rust-v0.165.0` but not in the public hook event
  list. It observes latest-response input + output (cache/reasoning are subsets),
  then appends shared staged notices at supported tool boundaries. It does not
  poll JSONL or claim a pre-request injection/gate. Unknown usage suppresses
  notices; compaction clears measurements without changing native compaction.
- Set `AUTO_CONTEXT_HANDOVER_SOFT` in the environment before launching Codex.
  It accepts positive integer tokens, default `200000`, with fixed stages at
  soft, soft x 1.1 and soft x 1.2. No percentage/cap: the child window is unknown.
  Invalid values error and make hook-bound tools unavailable, not silently default.
- Root SessionStart introduces the configured read-then-replace workflow;
  roots can read but cannot store handovers and are not measured/nudged/rotated.
  Thread-spawn children receive a start introduction. After a notice, finish
  the current step and call
  `mcp__auto_context_handover__context_handover({handover,summary})`, then end
  the turn with exactly its receipt as the final native message. The stored
  handover replaces that session's final report; plugin-storage writes remain
  permitted under read-only task instructions before handover.
- Parent readback:
  `mcp__auto_context_handover__read_handover({"childId":"CHILD_ID"})` returns
  compact diagnostics, host-observed provenance and next-step excerpt. Use
  `full:true` for the verbatim handover once; pending user decisions are unknown
  until full read. Pass the reader's short full-read prompt to the same-type
  successor, not the full handover. The parent retains its original task and
  requested model-override parameters; the adapter does not capture them or
  infer overrides from the effective model. No original-task capture or lineage.
- Calls are bound to host identity by a synchronous PreToolUse single-use
  capability, not a model-supplied caller id. Unbound calls fail if hooks are
  absent/untrusted/disabled. Any live bound caller may read any stored child id;
  closed callers cannot read or work. This is not an OS-user filesystem sandbox.
- Verbatim text/summary and closure persist together in private PLUGIN_DATA
  files. No quota, TTL or automatic eviction. Consumed capabilities are removed;
  abandoned pending requests and crash-leftover temporary files can remain.
  Deleting plugin data also deletes history and closure. Atomic publication is
  not an fsync/crash-durability guarantee.
- No root rollover, automatic successor spawn, hard token gate or classifier
  handback. Closure denial covers supported tool paths only; final text and one
  stop correction are advisory, not deterministic parent delivery. Installation,
  MCP registration and fixtures are verified without a model; hook execution,
  model compliance and end-to-end continuation remain unverified.

Primary-source capability table, requirements checklist and reproducible
isolated commands: [Codex assessment](docs/research/codex.md).

## Qwen Code (subagent-first adapter)

Targets latest **Qwen Code** (assessed against 0.26.3). Run `npm install` in this repository first;
Node >=22.18 is required. No build or OpenCode host is involved. Link the
bundled `qwen/` subdirectory as an extension (it imports shared files from
the intact checkout, so link the directory, not a copy):

```sh
npm install --global @qwen-code/qwen-code@latest
qwen extensions link /absolute/path/to/auto-context-handover/qwen
```

Restart Qwen Code afterwards. The manifest (`qwen/qwen-extension.json`)
registers the `auto_context_handover` MCP server (`node
--experimental-strip-types ${extensionPath}/server.ts`, so the model calls
`mcp__auto_context_handover__context_handover` /
`mcp__auto_context_handover__read_handover`); `qwen/hooks/hooks.json`
registers classic command hooks (`${CLAUDE_PLUGIN_ROOT}/hook.ts`), not Mods.
Workspace trust, hook/MCP settings and tool allowlists still apply.

- **Child-only measurement from the child's own transcript.** The hook
  input's `transcript_path` is always the root transcript
  (`<projectDir>/chats/<sessionId>.jsonl`); the child transcript is derived
  as `<projectDir>/subagents/<sessionId>/agent-<agentId>.jsonl` (only
  strict `[A-Za-z0-9_-]` ids; otherwise unknown). The latest assistant
  record matching `sessionId`+`agentId` and carrying `agentRunId`+`agentRound`
  supplies the estimate as `promptTokenCount + candidatesTokenCount` only:
  never billing totals, cache, or thoughts. Invalid latest usage resolves to
  unknown with no fallback to older records. The root transcript is never
  parsed as a child. Child keys are the opaque composite
  `sessionId:agentId`, used for storage and as the reader's `childId`.
- Set `AUTO_CONTEXT_HANDOVER_SOFT` in the environment before launching Qwen.
  Positive integer tokens only, default `200000`, uncapped (the child window
  is unknown); fixed stages at soft, soft x 1.1 and soft x 1.2. An invalid
  value disables staged notices but leaves reader/writer identity binding
  working; readback reports unknown soft/stage/estimate, not the default.
  Unknown usage suppresses notices. Pre/PostCompact checkpoints the child
  file length and measures only later records; native compaction is unchanged.
- Root SessionStart introduces the configured read-then-replace workflow;
  roots can read but cannot store and are not measured/nudged.
  Subagent-spawn children receive a start introduction. After a notice,
  finish the current step and call
  `mcp__auto_context_handover__context_handover({handover,summary})`, then
  end the turn with exactly its receipt as the final native message. The
  stored handover replaces that session's final report; plugin-storage writes
  remain permitted under read-only task instructions before handover.
- Parent readback:
  `mcp__auto_context_handover__read_handover({"childId":"SESSION:AGENT"})`
  returns compact diagnostics, host-observed provenance and next-step excerpt;
  use `full:true` for the verbatim handover once. Pass the reader's short
  successor prompt to a same-type successor, never the full handover. The
  parent retains its original task and requested model-override parameters;
  the adapter does not capture them or infer overrides. No original-task
  capture, lineage, model selection, automatic successor spawn or
  root rollover.
- Calls are bound to host identity by a synchronous PreToolUse single-use
  capability, not a model-supplied caller id. Both tools refuse unbound calls;
  roots cannot store. Any live bound caller may read any stored child id; closed callers
  cannot read or work. This is not an OS-user filesystem sandbox.
- Verbatim text/summary and closure persist together in immutable hashed-id
  files under `~/.qwen/auto-context-handover/`. No quota, TTL or automatic
  eviction. Consumed capabilities are removed; abandoned pending requests and
  crash-leftover temporary files can remain. Atomic publication is not an
  fsync/crash-durability guarantee.
- SubagentStop applies one bounded final-text correction only after a stored
  handover, never a measurement denial. No Stop telemetry. Installation, MCP
  registration and fixtures are verified without a model; hook execution,
  model compliance and end-to-end continuation remain unverified.

Source contracts, storage/measurement limitations and non-model evidence:
[Qwen assessment](docs/research/qwen-code.md).

## Claude Code (subagent-only adapter)

The same repository root ships a Claude Code mod (`hooks/`, loaded via
`hooks/hooks.json`; manifest `.claude-plugin/plugin.json`, marketplace
`.claude-plugin/marketplace.json`). Install the repository root as the
plugin/marketplace source; no OpenCode host is involved.

- Only subagent child loops are measured (latest per-request `turn.step`
  usage, never cumulative, never the root window) and nudged per batch with
  staged escalation at soft, soft*1.1, soft*1.2, reusing the OpenCode warn
  leads. A `classic.SubagentStart` introduction explains the installed plugin
  before the child's first prompt; later notices appear next to tool results
  after a batch. Each stage references the introduction and retains the exact
  `mcp__auto-context-handover__context_handover` tool, `ToolSearch select:`
   loader, current-step boundary, full handover/handback action and intact parent
  readback. The introduction carries schema/template and read-only
  plugin-storage guidance. It is skipped only for positively identified
  teammates; unknown ids or unavailable listings still receive it. Teammates
  remain excluded from nudges and refused by the handover tool.
- Roots receive a short context-only introduction through
  `classic.SessionStart` `additionalContext`, before the first prompt rather
  than inside a tool result ([placement contract](https://code.claude.com/docs/en/hooks#add-context-for-claude)).
  It establishes reading incomplete child handovers and continuing without
  confirmation as the user's configured default. A successor replaces its
  predecessor as the same logical subagent, not an additional subagent under
  subagent-count limits. Read the handover before replying or deciding; ask
  only about handover-listed user-owned decisions, never context size, except
  check in if progress stalls or remaining work grows across generations.
  There is no fixed generation cap: parent judgment stays in charge. If a
  child ends without a delivered report, read its handover before messaging
  or resuming it; an existing handover is incomplete work to continue in a
  successor. Never SendMessage to or resume a handed-over child. Pass the
  reader's short successor prompt verbatim; append parent redirection if
  needed, but do not paste the original task or full handover into the spawn.
  Startup/resume/clear/compact/fork context is supported; custom-agent roots
  qualify by absent `agent_id`. Roots are not measured, nudged, gated or
  rolled over and cannot hand over. Tools register session-wide; parent
  readback remains available. Native compaction is unchanged.
- `soft` (plugin userConfig, default `200000`): positive integer tokens
  only, unbounded (the child window is unknown). No percentages, caps, hard
  gates, loop guards, or per-child markers.
- The child calls `context_handover` once, then must call `SubagentHandback`
  and stop. The tool result addresses the child first and retains the short
  reply below; the adapter forwards that stored reply as the handback message
  through the native path without replacing its result or bypassing review.
  Host receipt and classifier outcomes are not independently observed.
  Plain text is a last resort
  only when the handback tool is absent: on the reported native path, unsent
  final text was not shown to the parent. The parent reads a compact view via
  `read_handover` with the `childId` from the short reply. The notice tells the
  child to load the handover tool first (the deferred description is initially
  invisible) and then call it with the full text. Child summaries must include
  `User decisions pending: none` or `User decisions pending: <list>`.
  Default readback contains diagnostics, plugin-recorded provenance,
  generation/chain, next-step count, seed size, pending user decisions, the
  "Prioritized next steps" excerpt and successor pointer. Missing pending
  decisions or unsupported next-step formats are labelled `unknown`, with a
  `full:true` reader hint rather than invented claims. Request
  `read_handover({"childId":"CHILD_ID","full":true})` for the observed
  original task and handover verbatim, once each, with reference-only/no-repeat/
  predecessor-trust framing and native final-report guidance. The final short
  successor prompt starts with a lineage marker and explicitly requests full
  text, including when the child reads before spawn metadata is saved:

  ```text
  [auto-context-handover:continue child:CHILD_ID] First call mcp__auto-context-handover__read_handover({"childId":"CHILD_ID","full":true}) to load the full handover and the original task, then continue from 'Prioritized next steps'.
  ```

  The marker is recognized only at the beginning of the observed spawn
  prompt, allowing leading whitespace. Quoted/mid-text examples are not
  scanned. Malformed reserved prefixes and missing predecessor handovers
  produce unknown lineage, never a silently reset original task. This marker
  is unrelated to the OpenCode per-child soft-limit test marker.
- The successor loads the payload through `read_handover`, not a large
  `SubagentStart` injection. Recorded successor callers also receive full text
  without the flag when their merged spawn/handover metadata identifies this
  target as the immediate predecessor. That link comes from the leading marker
  observed by `agent.spawn`; the pointer's explicit `full:true` handles the
  pre-persistence race. Existing open-reader access permits any live caller
  with tool access to read any stored handover by id, not only a parent or
  successor; there is no caller authorization or new read grant.
  Locked callers still cannot read or work. The short prompt itself contains
  the reader instruction, even if the generic start introduction is absent.
  Tool-output limits/placement remain host integration risks; this route
  avoids parent retranscription and does not claim system-prompt priority.
- Capture the original from the documented
  [`AgentSpawnInput.prompt`](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts),
  not parent memory or inferred task text. Store it once under the origin
  child id; successors retain only that reference and their immediate
  predecessor id. Generation starts at 1 and increments from a stored
  predecessor's metadata. Readback shows generation, predecessor and origin
  ids, plus a top-level next-step item count when the title/list format is
  derivable, otherwise `unknown`. These are progress cues, not a proof of
  productivity. Post-spawn metadata remains recoverable if the child already
  handed over before the spawn result returned; no stored handover is rewritten.
- The shared `seedTooLarge` check warns when the successor-facing payload
  estimate (`ceil(chars/4)`, including framing but not reader headers) exceeds
  50% of the current Claude soft limit. Ask the child to compress carried-over
  finished notes at its next handover, never rewrite stored text. This is
  advisory and excludes host/system/tool overhead; it does not gate work.
- Replies/readback record the agent type and requested model override from
  [`agent.spawn`](https://code.claude.com/docs/en/plugins/mods/reference#subagents),
  with `SubagentStart` type fallback, and prescribe the same type/override
  for the successor. Observed absence is `no override`; unavailable or legacy
  provenance is `unknown, use predecessor spawn params`. Variant/effort records
  the existing `turn.step` request's effort, or `unknown` when unavailable;
  reuse original spawn parameters including effort. Never infer an
  override from usage or the effective/root model. Metadata persists across
  reload in private storage; storage failures can lose provenance. It records
  parameters as this observer saw them, not downstream mod rewrites. The root
  introduction makes this plugin record authoritative over conflicting
  handover prose; the shared template tells children not to restate their own
  agent/model/chain provenance.
- Resumed locked children return an explicit refusal and continuation hint,
  including through native handback. Same-turn initial delivery retains the
  short summary; missing or legacy turn identity selects the locked reply.
  A closed child without an observed successful handback in the current turn
  receives at most one stop correction to call `SubagentHandback`, even when
  its final text matches the short/locked reply. Existing stop blocks and
  active stop hooks are respected; errors fail open. Official
  [tool documentation](https://code.claude.com/docs/en/tools-reference)
  establishes native delivery/classification, not a universal plain-final-drop
  guarantee; the bounded correction conservatively addresses the live report.
- Full text persists in plugin storage ([4 MiB JSON total, shared across
  sessions](https://code.claude.com/docs/en/plugins/mods/reference#limits)).
  Before payload/provenance writes, estimate the whole serialized store with
  the proposed replacement. Above 3 MiB, evict oldest eligible whole chains by
  last activity until it fits. No TTL or configuration; the remaining 1 MiB
  is estimate headroom, not reserved capacity. Reads and continuations refresh
  activity. Legacy/untimestamped records sort oldest; spawn-only orphan
  metadata participates in the same activity ordering. Legacy groups and
  groups with no timestamp form the oldest tier; within each tier, activity
  sorts ascending with chain-id ties. Protect the current chain,
  active/in-flight chains and uncertain
  membership rather than guessing lineage. The legacy/orphan exception means
  no lineage claims at all; malformed/conflicting claims, unresolved references
  and unreadable membership remain protected, including identifiable related
  chains. Unknown keys count toward size but are not reclaimed.
  Expired bodies/originals are
  permanently unavailable; compact closure tombstones keep handed-over
  children locked and reads explicitly report `expired`.
  Insufficient safe space and failed/partial eviction remain explicit and
  retryable; failed handover storage never claims success or locks the child.
  Tombstones consume space too. Concurrent sessions can over-evict; store
  accounting and reclamation are not atomic. Eviction scans run on writes,
  not reads. The estimate sums UTF-8 bytes of JSON-escaped keys and serialized
  values, including object braces, colons and commas, after replacing the
  pending key's old value. It counts all enumerated key families, not just
  handovers; host-internal representation can differ. Incomplete scans refuse
  the pending persistence rather than treating unreadable entries as zero.
  New child records store the model's summary once and derive the short reply;
  historical records with persisted short replies remain readable.
  Active protection combines local in-flight reservations, nonterminal
  listings and persisted child pins. Only documented `completed`, `failed`
  and `killed` statuses release listing protection; unknown statuses retain it.
  A matching `turn.complete` retires the pin; `session.end` best-effort removes
  only that session's pins, never payloads. Crashes or failed cleanup can leave
  stale pins indefinitely, reducing safely reclaimable space.
  Original-task write failures preserve a bounded
  error in spawn metadata when possible and report the cause in full readback;
  if all writes fail, reload can lose that cause and readback reports unknown.
  Handover storage failures are explicit errors, not successful handovers.
  Native output
  limits are unverified integration risks, as are tool availability under
  real allowlists, child feedback routing, classifier review of short returns, resumptions, and
  installed-package loading. Delivery guidance is advisory shaping, not a
  deterministic replacement.
- Per-child usage, baseline, growth, spawn-observation and nudge caches retire
  on closed-child stop or matching turn completion. Handback/correction latches
  survive a blocked stop and retire only at actual turn completion or session
  end. A genuinely new open turn re-enables measurement and re-pins before its
  first request; a lost baseline remains `unknown`, not a fabricated restart.
  Auxiliary retired/provenance/error/seen-turn histories are capped at 1000
  child ids, with at most 10 remembered turn ids per child. Session end clears
  transient measurement and correction state; durable locks remain.
- `hooks/claude-types.ts` is a narrow structural subset of the mod
  contracts, not full API verification, and carries no live version claim.

Adapter developers: [docs/adapters.md](docs/adapters.md) lists the harness-independent
requirements checklist with per-adapter status and evidence. Antigravity CLI
feasibility is assessed docs-only (blocked, no implementation) in
[docs/research/antigravity-cli.md](docs/research/antigravity-cli.md).
AWS Kiro CLI **2.35.1** is also [assessed, not shipped](docs/research/kiro-cli.md):
hook-readable active-context measurement and MCP caller binding remain
unestablished. No Kiro adapter installation is available.

## OpenHands SDK adapter

Targets **`openhands-sdk>=1,<2`** (assessed against `1.21.0`), tested with Python3.12. This is a small
Python composition helper for a local SDK application, **not** a drop-in plugin
for `openhands` CLI 1.x (assessed against 1.16.0), its TUI/ACP or a remote agent server. No build or
replacement driver loop. [Capabilities and CLI blockers](docs/research/openhands.md).

```sh
python -m pip install -r openhands/requirements.txt
export PYTHONPATH="$PWD/openhands${PYTHONPATH:+:$PYTHONPATH}"
```

In your SDK application, equip a fresh uninitialized `agent` configured normally
with its own LLM/metrics object; keep the adapter object alive for that conversation:

```python
from openhands.sdk import Conversation
from openhands.sdk.hooks import HookConfig
from handover_adapter import HandoverAdapter

adapter = HandoverAdapter()
conversation = Conversation(
    agent=adapter.equip(agent),
    workspace=workspace,
    callbacks=[*existing_callbacks, adapter.on_event],
    hook_config=HookConfig.merge([existing_hooks, adapter.hook_config]),
)
adapter.bind(conversation)
```

`existing_callbacks` and `existing_hooks` are your application's existing list
and HookConfig (use `[]` and `HookConfig()` if absent). Bind once before any
send/run; use normal SDK send/run calls afterwards. Keep `handover_adapter.py`
at its import location: the hook invokes that file with the current interpreter.

- Latest main-agent response prompt + completion drives shared stages, **only on
  the next submitted user prompt**. New prompt/tool-result growth is omitted;
  no notice inside autonomous runs. Condensation invalidates old usage until a
  new ordinary response; native condenser stays enabled/unchanged and can run first.
- `AUTO_CONTEXT_HANDOVER_SOFT` or `HandoverAdapter(soft=...)`: default 200000,
  positive integer tokens capped at70% of a known response context_window;
  explicit percentages uncapped. Unknown window disables percentages; unknown
  usage is silent. Invalid/empty explicit values log and disable notices, not tools.
- Direct `context_handover({handover,summary})` stores model-authored strings
  verbatim; `read_handover({sessionID})` returns full text once and continuation
  framing. Both require their exact SDK-bound caller; any equipped caller may
  read any retained source id. No automatic root/child classification or delegation.
- Manual continuation: create a **fresh**, independently equipped local
  Agent/Conversation (new id, not resume/fork) and submit the source reader
  reference. No automatic rollover/UI following, source lock, Stop interception,
  token gate or model/settings-preservation promise.
- HOME-based `~/.openhands/auto-context-handover/<sha256(session-id)>/` uses
  private new directories/files and immutable first-writer handover publication.
  No quota/TTL/eviction/deletion cleanup/fsync guarantee; snapshot/temp files may
  remain. Same-user filesystem access is not a sandbox. Reloaded diagnostics
  begin unknown; emitted-nudge provenance survives later measurements/condensation,
  but does not prove model receipt. Failed snapshot writes log, keep fresh memory
  diagnostics and attempt stale-file removal; failed removal can leave stale notices.
- `PYTHONPATH=openhands python openhands/test_handover_adapter.py` checks the
  installed SDK without model execution. Node tests guard shared Python text drift.
  Real model compliance and continuation remain unverified.

### GitHub Copilot CLI (subagent-first adapter)

Targets latest **`@github/copilot` experimental CLI extensions** (assessed against 1.0.105) and Node >=22.18.
Install the standalone Copilot directory, not the repository root (which exposes
the Codex MCP server):

```sh
copilot plugin install ./copilot
copilot plugin list --json
copilot --experimental
```

From GitHub, use `copilot plugin install beefsack/auto-context-handover:copilot`.
Direct installs currently warn of future marketplace-only support. Use
`/extensions manage` to inspect extension startup; restart or `/clear` after
updates. No build or runtime SDK installation: Copilot supplies its SDK.

- Child-only measurement uses the latest attributed whole-window count
  (including system messages and tool definitions), never billing totals.
  `AUTO_CONTEXT_HANDOVER_SOFT` defaults to `200000`, capped at
  70% of a known window; explicit percentages such as `70%` use that fraction.
  Unknown/invalid usage stays silent. Staged notices appear after successful tools.
- Both tools set `defer: "never"` to keep their descriptions available.
  `context_handover` stores model-authored text verbatim and closes the child;
  `read_handover({"childId":"..."})` returns full text and diagnostics. Native
  subagent-stop rewriting supplies the short parent receipt without another
  model turn. Parent guidance says read first, then replace with a same-type,
  same-requested-override successor using the original spawn parameters and a
  reader reference, never pasted handover text.
- Readback warns when the stored handover's `ceil(chars/4)` estimate exceeds
  50% of its recorded soft limit; unknown soft skips the warning. This excludes
  reader headers/host overhead and only advises compressing finished notes at
  the next handover; stored text stays verbatim.
- Persistent files use a dedicated directory under `COPILOT_HOME` (otherwise
  `~/.copilot`); `AUTO_CONTEXT_HANDOVER_DATA` overrides it. Use a trusted dedicated
  directory; directory/file modes are 0700/0600, not a same-user sandbox.
  No quota/TTL/eviction;
  transient usage is unknown after reload. Root reads are allowed, but roots
  are not nudged, handed over or rotated. Native compaction is unchanged.
  Ordinary hook closure reads fail open on storage errors, so corrupt/unreadable
  records can bypass hook denial; both direct adapter tools fail explicitly.
- Experimental attribution must identify the child; absent attribution refuses
  handover. Built-in general-purpose lacks start/stop lifecycle support. No
  original-task capture, lineage or compact parent reader. Tool/extension
  permissions and disabled hooks can prevent the workflow. Installation is
  observed and policy fixture-tested; actual callbacks, model compliance,
  never-resume enforcement across all paths and parent receipt are unverified.

[Capabilities and non-model checks](docs/research/copilot-cli.md).

## Crush (root-session adapter)

Targets latest **Crush** (assessed against v0.98.2). Run `npm install` here first; Node >=22.18,
no build. This is an explicit opt-in local-server integration, not a plugin
bundle: it can create a root and submit one continuation prompt on your behalf.
The server version guard accepts stable major-0 releases, not nightlies.
Use an absolute private Unix socket path for the server you intend to control;
the adapter never discovers a socket or opens TCP connections.

Set these variables before starting both the server and client:

```sh
export AUTO_CONTEXT_HANDOVER_ROOT="/absolute/path/to/auto-context-handover"
export AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET="/absolute/private/run/crush.sock"
export AUTO_CONTEXT_HANDOVER_DATA="/absolute/private/auto-context-handover-data"
export AUTO_CONTEXT_HANDOVER_SOFT=200000
```

Create the socket's parent directory privately before starting the server.
Use a dedicated adapter data directory, not a project or harness config directory.

Add to the project's `crushrc` (paths with spaces are supported):

```sh
option context-path "$AUTO_CONTEXT_HANDOVER_ROOT/crush/CONTEXT.md"
hook add PreToolUse --name auto-context-handover --timeout 30 \
  --command 'node "$AUTO_CONTEXT_HANDOVER_ROOT/crush/hook.ts"'
mcp add auto_context_handover --type stdio --command node \
  --args "$AUTO_CONTEXT_HANDOVER_ROOT/crush/server.ts" --timeout 60
```

Start a private server, then connect from a second terminal in the project with
the same environment (Crush owns normal model/provider setup):

```sh
crush server --host "unix://$AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET"
# In the second terminal:
crush --host "unix://$AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET"
```

- Root tools: `mcp_auto_context_handover_context_handover({handover,summary})`
  and `mcp_auto_context_handover_read_handover({"sessionID":"SOURCE_ID"})`.
  Static context introduces the workflow; stable staged PreToolUse notices
  reference it. Native children bypass hooks and are unsupported.
- Measurement reads last-saved prompt + completion counters and workspace model
  window through the server, not session totals. Counters normally lag one
  response at tool boundaries and may retain older nonzero values. Estimated
  versus provider-measured usage provenance is unavailable through this API.
  No per-request injection or trailing-result estimate is claimed.
- Soft accepts positive integer tokens (default `200000`, capped at 70% of a
  known window) or explicit percentages (uncapped). Unknown usage suppresses
  notices; unknown windows leave integers uncapped and percentages unresolved.
  Invalid configuration errors instead of silently selecting a default.
- The active model supplies verbatim text. Storage and source closure precede
  root creation; successor id is persisted before one seed submission. The
  successor runs in the same workspace in the background. **The TUI stays on
  the source.** No model/variant preservation guarantee, child integration,
  hard token gate, original-task capture, loop guard or compaction changes.
- Any live hook-bound root can read any retained handover by id, including full
  diagnostics and recovery state; closed roots cannot use tools. Binding uses
  immutable original arguments and a single-use capability, not model-supplied
  identity. Same-user socket/filesystem trust is not a sandbox.
- Diagnostics preserve known estimate/stage/soft; reason remains `unknown`
  because notice provenance is not persisted between hook processes. Unknown
  soft disables notices/seed warnings, not explicit handover or readback.
- Private files use 0700 directories/0600 files; no quota, TTL or automatic
  eviction. Abandoned capabilities/temp files may remain. Deleting adapter data
  deletes history and closure. Publication is not an fsync durability guarantee.
  Ordinary-tool lock checks fail open on storage errors; MCP mutations are strict.
- Failed/uncertain creation or admission leaves the source closed with retained
  text. Inspect the successor/server before manual recovery; never blindly
  resubmit after a timeout. A crash between creation and link persistence can
  orphan an unrecorded successor. Admission is not proof of a successful model run.
  A seed estimate above 50% of soft warns only and never rewrites stored text.
- Release server reads/root creation, configuration loading and standalone MCP
  stdio listing are non-model checked. Fixtures are not real hook firing, model compliance,
  successful continuation or TUI navigation evidence; those remain unverified.

Pinned release/nightly capability table and reproducible non-model checks:
[Crush assessment](docs/research/crush.md).

## AiderDesk (root Agent-task adapter)

**Advisory/storage only; continuation is manual.** Automatic rollover is
disabled because fresh-task initialization is not established through the
pinned public extension API. No end-to-end model run has been verified.

Targets latest AiderDesk (assessed against `0.90.0-dev`, source `831d10d`), with shipped extension types
`@aiderdesk/extensions@latest` (assessed against 0.39.0). No build or OpenCode host. Run `npm install`
in this repository, keep it in place, and create a **real** project extension
directory with this `index.ts` (replace the absolute path):

```text
<project>/.aider-desk/extensions/aiderdesk/index.ts
```

```ts
export { default } from "/absolute/path/to/auto-context-handover/aiderdesk/index.ts";
```

The same real `aiderdesk/` folder can go under `~/.aider-desk/extensions/`
for global installation; use one scope, not both. Do not symlink the folder:
the pinned host skips directory symlinks. Do not copy `aiderdesk/` alone:
its shared imports require the repository. Restart AiderDesk after repository
updates; its extension watcher need not observe files outside the entry folder.

- Root **Agent mode only**; native subagents, compaction modes and Aider modes
  are excluded. Model-visible tools are `context-handover({handover,summary})`
  and `read-handover({taskId?})`; approval identifiers are
  `aiderdesk---context-handover` and `aiderdesk---read-handover`.
  Normal host approval/disabled-tool policies still apply.
- A per-run context introduction explains the installed workflow. Transient
  per-step notices use the host's whole-prompt token estimator, not billing
  totals or exact provider usage. It estimates system text, tool definitions
  and saved task messages; later extension changes may not be counted.
- `AUTO_CONTEXT_HANDOVER_SOFT`, set before launching AiderDesk, accepts positive
  integer tokens or explicit percentages. Default `200000`; integers cap at
  70% of a known model input window, percentages are uncapped. Fixed shared
  stages: soft, soft x 1.1, soft x 1.2. Zero/error estimates suppress notices;
  unknown windows leave integers uncapped and percentages unresolved. Invalid
  or empty explicit configuration logs an error and disables notices.
- The active model writes the full handover through the tool, then ends its
  turn. Create/open a fresh Agent-mode task through the normal AiderDesk UI in
  the same project, then use the reader-reference prompt returned by the tool:
  call `read-handover` with the source `taskId` and continue from
  "Prioritized next steps". Keep the source task loaded and its working
  directory available. The adapter never creates or prompts another task,
  selects a model, transfers context files or records successor lineage.
- Private `~/.aiderdesk/auto-context-handover/<sha256(projectId + '\0' + taskId)>/handover.json`
  retains immutable verbatim handover/summary, first writer wins. The
  project-scoped hash keeps identical task ids in different projects
  isolated; nothing is written inside the project working directory. New
  directories/files use 0700/0600, not a same-user sandbox. No quota, TTL,
  automatic eviction or task-deletion cleanup; retained files need manual
  removal. Files survive worktree moves/removals, but changed project identity
  prevents normal readback. Atomic publication is
  not fsync durability; interrupted writes may leave temporary files.
- Readback includes recorded diagnostics and full text once. Any root with
  these tools can read any loaded task in the current project through host
  lookup, never arbitrary paths; no parent-only authorization is claimed.
  Reload loses transient measurements, not stored text.
- No source lock, hard gate, child workflow or loop guard. Source reuse is not
  prevented. Native handoff/compaction remain unchanged and can still run;
  native handoff's separate generation call is not used to author this handover.
  No seed-size warning or automated continuation. Host-loader registration and
  29 fake-API tests are non-model-verified; manual continuation, approvals and
  model compliance remain unverified.

[Pinned capabilities and reproducible non-model checks](docs/research/aiderdesk.md).

## Storage

OpenCode fallback B: everything lives in session-keyed KV, never in external files.
The host persists complete tool-call inputs (`packages/schema/src/session-message.ts:148-154`,
`packages/core/src/session/sql.ts:84-96` at pinned `19d87a7`), but server
plugins expose no full-history API and `ctx.session.context` is filtered
(`packages/core/src/session/history.ts:149-179`), so the full text cannot be recovered from the
transcript later. The handover body is therefore stored under
`auto-context-handover:handover:<sessionID>` (lock, loop state,
child soft override and forward/back links beside it) and removed with the session on `session.deleted`.
OpenCode's `read_handover` is a direct (`codemode: false`) tool returning the full
text with `metadata: { truncated: false }`, which bypasses the host's
tool-output truncation instead of spilling to a file. It returns only the
handover, not the old transcript. A full read can consume large context;
the soft-limit estimator sees the result after its anchor, which is
expected behavior, not a safety feature.
Any live caller with tool access can read any stored handover by session id;
the reader checks target existence and storage, not caller authorization.
Locked callers have no tools. Claude has the same open-reader policy but uses
`childId` and compact-by-default readback as described above.

Both adapters store call-time handover diagnostics and show one reader header:

```text
Diagnostics: reason=nudged, stage=warn1, estimated-context-tokens=1050, soft-limit=1000
```

The reason is `nudged` or `not-nudged`, never inferred user intent. OpenCode
uses its pre-call request estimate (including trailing chars/4) and stage;
Claude derives stage from the child's latest per-request usage against soft
(the same boundaries as notices); reason reflects observed batch-nudge
appending independently, not proof the child read it. Claude readback also shows recorded successor
agent/model-override provenance and appends `handback-delivered=yes|no|unknown`
to the diagnostics line. New records start at `no`; a successful native
handback result (no denial/error) persists `yes`, including a locked reply
delivered after resume. This records observed tool success, not independent
parent receipt or classifier internals. Legacy status is `unknown`; a failed
status write can leave stale `no` even after delivery. The current-turn stop
check is in memory, so a reload can cause one extra correction. Unavailable
fields, including lost transient
  state and older records, read as `unknown`. Diagnostics do not persist nudges
  or change request text, thresholds, gating or rollover.

Claude also records the first measured request's context total after a newly
observed child launch, and the latest consecutive request-to-request change
at handover in a separate line:

```text
Baseline: start-context-tokens=42000, last-batch-increase=6500.
```

These use the same per-request input/cache/output sum as context measurement,
not the task notification's cumulative tokens. A negative change is possible
after compaction. A start baseline requires a launch observed in the current
registration without previous child/spawn metadata (or a spawn observed here);
unobserved starts, metadata-read failures and reloads of existing children
report `unknown`, not the first later measurement as a fabricated start.
The last-batch delta needs two consecutive usable measurements, which may both
be after reload. Legacy/unavailable fields are `unknown`. They are
diagnostics only, not a new nudge point or overshoot control.

## Manual test plan

Root-session checks run against an isolated project directory (never the live
config): create `/tmp/opencode/ch-manual`, put an `opencode.jsonc` with the
`$schema` property and this package in `plugins`, and start `opencode` there.
Use `{ "soft": 2000 }` (or similar) so one short exchange crosses the
threshold; the model does the calling, you verify the outcomes.

Ask the user to choose the model explicitly for each live run, and pass it
as a required per-run argument or environment variable with no default.
Never hardcode or pick a model in test files, scripts, or configs. If the
chosen model is rejected, stop rather than substitute another model.
Scripts must reject both unset and empty model arguments/environment variables
before invoking OpenCode; an empty `--model` can otherwise select a default.
Give sessions explicit titles so automatic title generation cannot select
a different model for an auxiliary request.
Check a context observer's `event.model` against the requested model before
accepting evidence. Use a private server (`--standalone`) and an explicit
agent with access to the plugin tools so inherited settings do not obscure
the check.

For headless checks, require the chosen model in the invoking environment:

```sh
: "${LIVE_TEST_MODEL:?Set the model explicitly chosen for this run}"
opencode run --standalone --agent build --model "$LIVE_TEST_MODEL" --title "Handover check" --format json "What is 1234 + 5678? Reply exactly SUM-6912. Do not call any tools."
: "${SESSION_ID:?Set sessionID from the run's JSON events}"
opencode session export "$SESSION_ID" > session.json
```

Run these commands from the isolated project. Obtain `SESSION_ID` from the
run's JSON events; exported tool entries use `.name`, not `.tool`.
First verify ordinary completion without asking for a handover: no usage
anchor exists on the first request, so it should not nudge or hand over.
Then continue that session to cross the threshold. A context-hook observer
loaded after this plugin can independently record remaining tool names and
injected directives; a model's description of its tools alone is not proof.

1. New-session rotation (local directory config).
   Do: with `soft` low, ask the agent to complete a small unit and then call
   `context_handover` with full text plus summary. Nudges are model-facing,
   not UI notifications.
   Expect: tool result names the successor ID; the source session refuses
   further work (tools stripped, locked notice); the successor opens with
   the handover seed plus backlink and `read_handover` hint; `read_handover`
   for the source from any live session shows the verbatim text with
   `continued in <successor>`.

   TUI follow check: keep the source visible during rollover. Expect the TUI
   to switch to the successor without any prompt. Repeat, but navigate to
   another session before the source completes its handover; expect to stay
   there. Lock mode and child return must not switch sessions. Companion setup
   was verified in an isolated OpenCode 2.1.4 TUI without a model call; actual
   rollover navigation still needs this interactive check.

2. Lock mode.
   Do: set `onHandover: { "primary": "lock" }`, cross soft, call
   `context_handover`.
   Expect: no successor is created; the result names the stored session ID
   and points at `read_handover`; the session locks and keeps no tools.
   Later work requests should refuse and direct the user to read that
   stored text from another session.

3. Child return and parent read.
   Do: from the live parent session, launch an ordinary `worker` with a spawn
   prompt starting with `[auto-context-handover-test soft=4096]`, adjusting soft
   for fixed prompt overhead. Use its configured model, without a model
   override or live configuration edits. Run typecheck first: the live host
   loads this working tree directly. Keep this to one or two spawns and require
   at least two model turns before completion, such as successive tool calls.
   The child must wait for the nudge, finish its bounded unit, and call
   `context_handover` with a short summary. Workers cannot spawn other agents.
   Expect: the child returns only the short summary plus its session ID and
   a `read_handover` hint (never the full text); the child locks; the parent
   reads the full text via `read_handover` with the child session ID.
   A live marker check confirmed stripping, the model-observed nudge, one
   handover call, the short child return and full parent readback. Reload,
   compaction, deletion, rejection and non-inheritance cases have unit coverage.

4. Hard gate.
   Do: set `hard` just above `soft`, push usage past it, and ask the agent
   which tools remain before it hands over.
   Expect: every tool except `context_handover` is removed for that request
   and a firm hard-limit directive is shown; calling `context_handover`
   still succeeds.

5. Loop guard: root plus three short successions, then productive reset.
   Do: with `soft` 100000, do a short exchange and then `context_handover`
   to rotate root -> s1 -> s2 -> s3, each successor adding only a sentence
   or two beyond its seed; then in a fresh chain, do enough work to add
   >=25% of soft beyond the seed, followed by short handovers. The short
   exchange before each handover matters: without a measured pre-call
   snapshot the guard skips counting rather than guessing.
   Expect: s3 locks with "loop guard" and no new root; all tools are
   removed on later requests. Read its stored handover from another session.
   The productive chain resets the streak, then locks on the third short one.
   Counts are approximate, so do not expect exact manual outcomes.
   Keep transcripts short even with a larger soft threshold: fixed
   system/tool overhead counts as added tokens, so tiny thresholds can
   classify a sentence-only successor as productive. Explicitly request
   handovers below soft rather than filling the window just to get nudged.
   Separately, with `soft` 1000, a handover body over 2000 characters
   ensures the full seed exceeds 50% of soft; expect a warning, not a block.

6. Forward/back links and read after compaction.
   Do: complete one rotation, then keep working in the successor until
   compaction runs, then call `read_handover` for the source session.
   Expect: the source header shows `continued in <successor>` and the
   verbatim text survives compaction. Both directions resolve only once
   the successor has stored its own handover; before that, the reverse
   link lives in the successor's seed prompt, and `read_handover` for the
   successor reports no handover stored.

7. Deletion cleanup.
   Do: remove a handed-over session (`session.remove`), then call
   `read_handover` for it.
   Expect: the read reports the session does not exist. KV cleanup
   (handover, lock, loop state, both links) is covered in the
   harness, not inspectable via the read tool. This includes child soft overrides.

### Claude parent continuation retest

- Reload the plugin and start a fresh root session. Choose the child model
  explicitly and configure a low enough integer soft limit outside its task
  prompt. Ask for one sequential read-only subagent audit with no handover
  hints and enough work to require continuation.
- Check that the root introduction precedes its first prompt, the child
  introduction/notices arrive, and the child stores a six-section handover
  with pending user decisions in its summary. The parent must read it before
  replying or deciding, then continue in a replacement with the same agent
  type and model override without asking about context or subagent count.
  Require at least two rollovers. Check every child calls `SubagentHandback`
  after storage and every readback reports delivery status. Each parent spawn
  must contain only the reader-provided short prompt, plus optional redirection;
  its successor must read the predecessor before task work. Verify the original
  prompt and handover arrive verbatim, once each, without a memory-filled slot.
  The parent's default read must omit the full original/handover and include
  pending decisions, next steps and pointer; an explicit `full:true` read must
  recover both full texts. A successor's pointer-directed read must always be
  full, including before spawn metadata persistence.
- Follow at least three generations: confirm generation increments, immediate
  predecessor/origin ids, inherited original prompt, title-based continuation
  when next steps are section 7, and no repeated completed work. Targeted
  re-reads may resolve carried open questions. Verify the
  parent notices stalled progress/growing remaining work without a fixed cap.
  Exercise a payload over 50% of soft and check compression advice; in fixtures
  verify malformed/missing pointers, spawn timing, reload and quota failures.
- Exercise a child ending without handback in an isolated fixture: the stop
  correction must request native handback once, not plain text. If no report
  arrives, the parent must read the child id first and continue any stored
  handover in a successor, never SendMessage to or resume the closed child.
  Check the absent-handback-tool fallback stops after the bounded correction.
- Inspect provenance and diagnostics against the spawn and latest usage;
  check first-measured context and last-batch delta independently of the
  task notification's token total, including honest unavailable values;
  confirm root measurement/nudging and native compaction are unchanged.
  Parent compliance and installed-host delivery still need live verification.

## Limitations

- EXPERIMENTAL loop guard is approximate and in-memory parts (request
  identity, pre-call usage, duplicate guard, pending-successor map) reset on
  restart/reload; KV streaks survive. Missing measured pre-call snapshots
  skip counting (including immediate successor handovers). System/tool
  overhead and chars/4 bias productivity, especially at tiny thresholds.
- Non-text media is not char-counted.
- A process crash between successor creation and durable link writes can
  orphan the successor; the same-process pending map covers retries, but a
  retry after a crash may mint a second root. This is a known atomicity gap,
  not a transaction.
- The source lock persists: after an uncertain prompt admission the source
  stays locked and refuses handover retries, so recovery is manual (the user
  opens the successor and pastes via `read_handover`).
- TUI following uses live successful-rollover events only. Missed events
  (for example, while disconnected or before companion activation), failed
  successor lookups, and uncertain prompt admission do not redirect. Opening
  an old session later does not redirect either; use its forward link manually.
- Desktop and web do not auto-follow; there is no interactive review UI.
- No reset or interactive review action: unsupported values are explicit setup
  errors. Storage failures in the context hook still fail open for locks and
  measurement.
- Compaction can drop the visible estimate; the hook keeps a high-water mark
  so pre-compaction progress still counts at handover.
- Isolated OpenCode 2.1.4 live checks confirm lock mode, hard tool removal
  with a callable handover, linked rollover, default-variant preservation,
  the seed-size warning, and locking on the third unproductive successor.
  The restored loop-guard lock fallback has unit coverage but has not had a
  new isolated live run after removal of interactive review. Deletion cleanup
  is unit-tested, not live-tested. Nondefault variants, productive loop-streak
  reset, and readback after compaction were not exercised in these live runs.
