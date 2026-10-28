# Antigravity CLI adapter assessment

## Goal and scope

Assess Antigravity CLI as the replacement target for Gemini CLI against
`docs/adapters.md`, using primary documentation and obtainable CLI contracts.
Implement a minimal subagent-first adapter only if measurement, context delivery,
identity and handover/readback contracts are sufficiently established.

Non-goals: root rollover, changing native compaction, speculative host APIs,
or porting the retired Gemini CLI adapter target.

## Acceptance

- Cite documented capabilities separately from CLI observations and unknowns.
- Cover all adapter requirements and the measurement, injection, denial,
  subagent delivery, packaging and storage prerequisites.
- If prerequisites are missing, publish the assessment and concrete unblockers
  without shipping a speculative adapter.
- Update README, adapter checklist and stale Gemini target guidance.
- Independently review the result and resolve concrete findings.
- Verify typecheck, unit suite, existing Claude plugin validation and available
  Antigravity non-model validation; archive this note with outcomes.

## Approach

1. Investigate primary docs, distribution and obtainable CLI schemas.
2. Decide feasibility from that evidence; implement only established contracts.
3. Reconcile documentation and record tentative product decisions.
4. Independently review, verify and archive.

## Decisions and outcome

- Antigravity replaces Gemini CLI as the future target; historical Gemini
  rows remain explicitly superseded rather than regraded.
- Phase 1 is complete; Phase 2 is prerequisite-blocked, not implemented.
  Hook-readable child context measurement, child/parent identity and MCP
  caller binding remain unestablished. Invocation counts are not a substitute.
- Per-model `PreInvocation`, pre-prompt context injection, execution denial
  and plugin/MCP packaging are documented. Private data-directory creation
  and plugin validation/listing were observed with unauthenticated CLI 1.4.9.
- The research assessment covers all 12 adapter requirements and separates
  documented capabilities, CLI observations and integration unknowns.
- Two tentative decisions in `docs/decisions.md` record the Phase 1 stop
  and prerequisite-gated subagent-first candidate design.

## Verification

- `npm run typecheck`: passed.
- `npm test`: 342 tests, 44 suites, all passed; no new tests because no
  production code or test contracts changed.
- Isolated `claude plugin validate .`: passed with existing author/icon
  metadata warnings and marketplace-install advice.
- Isolated `agy plugin validate "$PROBE" --json`: exit 0, one skill,
  agent, rule, hook and MCP server; missing-logo note only. This validates
  a probe package, not an Antigravity adapter in this repository.
- Isolated `agy plugin list --json`: exit 0, enabled probe with installed
  skill/agent/rule/hook. No model compliance or in-session MCP claim.
- Earlier probe validation correctly failed on invalid rule frontmatter;
  a corrected `always_on` fixture passed. Unknown hook events warn and are
  ignored even with exit 0, so successful installation is not validation.
- Independent review upheld the prerequisite-blocked verdict with no blocking
  findings. Its one low-severity reproducibility mismatch was resolved by
  aligning the research command with the observed `plugin list --json` probe.
