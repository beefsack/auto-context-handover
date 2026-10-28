# Kiro CLI assessment

Status (2026-10-29): **prerequisite-blocked; no adapter shipped**. Ordinary CLI
hooks have no established hook-readable active-context measurement. This is an
evidence gap, not proof Kiro cannot support an adapter. No model compliance,
hook firing, MCP routing or continuation was observed.

## Distribution and pin

- AWS Kiro CLI, the successor to Amazon Q Developer CLI, not an unrelated
  package with a similar name ([Q]). Official installation uses the native
  installer at `https://cli.kiro.dev/install` ([I]).
- The stable manifest fetched on the assessment date reports **2.35.1** ([M]).
  Downloaded artifact: [versioned Linux archive][B], SHA-256
  `b4ec8f61c466dbfb06b73972fa746f4f96bf19abe2d4307af3cd988bde751b56`.
  Hash verified; extracted binary prints `kiro-cli 2.35.1`. `BUILD-INFO` records
  build hash `835ff3643451d740aec69e395a7f405b5d8aee84`.
- This pins the assessed artifact, not a supported adapter or every platform.
  The latest manifest is mutable; a version-scoped manifest request returned
  HTTP 403. The versioned archive was obtainable at assessment time, despite
  installation docs describing latest-only distribution. CLI auto-update is
  documented; holding a version requires managing updates ([I]).
- Binary help says engine **v2 is default**, with explicit `--v3` available.
  V3 docs must not be silently applied to ordinary default-engine launches.

## Capability evidence

**Documented** means primary docs, not observed runtime behavior. **Observed**
means an isolated non-model binary check. **Unverified** means no established
contract or observation. Shared/unified-harness docs can describe behavior newer
than the assessed binary; help alone does not validate their implementation.

| Capability | Documented | Observed / unverified |
| --- | --- | --- |
| Agent hooks and configuration | 2.x agent `hooks` object: `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop` ([L]). V3 inline arrays or standalone `.kiro/hooks/*.json`, PascalCase equivalents, file/task triggers; legacy aliases accepted ([H], [C]). | Binary has `agent validate`, but validation requires login. Actual schemas/loading/routing unverified. |
| Payload and measurement | JSON stdin; agentSpawn example has `hook_event_name`, `cwd`, `session_id`. MCP tool example additionally has `tool_name`, `tool_input`; PostToolUse describes access to results. V2-only `tool_tags` ([T], [H]). No usage/context/transcript field established in these hook contracts. | Some primary examples are incomplete. Actual PostToolUse/Stop payloads and child attribution unverified; absence from docs is not runtime proof of absence. |
| Injection | CLI SessionStart/UserPromptSubmit successful stdout enters context; **other successful hook stdout is ignored**. Agent actions inject prompts but consume another agent loop ([A]). | No ordinary PostToolUse stdout nudge channel established. Start/prompt introductions are documented, not compliance evidence. IDE tab behavior is not CLI behavior. |
| Tool deny and Stop | PreToolUse exit 2 blocks, stderr returned to model. V3 Stop exit 1 or a block decision requests another turn, not a pre-event denial; no matcher ([T], [A], [H]). | Actual block round-trip/loop limits unverified. Stop is potentially intrusive and would need explicit setup, not an invisible advisory mechanism. |
| MCP and caller binding | Agent `mcpServers` supports stdio/HTTP; tool selectors `@server/tool`; V3 loads tools through `tool_load` then `tool_call`, with normal permission/hook checks ([C], [TS]). Hook tool ids are sanitized `mcp_<server>_<tool>` ([T]). | Hook knows `session_id`; no verified propagation to MCP calls, host input rewrite, per-session process environment or call metadata binding. Unknown, not proven impossible. Model-echoed ids would not establish caller identity. |
| Subagents and handback | Isolated child context, findings returned to parent, shared MCP servers/workspace; per-child Hook triggers ([S]). | No established child usage/parent identity payload, SubagentStop event, exact final-delivery contract, override provenance or continuation-by-default. Do not transfer root assumptions to children. |
| Native storage/export | Per-turn per-directory SQLite sessions; V3 `/chat save` zip, 2.x JSON; save/load scripts exchange session JSON. `/transcript --json` exports full history ([SM], [SC]). | No validated current-request/transcript schema, freshness/compaction boundary or hook-safe exporter. Full history is not the active context. No plugin handover storage/reader implemented. |
| Context and compaction | Context meter and `/context show`; automatic and manual compaction. 2.x forks a compacted session; V3 uses a checkpoint in the same session ([CX], [L], [CP]). `/usage` is billing/credits in slash reference ([SC]). | No hook-readable meter established; never sum billing or tool-I/O totals into a window estimate. No Pre/PostCompact hook established. Native compaction unchanged. |
| Fresh continuation and ACP | `/chat new [prompt]` creates fresh context ([SM]). V3 ACP documents session-id-routed `context_usage.usagePercentage`, negotiated `_kiro/session/context`, `session/new` and prompting ([ACP]). | ACP is a real measurement candidate, **not a hook getter**. An owning ACP client/wrapper could investigate it; attaching ordinary CLI hooks to the existing client's stream is unestablished. No automatic CLI rotation/UI following implemented. |

## Non-model checks

- Extracted the official archive without running its installer. Repeated
  checks used an empty environment, separate temporary HOME, XDG directories,
  `KIRO_HOME` and workspace; binary directory included on PATH. No credentials
  were supplied. All commands were timeout-bounded with stdin closed.
- `kiro-cli --version`: exit 0, `kiro-cli 2.35.1`.
- `kiro-cli chat --help`: exit 0; confirms v2/v3 engine selection,
  `--output-format stream-json` (ACP events), session listing/resumption and
  `--require-mcp-startup`. Help is not MCP registration or hook validation.
- `kiro-cli agent validate --path <probe-agent.json>`: exit 1,
  `You are not logged in`. Probe contained V3 inline hooks and MCP configuration,
  with no model field. **Not a successful validation**.
- Additional investigation reported offline doctor/diagnostic/help checks;
  unauthenticated session/MCP listing attempted browser login and timed out.
  Those reports establish neither session schema nor MCP registration.

## Blockers and unblock path

1. Establish a session-attributed, hook-readable latest usage/context snapshot,
   or a defensible active-view transcript/export estimator including a known
   compaction boundary. Tool I/O alone misses user/assistant/system/history and
   cannot substitute. Interactive meters and full-history JSON exports alone
   do not establish this contract.
2. Establish an engine-specific nudge channel at a measured boundary: V3 start
   and user-prompt injection are documented; ordinary post-tool stdout is not.
   A bounded Stop-continuation design needs explicit opt-in and round-trip
   evidence. Do not use agent-action summarization in place of session-model
   handover authorship.
3. Establish host-to-MCP caller binding (including concurrent roots/children),
   then native delivery and root/child scope before choosing a storage/lifecycle
   design. Do not weaken identity to model-authored ids.

Published contracts or separately obtained sanitized hook/export/MCP fixtures
could unblock these without new model execution. If documentation remains
insufficient, authenticated validation and explicitly authorized probes would
be needed. An ACP-owning wrapper is a separate architecture choice, not a
drop-in adapter justified by these findings.

Candidate reuse after unblocking: shared guidance/stages; Codex immutable
store and capability pattern only if Kiro supplies a trustworthy bridge. Qwen
transcript assumptions and Crush's socket API cannot be transplanted. Manual
fresh-session reader-reference continuation would suffice for an initial MVP;
no hard gate or automatic creation is a prerequisite.

## Primary references

Markdown twins preserve article text that HTML-to-Markdown extraction can omit.

[Q]: https://kiro.dev/docs/upgrade-guides/migrating-from-q.md
[I]: https://kiro.dev/docs/getting-started/installation.md
[M]: https://prod.download.cli.kiro.dev/stable/latest/manifest.json
[B]: https://prod.download.cli.kiro.dev/stable/2.35.1/kirocli-x86_64-linux.tar.gz
[L]: https://kiro.dev/docs/cli/2x-reference.md
[H]: https://kiro.dev/docs/cli/v3/hooks-migration.md
[C]: https://kiro.dev/docs/custom-agents/configuration-reference.md
[T]: https://kiro.dev/docs/hooks/types.md
[A]: https://kiro.dev/docs/hooks/actions.md
[TS]: https://kiro.dev/docs/mcp/tool-search.md
[S]: https://kiro.dev/docs/custom-agents/subagents.md
[SM]: https://kiro.dev/docs/cli/chat/session-management.md
[SC]: https://kiro.dev/docs/reference/slash-commands.md
[CX]: https://kiro.dev/docs/cli/chat/context.md
[CP]: https://kiro.dev/docs/compaction.md
[ACP]: https://kiro.dev/docs/cli/v3/acp-migration.md
