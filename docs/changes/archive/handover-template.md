# Handover template audit gaps

- Goal: improve the active model's concise handover instructions, preserving the six-section structure and custom `handoverDescription` replacement.
- Scope: default tool-description text, directly relevant tests, and the template decision in `docs/decisions.md`. No seed/runtime metadata generation, tool/project rename, commits, or pushes.
- Acceptance: verbatim critical instructions or verified reload paths; runtime controls; explicit vs implicit/adopted decisions; verification provenance; continuation/compaction and predecessor chain; durable references over trivia without losing risks or verification distinctions.
- Plan: bounded Worker edits the template and description regression tests; Lead reviews actual changes, verifies typecheck/tests, updates the durable decision, and archives this note.
- Baseline: `HANDOVER_DESCRIPTION` is 1193 characters, including a 426-character section block. `source/index.ts:120` selects the custom description with `??`; no additional template carrier exists.
- Verification: `npm run typecheck`, `npm test`, exact character counts, and diff inspection. Live model behavior is reserved for the user and remains unverified.
- Initial state: all project paths are untracked user work; preserve unrelated contents and do not alter the index.
- Outcome: updated `source/text.ts` and `docs/decisions.md:9`; added three actual-registration tests in `source/gate.test.ts` for the default, custom text, and empty-string replacement. The existing opening, operational policy, six sections, `??` replacement, seed construction, and runtime behavior are unchanged.
- Accepted evidence: Lead inspected final template and test hunks, then directly ran `npm run typecheck` (pass), `npm test` (77 passed, 0 failed), and character/ASCII checks. Full description: 1193 -> 1946 characters (+753); six-section block: 426 -> 957. New lean guidance accounts for another 222 characters including separation. Template has zero non-ASCII characters. A tracked diff is unavailable because the project files were already untracked.
- Worker provenance: worker `ses_e83e92498ffejq0TSznB2pT0La` reported the same passing checks and a repaired intermediate test-header edit; Lead inspected the restored header and independently reran acceptance checks. No semantic failed approach or unresolved correction remains.
- Deliberately excluded: automatic runtime metadata headers, separate summarizers/mechanical extraction, behavior enforcement, extra sections, renames, and changes to custom-template replacement.
- Unverified: real model compliance, resulting handover length, and end-to-end live rollover with these instructions; user will observe live behavior. No live model call, commit, push, or index mutation performed.
- Next action: none for implementation; parent can mark the template change complete and return the full template plus evidence. No backlog file edited by this Lead.
