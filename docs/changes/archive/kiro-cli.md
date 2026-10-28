# Kiro CLI assessment

## Goal and scope

Assess the current AWS Kiro CLI distribution and its pinned installed contracts.
Ship the smallest measured handover adapter only if measurement, injection,
host-bound tools and durable model-authored readback are defensible. Native
compaction and existing adapters remain unchanged.

## Acceptance

- Primary-source capability assessment distinguishes documented, observed and
  unverified behavior, including hooks, usage/transcripts, MCP attribution,
  subagents, storage and compaction.
- If feasible: direct TypeScript/no build, shared logic where useful, isolated
  non-model validation and unit coverage using temporary directories.
- If blocked: concise assessment with the precise unblock path, no speculative
  adapter or installation instructions.
- README and adapter status agree with the outcome; decisions are marked
  tentative pending review. Typecheck, tests and plugin validation recorded.

## Approach and units

1. Establish pinned distribution, installed non-model surface and capability
   contracts; decide feasibility before implementation.
2. Implement only an evidence-supported MVP, or record the blocker.
3. Independently review public contracts and evidence, resolve findings, verify
   the resulting tree and archive this note.

## Outcome and accepted evidence

- Assessment-only outcome: stable binary 2.35.1/hash verified, version/help
  observed, isolated agent validation refused without login. Default engine is
  v2; V3 hook documentation is not proof of pinned runtime routing.
- Primary Markdown docs establish start/prompt injection, ignored successful
  post-tool stdout and Stop continuation. No ordinary-hook active-context
  measurement or host-to-MCP identity bridge is established. ACP context usage
  belongs to the owning client and does not resolve the installed-hook gap.
- README, adapter checklist and reassessment now link the precise blockers.
  Tentative assessment/scope decisions recorded; no adapter/dependencies/tests
  added. Native compaction and existing adapters unchanged.
- Verification: `npm run typecheck` passed; `npm test` passed 753 tests, 139
  suites, zero failures/skips. `claude plugin validate .` passed with existing
  missing-author/icon warnings and marketplace-install advice.
- Independent evidence/public-contract review found no blocking findings and
  reproduced binary version/help, validation refusal and typecheck. Reviewed
  measurement, injection, identity and ACP boundaries against primary docs.
  Minor evidence questions resolved: the manifest HTTP 403 is a direct probe
  observation, not a distribution guarantee; 2.x fork/V3 checkpoint behavior
  is explicitly documented in the cited CLI 2.x reference, not runtime-verified.
- Complete assessment-only result. No adapter unit coverage is claimed; the
  unchanged test suite establishes regression checks only. Next product step
  is obtaining the missing measured-hook and caller-binding contracts/fixtures,
  or separately choosing an owning-ACP integration.
