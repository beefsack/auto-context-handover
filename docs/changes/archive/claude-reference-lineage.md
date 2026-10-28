# Claude reference continuation and lineage

## Goal and scope

- Replace parent-repeated successor seeds with short references, observed original-task capture, inherited lineage and verbatim successor readback.
- Frame original instructions as reference context, preserve completed work and predecessor evidence, and name "Prioritized next steps" rather than section numbers.
- Add generation/progress metadata and advisory seed-size feedback without a fixed generation cap; parent judgment remains authoritative.
- Verify the supplied review candidates and fix confirmed defects. OpenCode changes are limited to direct shared-text equivalents and explicitly requested defect corrections.
- Exclude root enforcement, overshoot, teammates and changes to principles.

## Acceptance

- Original task captured from the documented spawn prompt once per chain; successors inherit it through validated predecessor references, retaining parent redirection.
- Readback preserves the full handover verbatim and exposes lineage/progress; unknown and legacy data stays honest.
- Documentation explains mechanism, host constraints, storage and advisory behavior. Durable decisions match implementation.
- Regression tests cover both adapters; typecheck, full tests and plugin validation pass; independent review has no blockers.

## Approach

1. Implement Claude reference delivery, lineage, framing and seed feedback with host-contract citations and regression tests.
2. Inspect the OpenCode review candidates, fix confirmed authorized defects and apply direct shared-text equivalents.
3. Reconcile documentation and decisions, verify final checks, independently review and archive this note.

## Decisions and evidence

- Canonical Claude mod declarations expose `AgentSpawnInput.prompt` as the Agent tool task prompt; observation is not proof against downstream rewrites.
- User accepted storing the observed original prompt once per chain, referenced by successors, retaining handovers without automatic eviction and reporting quota failures explicitly. The documented Claude store quota is 4 MiB total. Bounded retention/cleanup is separate work.
- Preliminary investigation corrected two false leads: `agent.spawn` does expose the prompt, and OpenCode `allKeys` does not manage Claude's separate host store.

## Outcome and verification

- Implemented Claude original-task capture, prefix marker/reader pointer, lineage inheritance, reference framing, title-based next steps, progress headers, shared seed-size warning and honest original-capture failures. Changed `hooks/child.ts`, `hooks/register.ts`, `hooks/claude-types.ts`, `hooks/register.test.ts`, `source/shared/handover-text.ts`, `source/shared/seed-size.ts`, `source/measure.ts`, `source/text.ts` and `source/gate.test.ts`; documentation in README and decisions matches the contract.
- Original prompt uses the documented `AgentSpawnInput.prompt`. Full payload delivery is successor-initiated readback with existing live-reader permission, not a large start-hook injection; avoids parent copying/paraphrasing and does not assume host output is unlimited or system-priority. Canonical [mod declarations](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts), [context placement](https://code.claude.com/docs/en/hooks#add-context-for-claude) and [limits](https://code.claude.com/docs/en/plugins/mods/reference#limits) establish these boundaries.
- Regression coverage includes exact reader-pointer reuse across generations and reload, appended parent redirection, spawn/handback timing, missing/malformed/quoted markers, no duplicate original storage, quota causes, legacy unknown fields, actual template/report headings, short final steps and seed-size boundary parity. Readback preserves original/handover once each; originals and handovers are never mechanically summarized.
- Integration inspection found and corrected premature closed-record skipping, non-prefix pointer generation, inheritance from a raced predecessor, an unreliable short-last-step count and mismatch with the actual template heading. These were caught before acceptance; unit evidence now covers the corrected contracts.
- Independent read-only source review reran typecheck and all 293 tests and found no source blockers. Documentation follow-up caught historical seeding language without explicit supersession and an inventory scope ambiguity; both were corrected.
- Direct final verification: `npm run typecheck` passed both adapters; `npm test` passed 293 tests in 40 suites, zero failures (21 tests added relative to the previous archived 272-test baseline); `claude plugin validate .` passed with existing author/icon warnings and marketplace-install advice; `git diff --check` passed. The Claude adapter contributes 141 tests; the OpenCode adapter contributes 152.
- Independent documentation follow-up confirmed both record corrections resolved with no remaining blocker. Complete; installed-host/model compliance remains a retest risk, not claimed verification.

## Review candidate verdicts

| Candidate | Verdict |
| --- | --- |
| Child read-only/storage vs no-other-tools | Phase ambiguity clarified: storage before successful handover, only handback afterwards. No new permission bypass. |
| Native forwarding/classifier stated as guaranteed | Distinguish implemented adapter forwarding from host receipt/classifier outcome; mandatory handback retained. |
| `handbackOk` ignores classifier withholding | No exposed classifier-receipt signal. Keep observed non-denial/non-error tool success, not a receipt claim. |
| Nudge set precedes delivery confirmation | Set updates after successful context composition; no model receipt API. Clarify appended-context provenance, not delivery proof. |
| OpenCode lock before successor prompt | Explicit existing safety/recovery contract, not a new defect. Uncertain admission is not known idempotent; retain source lock and manual recovery rather than risk duplicated successor prompts. |
| Locked tools remove reader | Locked caller vs locked target distinction: another live session can read the locked target. No change. |
| 70% integer soft cap | Explicit user decision. No change. |
| `softStage` fixed offsets | Claude-only fixed stages; OpenCode calls configurable `stageOf`. No ignored OpenCode configuration. |
| `allKeys` lacks Claude keys | Independent host stores. All six OpenCode families are covered; Claude retention is separate. |
| Fresh-root `highWater` absent | First-root handover is excluded from loop counting; successors already have state. No defect. |

## OpenCode-visible changes

- This inventory covers the reference-lineage change only. Earlier child-continuation/status changes also affect these files, including the locked-child helper replacements recorded in their archived change notes; those earlier changes are not newly introduced here.
- Root successor seed: shared reference-only/no-repeat/predecessor-trust/provenance framing, with continuation by title.
- Child continuation and locked replies, plus the child-labelled static handover-description appendix: same framing and title-based continuation.
- `seedTooLarge` implementation moved to a dependency-free shared module and re-exported under the existing `source/measure.ts` name; unchanged behavior. This extraction preserves that public export.
- No changes to OpenCode locking, prompt admission, thresholds, stage configuration, tool availability, loop guard, root nudge/hard texts, storage families or TUI behavior.

## Remaining risks and retest

- The 4 MiB store can fill; there is no eviction/cleanup policy in this change. Capture/storage failures are explicit where observed; total persistence failure plus reload can lose the cause. Downstream spawn rewrites remain unobserved; legacy or malformed metadata stays unknown.
- Seed estimates exclude host overhead; next-step counts are conservative format-derived cues, not semantic progress. Tool-result limits and model compliance require integration testing. Native success does not independently prove parent receipt/classifier disposition. OpenCode uncertain prompt admission still requires manual recovery by design.
- Follow README's parent-continuation retest: three generations, pointer passed verbatim plus optional redirection, original/handover exact once, no repeated completed reads, section-7 next steps, unchanged provenance, progress check-in and seed warning. Fixture checks cover timing/reload/quota/malformed references; installed-host behavior remains unverified by this change.
