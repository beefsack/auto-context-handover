# Antigravity CLI feasibility assessment (Phase 1, documentation-only)

Status: **prerequisite-blocked, no implementation**. No adapter source exists;
no measurement proxy (step counts are not context) and no speculative
implementation are used. Lack of evidence is not proof the host is impossible.

Scope: Google Antigravity CLI (`agy`) as the successor surface to the
historical Gemini CLI target. Gemini CLI rows elsewhere in this repo are
historical and superseded here, not regraded as Antigravity. No model calls
were made; all findings are docs plus unauthenticated CLI probes.

References (fetched 2026-10-28):

- [H] Hooks contract: https://antigravity.google/docs/hooks
- [S] Subagents: https://antigravity.google/docs/subagents?tab=cli
- [SL] Status line: https://antigravity.google/docs/cli/statusline and
  https://antigravity.google/docs/cli/commands/statusline/
- [P] Plugins: https://antigravity.google/docs/plugins/
- [PS] Plugin schema: https://antigravity.google/schemas/v1/plugin.json
- [CR] CLI reference: https://antigravity.google/docs/cli/reference
- [CF] CLI features: https://antigravity.google/docs/features?tab=cli
- [CX] Context command (interactive): https://antigravity.google/docs/cli/commands/context/
- [CU] Usage command (credits): https://antigravity.google/docs/cli/commands/usage/
- [HD] Headless: https://antigravity.google/docs/cli/headless
- [IN] Installer: https://antigravity.google/cli/install.sh (official binary source;
  `npm @google/antigravity-cli` 404s and is not official evidence;
  `agy.dev` marketing is not schema evidence; binary-internal symbols are not
  public APIs)

## What is Documented

- Hook events are per-model `PreInvocation` / `PostInvocation` (not
  `BeforeModel`), plus `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`.
  No `SubagentStart` / `SubagentStop` events ([H]).
- Common hook inputs are `conversationId`, `workspacePaths`,
  `transcriptPath`, `artifactDirectoryPath`, `modelName` (all hooks).
  No usage/token fields, no parent/child identity fields.
  `PreInvocation` additionally carries `invocationNum`, `initialNumSteps`
  (step counters, not tokens) ([H]).
- `SessionStart` / `PreInvocation` `injectSteps.systemMessage` is an
  out-of-band system instruction; `ephemeralMessage` is transient. Do not
  promise system-prompt priority for either ([H]).
- `PreToolUse` gate decision `deny` exists; `PostToolUse` output is `{}` and
  takes no result/output input ([H]).
- `transcriptPath` is a JSONL path accessible to hooks, but its schema and
  any token fields are unverified ([H]).
- Native child model: parent `invoke_subagent` takes
  `Subagents[{Prompt, Role, TypeName, Workspace?}]`; `Idle` delivers a result
  to the parent and messages reawaken the child. No exact final-message,
  classifier, or native handback API verified ([S]).
- Headless mode exposes `stdout` `step_update` usage and `subagent_info`
  conversation ids with a cumulative result, not an installed-plugin getter.
  Do not sum usage fields with undefined overlap ([HD]).
- Status line JSON exposes `context_window` totals/window/`used_percentage`/
  `current_usage` (`input_tokens`, `output_tokens`, cache fields),
  `conversation_id`, and `subagents` with `name`/`role`/`status` only
  (no child ids, no child usage). It is a TUI script with no documented
  connection to hooks or MCP ([SL]).
- `/context` is interactive-only ([CX]); `/usage` reports credits ([CU]).
- Plugins: root `plugin.json` / `hooks.json` / `mcp_config.json` / `skills` /
  `agents` / `rules`, with `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` state ([P]);
  schema at [PS].

## What was Observed (isolated CLI probes, no auth, no model calls)

- Official binary, version 1.4.9. Probe plugin covers manifest, hooks, MCP,
  skills, agents, rules. Probes ran under an isolated HOME; no live config
  was touched.
- `agy plugin validate [path] [--strict] [--json]` (syntax per
  `plugin validate --help`; `install` takes a positional `<target>` per
  `plugin --help`) on the probe plugin exits 0 with components
  agents 1 / hooks 1 / mcpServers 1 / rules 1 / skills 1 and a single
  `note` finding (missing logo). An earlier saved report carrying a
  rule-trigger error (exit 1) predates the rule's `always_on` trigger and is
  superseded by this rerun. Install success alone is not a validator.
- An unknown `BeforeModel` event in a probe `hooks.json` warns and is
  ignored (exit 0); validation errors exit 1. `plugin list` showed the
  installed probe plugin.
- The product `plugin_data/<name>` dir was auto-created. Install and staging
  locations differ: local installation was observed at
  `~/.gemini/config/plugins/<name>/`, while CLI documentation describes
  staging at `~/.gemini/antigravity-cli/plugins/<name>/` ([P]). Persistent
  state was created at `~/.gemini/antigravity-cli/plugin_data/<name>/`.
  Equivalence between install and staging locations is not claimed here.
- `mcp list` outside a session was empty; session tools/caller binding is NOT
  verified.

Reproducible commands (`AGY`, `PROBE`, `ISO_HOME` are required inputs, no
defaults; isolated home/config under `/tmp` only):

```sh
: "${AGY:?Set AGY to the agy binary}"
: "${PROBE:?Set PROBE to the probe plugin directory}"
: "${ISO_HOME:?Set ISO_HOME to the isolated home directory}"
export HOME="$ISO_HOME" GEMINI_HOME="$ISO_HOME/.gemini"
"$AGY" plugin validate "$PROBE" --json   # exit 0; findings JSON
"$AGY" plugin install "$PROBE"           # positional target; install alone is not a validator
"$AGY" plugin list --json                # lists installed plugins
"$AGY" mcp list                          # empty outside a session
```

Recorded results: validate exit 0 with one logo `note`;
`plugin_data/<name>` auto-created; hook-load log line
`loaded 1 named hooks from 1 hooks.json file(s)`; bad-event probe
warn-and-ignore exit 0.

## Capability checklist (12 adapter requirements)

`Documented` = official docs; `Observed` = isolated unauthenticated probe;
`Unverified` = neither. **No Antigravity implementation is shipped**; each row
states the documented candidate mechanism (where one exists) against what is
still unknown.

| # | Requirement | Antigravity status |
| --- | --- | --- |
| 1 | Standing guidance in a trusted pre-prompt channel | Implementation absent. Documented candidate: `SessionStart` fires before the first model invocation and `systemMessage` inject is available ([H]). Actual prompt priority and model compliance Unverified. |
| 2 | Deferred tools named with loader | Implementation absent. Plugin MCP packaging is Documented ([P]); a deferred-tool/loader contract and in-session tool visibility remain Unverified. Hook handler type `command` ([H]) does not establish tool discovery. |
| 3 | Conflict precedence / unit-of-work bound | Implementation absent. Candidate: precedence and unit-of-work bounds can be delivered as intro text via `SessionStart`/`PreInvocation` inject ([H]); no host-required precedence surface is documented, and none is needed for text delivery. Compliance Unverified. |
| 4 | Staged escalation + separate hard gate | Implementation absent. `PreToolUse` deny is Documented ([H]); staged soft escalation has no established usage-anchored hook input (`invocationNum`/`initialNumSteps` are counters, not tokens) ([H]). |
| 5 | Continuation-by-default traceable to setup | Implementation absent. Candidate: the continuation default can be stated in setup-placed intro text ([H]). Parent compliance Unverified. |
| 6 | Same-type successor, same logical subagent | Implementation absent. Spawn params (`Role`, `TypeName`) Documented ([S]); replacement/count semantics Unverified. |
| 7 | Verified final-delivery path | Implementation absent. `Idle` result-to-parent Documented ([S]); exact handback/delivery API Unverified. |
| 8 | Bounded no-delivery fallback, never-resume rule | Implementation absent. Candidate: Stop-hook `continue` decision Documented ([H]); read-before-message/never-resume recovery Unverified. |
| 9 | Seed by reference with lineage, original captured once | Implementation absent. Candidate: child `Prompt` is observable in `PreToolUse` `toolCall` args ([H], `invoke_subagent` spec ([S])); mapping child conversation ids and `transcriptPath` schema Unverified. |
| 10 | Advisory-only growth, no generation cap | Implementation absent. Candidate: advisory growth is implementable over future handover text with a shared seed-size check; no host growth contract is needed. Threshold behavior Unverified. |
| 11 | Storage quota + diagnostics, unknown reads `unknown` | Implementation absent. `${PLUGIN_DATA}` state Documented ([P]), `plugin_data/<name>` auto-creation Observed; quota/diagnostics contract Unverified. |
| 12 | Parent readback separated from successor context, explicit reader policy | Implementation absent. Candidate: compact/full reader policy is adapter-owned (MCP tools); caller binding unresolved (out-of-session `mcp list` empty, Observed). |

## Primary blockers

1. No established hook-readable child **current context**: hook inputs
   carry no usage/token fields; statusline usage is TUI-only with no
   documented hook connection ([H], [SL]).
2. No established trustworthy child identity / parent relation in hook
   inputs: no usage or parent/child fields; statusline `subagents` entries
   lack ids ([H], [SL]).
3. No established MCP caller binding: plugin packaging does not establish
   which conversation called a shared MCP server. Session tool/caller routing
   remains Unverified; empty out-of-session `mcp list` is not evidence that
   plugin MCP tools cannot work.

## Unblock conditions

Any one of: a documented contract covering the three blockers, or separately
obtained transcript / hook / MCP / delivery fixtures.

## Potential minimal future design (candidate only, not shipped)

Start intro (`SessionStart` inject) + per-request shared stages (warn leads
only, no priority promises) + MCP `handover` / `read` tools + private
`${PLUGIN_DATA}` state + short native result + reference seed. No root
rollover and no native-compaction changes.
