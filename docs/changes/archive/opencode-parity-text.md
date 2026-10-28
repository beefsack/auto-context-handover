# OpenCode parity guidance

## Goal and scope

- Apply the approved text-only OpenCode parity package: explicit final-message delivery, logical successor replacement, progress check-ins, final-report precedence, read-only storage permission and reference-only child seeding.
- Correct adapter delivery documentation and align README guidance and durable decisions.
- No new mechanisms, stored state, tool parameters, first-request injection or root introduction. Preserve OpenCode stage leads, locked-child refusal, root seeds and Claude native handback/reference continuation.
- Compact OpenCode reads are skipped; baseline/last-batch diagnostics remain deferred to overshoot research. Spawn provenance, child lineage/generation and original-prompt capture remain deferred.

## Acceptance

- OpenCode child tool replies instruct exact final-message delivery of the continuation text.
- Shared continuation replies state logical replacement/count-limit semantics and permit progress-stall/growing-work check-ins; OpenCode child successors load by predecessor reader reference, not pasted full handovers.
- Shared child guidance permits the handover in read-only tasks and replaces this session's final report without contradicting Claude's required native handback.
- Stage leads and locked-child refusal remain unchanged; tests cover both adapters' shared guidance and preserve Claude-specific continuation/delivery.
- Typecheck, full tests, plugin validation and independent semantic review pass; evidence remains distinct from live compliance.

## Approach and bounded units

1. Implement compact guidance changes, regression tests and README alignment.
2. Inspect the diff; record approved decisions and update the adapter checklist.
3. Independently review source, tests and documentation; resolve findings, verify and archive this note.

## Current evidence

- Initial repository state was clean at `01da803`.
- Shared continuation construction is currently used only by OpenCode; Claude composes its own short/locked replies and imports shared child nudge guidance.
- The supplied OpenCode delivery contract says native parents receive the child's latest completed assistant text, not its handover tool result. Delivery instructions remain advisory; this change does not add interception or a stop hook.

## Implementation and verification

- OpenCode initial child replies now carry a one-sentence exact-final-message wrapper and reference-only successor prompt guidance, logical replacement/count semantics and a progress-check-in exception. The child-labelled tool-description appendix matches these defaults.
- Shared child nudges replace this session's final report and explicitly permit pre-storage handover calls under read-only instructions. Claude's native handback, marker/full-reader flow and introduction remain unchanged.
- Integration inspection caught an omitted parent readback step in the initial wording; restored parent full read before spawning, with regression assertions for both reader calls and their order. Exact locked-child text is pinned alongside the unchanged root-stage fixtures.
- README, adapter checklist and the text-only parity decision record distinguish text guidance from mechanisms. Locked-child refusals intentionally retain their earlier full-seed wording; root seeds still embed the full handover.
- Direct verification: `npm run typecheck` passed both adapters; `npm test` passed 342 tests in 44 suites, zero failures; `claude plugin validate .` passed with existing missing-author warnings, directory-icon warning and marketplace-install advice; `git diff --check` passed.
- Independent semantic review found no blockers and independently reran typecheck, all 342 tests, plugin validation and the whitespace check successfully. It confirmed both adapters' rule preservation and the intentionally unchanged locked-child wording. Clarified README's reply-content shorthand and initial-continuation scope; the review's temporary dangling archive link is resolved by archiving this note.
- Complete: no unresolved findings or new product decisions. No new live final-message delivery or successor-compliance evidence is claimed.
