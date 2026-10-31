# OpenHands CLI / SDK assessment

Status (2026-10-29): **SDK-only advisory/manual MVP**, not an installed CLI
plugin. Python composition equips an uninitialized local SDK Agent, supplies a
record-only callback and UserPromptSubmit hook, then binds the constructed
Conversation. No replacement application, driver loop or condenser is shipped.
Notices occur only on the next user submission; an autonomous run can compact
before any notice. Fixtures and non-model checks do not establish model behavior.

## Assessed versions and primary sources

- CLI `openhands==1.16.0`, source
  [`2963442dacc7cea44e39b7c4e73724295c853465`][C], requires Python `3.12.*` and
  pins SDK/tools `1.21.0`, workspace `1.11.1`. Assessed package is the official
  OpenHands CLI, not the older monolithic runtime.
- SDK `openhands-sdk==1.21.0`, source
  `4110929b788604d50d83ec693bc445ef8e0a3d38` (tag `v1.21.0`), is the assessed
  source, not an installation pin. Adapter requirements use `openhands-sdk>=1,<2`.
  [Custom tools][T], [callbacks and construction][L],
  [hooks][H], [metrics][M], [native condenser][N]. Published current
  [hook documentation][D] also describes newer prompt/agent hooks: those are
  not assumed to exist in the assessed package.

## Capability evidence

**Documented/source-established** is a primary-source contract, **observed** is
an isolated non-model check, **unverified** is not a model-behavior claim.

| Capability | Documented / pinned source | Observed / unverified |
| --- | --- | --- |
| Measurement | Main LLM `metrics.token_usages` holds individual response records; separate accumulated totals and per-usage-id conversation ledgers exist [M]. Hook input itself has no usage/transcript fields [H]. | SDK adapter samples latest main-agent prompt + completion, never accumulated/combined or condenser usage. Seeded real Metrics fixtures only; actual provider normalization/freshness unverified. Cache/reasoning detail is not added again. |
| Window and timing | TokenUsage exposes context_window [M]. User callbacks run before default event persistence and after hook processing [L,H]. | Capped integer default200000, explicit percentages; latest previous-response estimate, excluding new user prompt/later results. No tool-boundary/autonomous-run notice. Native Condensation clears measurement until a new ordinary response record. |
| Introduction / injection | AgentContext supports system_message_suffix; UserPromptSubmit additionalContext becomes MessageEvent.extended_content [A,H]. | Existing suffix preserved, staged subprocess context observed via real HookManager; synthetic usage and real send_message path, no model. Priority/compliance unverified. |
| Tools and identity | ToolDefinition.create and ToolExecutor receive host state/conversation; Agent.tools resolves registered specs [T,A]. | Both direct tools resolve in installed SDK; exact bound object/id checks refuse inherited tools in another conversation, including a same-id clone. Application explicitly chooses scope; no automatic root classifier. No deferred loader. |
| Denial | PreToolUse exit2 denies; Stop denial continues with feedback; hook result has no input-rewrite contract [H]. | Isolated PreToolUse denial observed. Adapter uses neither denial nor Stop; no hard gate/source lock. Actual native Stop-denial loop unverified. |
| CLI / MCP / plugin packaging | CLI setup loads hook files; MCP supports stdio/static env [C,S]. SDK plugin bundles skills, hooks, MCP and agents [P]. MCP executor discards its conversation argument [X]. | CLI version/help/mcp help succeed; no plugin subcommand. No CLI PluginSource loading or trustworthy host-to-MCP identity propagation established. Do not install this helper through CLI hooks/MCP or a plugin manifest. |
| Storage | SDK persistence writes events/base state; metrics nested mutations need not synchronously save base state [L]. | Adapter does not parse native transcripts. HOME private hashed-id immutable files, verbatim writer/reader and corrupt-store refusal fixture-covered. No quota/retention/fsync guarantee. |
| Continuation | New Conversation creates a fresh identity; passing an existing id resumes. Native fork preserves history and is not an empty fresh context [F]. | Manual new independently equipped Agent/Conversation and reader reference. Construction/readback observed without a model; no automatic creation, UI switch or settings-preservation claim. |
| Delegation | DelegateTool creates sub-conversations with separate Agents and returns task results [G]. | Not integrated; no child measurement/handback/replacement/provenance claim. Inherited tools cannot use the original adapter binding. |
| Condenser | Agent preparation invokes its configured condenser; native summarizer has separate LLM/metrics [N,A]. | Adapter leaves condenser object/config unchanged, observes Condensation only. No replacement summarizer or promise of pre-compaction authorship. |

## Implementation boundaries

- Standard SDK composition is the supported surface, not post-hoc injection into
  a live CLI or remote agent server. Keep one adapter, uninitialized Agent and
  independent main LLM metrics object per local conversation; do not reuse an
  already-running/equipped Agent. Preserve existing callbacks and merge hooks.
- Any equipped, exactly bound caller may read any retained source id through its
  own reader. Targets are hashed, never model-supplied paths. Host id is recorded;
  effective model, requested override, original task and lineage remain unknown.
- New directories/files use 0700/0600 from creation; immutable hard-link
  publication is first-writer-wins. No quota, TTL, eviction, deletion cleanup,
  same-user sandbox or fsync promise. Snapshot/temp files can remain; manual
  deletion loses readback. Storage follows HOME, not XDG or workspace settings.
- A nonce-scoped atomic snapshot bridges the recording callback to the hook.
  Unknown usage is silent. Fresh memory supplies writer diagnostics; matched
  snapshot revisions latch hook emission independently of later measurements or
  condensation, not model receipt. Reload starts unknown. Failed writes log and
  retry on later usage events, with best-effort stale-file removal; failed removal
  can leave stale notices. Native condensation can preempt a notice. Handover-only
  chars/4 >50% soft warns/advises next-handover compression without rewriting text.
  Python shared text has Node drift tests. Keep the adapter alive for its bound
  conversation; its tool registry is weak, and inline equip-only usage is unsupported.

## Non-model validation

- Isolated Python environment installed the pins above. `openhands --version`,
  `--help` and `mcp --help` exited0 without credentials/model execution; emitted
  an upstream Authlib deprecation warning.
- HookConfig/Plugin loading and direct tool resolution were observed in the
  installed SDK. A standalone PreToolUse command exited2 and returned
  `blocked=True`, `continue=False`, reason `probe-deny`.
- `PYTHONPATH=openhands python openhands/test_handover_adapter.py` exercises real
  SDK construction/registration, synthetic response usage, actual hook subprocess
  injection, immutable storage, attribution, condensation invalidation and
  readback. It never calls Conversation.run or a provider. Use an isolated HOME,
  XDG directories and temporary directory when reproducing.
- Final counts/review: [completed change note](../changes/archive/openhands-adapter.md).

## CLI unblock path

Establish trustworthy conversation/root binding into MCP (or a public CLI-loaded
Python tool factory), plus a measured lifecycle injection boundary. Direct SDK
composition already provides bound tools; that does not establish CLI loading.
Native persistence may enable a lagged measurement, but in-place metrics saves
are not per-event snapshots. Do not use model-echoed ids, newest-session files,
or a global single-root handoff as concurrent caller identity.

[C]: https://github.com/OpenHands/OpenHands-CLI/blob/2963442dacc7cea44e39b7c4e73724295c853465/pyproject.toml
[S]: https://github.com/OpenHands/OpenHands-CLI/blob/2963442dacc7cea44e39b7c4e73724295c853465/openhands_cli/setup.py
[T]: https://github.com/OpenHands/software-agent-sdk/blob/4110929b788604d50d83ec693bc445ef8e0a3d38/openhands-sdk/openhands/sdk/tool/tool.py
[L]: https://github.com/OpenHands/software-agent-sdk/blob/4110929b788604d50d83ec693bc445ef8e0a3d38/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py
[H]: https://github.com/OpenHands/software-agent-sdk/blob/4110929b788604d50d83ec693bc445ef8e0a3d38/openhands-sdk/openhands/sdk/hooks/conversation_hooks.py
[M]: https://github.com/OpenHands/software-agent-sdk/blob/4110929b788604d50d83ec693bc445ef8e0a3d38/openhands-sdk/openhands/sdk/llm/utils/metrics.py
[A]: https://github.com/OpenHands/software-agent-sdk/blob/4110929b788604d50d83ec693bc445ef8e0a3d38/openhands-sdk/openhands/sdk/agent/agent.py
[N]: https://github.com/OpenHands/software-agent-sdk/blob/4110929b788604d50d83ec693bc445ef8e0a3d38/openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py
[P]: https://docs.openhands.dev/sdk/guides/plugins
[X]: https://github.com/OpenHands/software-agent-sdk/blob/4110929b788604d50d83ec693bc445ef8e0a3d38/openhands-sdk/openhands/sdk/mcp/tool.py
[F]: https://docs.openhands.dev/sdk/guides/convo-persistence
[G]: https://docs.openhands.dev/sdk/guides/task-tool-set
[D]: https://docs.openhands.dev/sdk/guides/hooks
