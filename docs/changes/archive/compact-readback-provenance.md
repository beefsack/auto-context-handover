# Compact readback and authoritative provenance

## Goal and scope

- Make Claude parent readback compact by default while successors always receive the verbatim original task and handover.
- Keep plugin-recorded provenance authoritative; preserve open questions and permit targeted re-reads without repeating completed work in both adapters.
- Add Claude first-measured context and last-batch context-growth diagnostics with honest unknowns.
- Verify the supplied review candidates; fix only confirmed low-risk defects and document intentional behavior.

## Non-goals

- No threshold, overshoot, enforcement, root lifecycle or storage-retention changes. Do not modify principles.

## Acceptance

- Compact readback includes diagnostics, provenance, lineage/generation, next-step count, seed size, pending decisions, extracted prioritized next steps and successor pointer; explicit full reads and successor reads remain complete and verbatim.
- Unsupported next-step extraction is labelled honestly and points to a full read.
- Shared template and framing preserve open questions and distinguish plugin provenance from model text.
- README, adapter requirements and durable decisions match actual behavior and reader access policy.
- Unit coverage for both adapters; typecheck, full tests and plugin validation pass; independent review has no blockers.

## Approach and bounded units

1. Implement Claude readback/diagnostics and shared wording with targeted regression coverage; inspect Claude/shared review candidates.
2. Verify remaining OpenCode and host-contract review candidates; fix only clear low-risk defects with regression coverage.
3. Review actual changes, align durable records, run full verification and independent review, then archive this note.

## Decisions and evidence

- The supplied five-generation live report is external evidence: continuation completed without lost notes; its code-review findings are unverified inputs, not accepted defects.
- Parent compact readback, plugin provenance authority and targeted re-reads are explicit product decisions for this change.
- Successor pointers explicitly request `full:true`: spawn metadata is saved only after `agent.spawn` returns, so lineage alone cannot guarantee a full early read. Recorded immediate-predecessor lineage also auto-selects full for bare calls. Fixtures cover both paths without a new identity API or authorization policy.
- Baseline is captured only after a newly observed launch in the current registration; existing child/spawn metadata or a failed metadata lookup leaves start context unknown. Later consecutive measurements can still establish growth, including negative changes and post-reload deltas. No extra persistent key or retention policy was added.
- An initial implementation left old full-default assertions failing (275 passed, 18 failed); updated fixtures test compact omission, explicit full and successor paths rather than preserving obsolete assertions. Final checks pass.
- Independent review found lossy hybrid pending-decision extraction (same-line text plus following items), corrected with a regression fixture. A targeted follow-up exposed a fabricated post-reload baseline; capture is now restricted to observed launches, with resumed/reloaded/outage fixtures. Independent follow-up confirmed both corrections with no blockers.

## Review candidate verdicts

Source inspection resolved the supplied model-written review as follows. Host-contract observations below are distinct from installed-host/model verification.

| Candidate | Verdict and disposition |
| --- | --- |
| OpenCode lock check uses fail-open `readJson`, mutation tool uses strict reads | By design: context-hook storage failures fail open, documented in README and source; mutation reads refuse on outage. No enforcement change. |
| `next.error.kind` access | Low: canonical caught-hook contract supplies `error`; no reproduced host defect. Defensive unknown fallback added with a missing-error fixture. |
| Readers have no caller authorization | By design: open to live callers with tool access. OpenCode description was misleadingly narrow; corrected with a regression test. Claude description and README make the open policy explicit. |
| Per-child Maps/Sets not pruned | Report-only limitation. Existing maps and new diagnostic maps are process-scoped; no safe lifecycle bound is established. Storage/memory retention remains separate work. |
| Read-only plugin-storage permission and successor without confirmation | By design: explicit installed workflow decisions, not a newly discovered permission bypass. No new settings or confirmation gate. |
| Claude calling OpenCode `sessionID` builders | False lead: no production `hooks/` import of `source/text.ts`; Claude uses `childId`. The test import checks shared wording. |
| Unsupported next-step formats yield unknown | By design: conservative format-derived diagnostics, not partial or semantic progress. Compact extraction falls back explicitly to full. |
| Root intro references a later-declared constant | Low/non-defect: used inside function bodies at call time, not in an earlier eager initializer. |
| Claude type header / installed-host drift | Canonical fetched declaration header matches 2.1.277; installed-host compatibility is not established by the narrow structural types. Canonical caught failure type has required budget and no re-entry variant; local subset drift is low and unrelated to runtime behavior. |
| `handbackOk` does not distinguish classifier withholding | By design/unknown host detail: records non-denial/non-error tool success, not parent receipt; canonical public contract exposes no independent receipt/withhold signal. |
| Config array cast / unrestricted description string | Low/non-defect: offsets validated before cast; custom description replaces the default wholesale, including empty strings. |
| OpenCode best-effort state writes / plain prompt-hook Error | By design: state-write failures surface warnings; prompt admission errors are not tool errors. |
| Integer soft cap skipped with unknown window | By design: explicit capped-soft decision preserves uncapped integer values for unknown windows. |
| Pure helpers accept zero soft, first-offset comment not enforced, unknown stage defaults to final, separate stage helpers | Low: validated production configuration supplies positive thresholds and ordered offsets; configurable OpenCode stages remain separate from fixed Claude stages. No threshold change. |
| Seed factor 0.5 / broad positive integer and percentage ranges | By design/low: explicit seed boundary and threshold syntax; no new cap or minimum. |
| Soft-marker banner / malformed tag rejection | Banner match against pinned host source remains unverified, not a confirmed defect; malformed scoped tags are rejected by explicit decision. |
| Store comment-only short reply, no handover size cap, namespaced keys | Low/by design: construction enforces short replies; no retention/size-cap design authorized; plugin storage namespace is intentional. |
| TUI metadata acceptance and silent lookup failures | By design/low: namespaced successor metadata with current-route checks; failed navigation is a silent no-op. No TUI change. |
| OpenCode child full-seed reply vs Claude reference pointer | By design: reference-pointer seeding is Claude-specific. OpenCode retains full root seeds and child guidance; shared framing does not change lifecycle or seeding contracts. |

## Outcome and verification

- Implemented compact Claude parent reads, explicit full reads, full successor pointer and lineage detection, authoritative plugin provenance, open-question preservation/targeted rereads, baseline/growth diagnostics and a defensive catch guard. Stored original tasks, handovers and summaries remain unchanged.
- Changed runtime/text files: `hooks/child.ts`, `hooks/register.ts`, `source/shared/handover-text.ts`, `source/index.ts`; regression fixtures: `hooks/register.test.ts`, `source/gate.test.ts`; documentation: README, decisions, adapter checklist and this note.
- Direct final verification: `npm run typecheck` passed both adapters; `npm test` passed 302 tests in 42 suites, zero failures (9 tests added from the 293-test baseline). Separate adapter runs passed 153 OpenCode/shared tests and 149 Claude tests. `claude plugin validate .` passed with existing missing-author warnings, directory-icon warning and marketplace-install advice. `git diff --check` passed.
- Independent final review inspected the full implementation, fixtures and aligned documentation, confirmed both earlier findings resolved and reported no blockers. A final comment-only cleanup removed a duplicated sentence; typecheck and tests passed afterwards.
- External five-generation report observed completion with preserved notes and normal handback. It does not verify new compact behavior, baseline/growth diagnostics or current installed-host compatibility.
- Follow-up corrected stale plugin/marketplace descriptions to acknowledge context-only root introductions and removed the repeated source section heading from compact next-step excerpts; original full handovers remain verbatim. Regression coverage asserts body-only compact output.

## OpenCode-visible changes

- Shared six-section template no longer requests self-authored agent/model/chain provenance; preserves open questions explicitly without renumbering or retitling sections.
- Shared seed and child-continuation framing permits targeted rereads to resolve open questions while prohibiting completed-step repetition. Root stage nudges remain unchanged.
- Reader description now accurately states the existing open-reader policy. OpenCode continues to return full handovers by default, with unchanged tool inputs, exports, storage, measurement, thresholds, gating, rollover and TUI behavior.

## Remaining risks

- New compact/baseline behavior has fixture coverage, not a new installed-host/model compliance result. Full readback remains subject to host output limits; metadata observation does not see downstream spawn rewrites.
- Original tasks/handovers remain subject to the shared store quota. Per-child memory maps and persisted records have no new retention policy; retention is separate work.
- Baselines are unknown for unobserved/reloaded existing starts and metadata-read failures; later consecutive measurements can still establish growth. Conservative section/pending extraction can require an explicit full read.
- Installed Claude declaration drift, classifier-withhold details and the soft-marker banner against pinned host source are not established by this change; no confirmed defect was inferred from unknowns.
