# OpenHands SDK advisory MVP

## Goal and acceptance

- Assess pinned OpenHands CLI and SDK extension contracts for measured,
  model-authored handover, durable readback and fresh continuation.
- Implement only a defensible small adapter using supported extension points;
  otherwise document exact blockers and an unblock path.
- Keep the native condenser unchanged. Distinguish source contracts,
  non-model observations and unverified model behavior.

## Approach

- Inspect primary sources and isolated installed Python packages.
- Resolve measurement freshness, injection and trustworthy caller binding before
  choosing an implementation surface. MCP support alone does not prove binding.
- Check whether a supported SDK integration can avoid replacing the CLI with a
  new application; do not silently introduce a wrapper architecture.
- Update research, adapter checklist, README and tentative decisions; verify
  repository checks and independent review, then archive this note.

## Design

- SDK-only composition helper, not a replacement CLI: equip an uninitialized
  Agent, supply a recording callback and UserPromptSubmit hook when constructing
  a local Conversation, then bind that exact host object before use.
- Read the main agent LLM's latest per-response metrics, never combined billing
  totals or condenser metrics. Persist only an adapter snapshot for the hook.
- Nudge only at the next submitted user prompt, using additionalContext. This
  deliberately misses growth inside autonomous runs; no Stop-denial loop or
  callback-triggered send/run calls. Native condensation remains unchanged.
- Direct SDK writer/reader with exact bound-conversation checks, immutable private
  files, shared guidance and manual fresh-conversation reader continuation.

## Accepted evidence and outcome

- Initial investigation reports CLI `1.16.0`, SDK/tools `1.21.0`, CLI hook/MCP
  support, SDK direct tools and file persistence. Installed hook types have no
  usage fields or argument rewriting; MCP executor ignores its conversation
  argument, so the standard CLI path lacks established writer attribution.
- SDK callbacks execute inside the agent step. They must remain record-only;
  public constructor-supplied hooks provide safe user-prompt injection instead.
  This avoids an owning driver loop or changing the condenser.
- Implemented the SDK helper, Python fixtures and Node shared-text drift guards;
  README, checklist, reassessment and tentative decisions describe SDK-only scope.
- Direct verification: installed CLI version/help/MCP help pass without a model;
  package metadata confirms all pins/Python requirement. Real HookManager
  PreToolUse denial returns blocked=True and its supplied reason.
- Final direct verification: `npm run typecheck` passes; `npm test` passes 755
  tests, 139 suites, no failures/skips. Isolated Python 3.12 command
  `PYTHONPATH=openhands python openhands/test_handover_adapter.py` passes 26 tests
  in 39.255 seconds, without provider execution. `claude plugin validate .`
  passes with existing author/icon warnings and marketplace advice.
- `git diff --check` passes. Package dry-run includes the Python helper,
  requirements and tests; explicit exclusion prevents bytecode-cache packaging.
- Integration review corrected early implementation issues before acceptance:
  private SDK mutation removed, private file modes apply at creation, actual
  hook emission distinguished from mere over-limit measurement, and corrupt
  immutable records refuse reuse. No native condenser behavior was changed.
- Independent public-contract/security review completed. Its three findings are
  resolved: condition the introduction on a nudge/explicit request, preserve
  freshest memory diagnostics after failed snapshot writes, and document adapter
  lifetime with the weak registry. Snapshot failures log, retry on later usage
  events and attempt stale-file removal. Failed removal can leave stale notices.
- Additional ordering regressions cover hook emission followed by a new response
  or native condensation before writer execution. Session/token/revision-matched
  emission evidence is latched separately from measurements; condensation clears
  measurements without erasing prior nudge provenance.
- Outcome: local SDK composition ships; installed CLI/remote integration remains
  unsupported for the documented binding reasons. Research, checklist, README,
  reassessment and tentative decisions are updated. Model compliance/provider
  normalization/continuation remain unverified; autonomous runs may compact before
  a next-user-prompt notice. No automatic continuation, source lock or child
  workflow is claimed. No unresolved review finding remains.
