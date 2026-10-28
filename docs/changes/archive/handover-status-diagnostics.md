# Handover status and diagnostics

## Goal and scope

- Make locked child follow-ups in both adapters explicitly refuse questions or further work, point to the exact full-handover reader call, and prescribe a successor or fresh subagent. Preserve the incomplete prefix and continuation default; root lock behavior stays unchanged unless shared text requires a trivial adjustment.
- Add concise honesty guidance to the shared six-section template: disclose instruction deviations, triggered stop conditions, failed/erroring calls and unverified claims; unresolved deviations or stop conditions preclude PASS/completion; summaries must not overclaim the body.
- Persist minimal call-time diagnostics with each new handover: reason (`nudged` or `not-nudged`), known stage, latest estimated context tokens and effective soft limit. Unavailable values are `unknown`. Readback exposes one header line; legacy records remain readable.
- No changes to nudge/gate/rollover behavior or per-request model text beyond the authorized locked-child and template guidance. No migration or inference of user-request intent.

## Acceptance

- Both adapters refuse locked-child follow-up explicitly, including legacy stored replies, without answering questions or implying new work occurred.
- Honest-status rules appear in the shared default template for both adapters; stored model text remains verbatim.
- Diagnostics reflect the latest request snapshot at handover-call time, not the handover payload itself. OpenCode uses its measured context including trailing chars/4 estimate; Claude uses the child's latest per-request usage.
- Unknown/reload cases and legacy records read cleanly; no extra request text is introduced by diagnostics.
- Targeted unit coverage in both adapters; typecheck, full tests and plugin validation pass; independent review has no unresolved blocking findings.

## Approach and bounded units

1. Implement the shared text, adapter-specific refusal and stored diagnostics, with regression tests.
2. Inspect the actual diff and run typecheck, full tests and plugin validation.
3. Independently review public text contracts, call-time provenance, legacy handling and behavior isolation; resolve concrete findings.
4. Promote the authorized decision and archive this note with evidence.

## Evidence and material decision

- User-approved scope (2026-10-28): explicit locked-child follow-up refusal, honest status guidance and minimal persisted handover diagnostics in both adapters.
- Reported dogfooding evidence: transport was verbatim across 29 handovers; unanswered locked-worker follow-ups, optimistic status claims and absence of persisted nudge provenance motivated this change. This is external evidence, not direct verification here.
- Existing uncommitted adapter and continuation work is the implementation baseline; preserve its contracts and exports.

## Outcome and verification

- Implemented a shared explicit locked-child reply with adapter-specific exact reader calls. Legacy stored summaries are no longer replayed as answers. OpenCode root lock wording and all existing source exports remain intact.
- Claude records the handover turn identity and observes current identity before tools can run inside `turn.step`. Same-turn initial native handback retains the short summary; resumed, unknown and legacy identities forward the locked reply through the unchanged classifier-reviewed chain. Stop correction remains bounded and preserves other hooks' decisions.
- Added the concise honest-status rule to the shared default template without rewriting stored text or summaries.
- Persisted optional diagnostics and one labelled reader header, including clean unknown fields for legacy records. OpenCode uses an independent pre-call diagnostic snapshot, preserving partially known soft/estimate values without changing loop baselines. Claude tracks observed batch-nudge delivery independently of latest usage; no formal stage is claimed.
- Initial inspection corrected missing-snapshot provenance and Claude resumed native-handback/stop paths. A targeted malformed-batch-context test then reproduced a false `nudged` claim; marking delivery only after context composition repaired it. The regression is included in the final suite; no unresolved acceptance failure remains.
- Direct final verification: `npm run typecheck` passed; the full test suite passed 226 tests, zero failures; `claude plugin validate .` passed with existing author/icon warnings and installation advice; `git diff --check` passed.
- Independent review inspected implementation, fixtures and decisions, reran typecheck and the then-current 225-test suite, and found no blocking defects. Focused follow-up review accepted the final context-composition repair and documentation; the final 226-test rerun was direct verification after that repair.
- Updated point-of-use behavior/storage documentation and promoted the authorized decision to `docs/decisions.md`.
- Remaining risks: model-facing refusal/honesty guidance is advisory outside native handback shaping; real host resumptions, classifier behavior and reload integration were not live-verified. Transient diagnostic state can be lost on reload; unavailable values remain unknown, and legacy/unknown child turn identity conservatively selects the locked reply. Existing child-successor chain bounding remains separate.
