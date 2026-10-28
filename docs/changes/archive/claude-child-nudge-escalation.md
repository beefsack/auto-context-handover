# Claude child nudge escalation

## Goal and scope

- Make Claude child context notices self-sufficient before deferred tool loading: exact handover tool and ToolSearch selector, intact parent readback and successor continuation, final-report precedence, current-step boundary, and plugin-storage permission under read-only tasks.
- Reuse dependency-free OpenCode warn1/warn2/final text and stage boundaries (soft, soft*1.1, soft*1.2) without changing OpenCode-visible text or behavior.
- Remove verified-unused `buildChildGateDeny` and `buildLockedFinalReply` exports; use the Claude reader-name constant consistently.
- No new enforcement, root Claude behavior, principle changes, or lifecycle/storage redesign.

## Acceptance

- Claude notices carry all deferred-tool essentials at every stage and escalate at the shared boundaries.
- Both adapters' affected paths have unit regression coverage; OpenCode text remains byte-identical.
- Typecheck, full unit tests and Claude plugin validation pass; independent review has no unresolved blockers.
- Replace the stable-nudge MVP choice in decisions with staged escalation and its content rationale.

## Approach and bounded units

1. Implement shared stage text, Claude self-sufficient notices, cleanup and regression tests.
2. Inspect the actual diff and run typecheck, full tests and plugin validation.
3. Independently review public text contracts, adapter isolation, boundary behavior and cleanup; resolve concrete findings.
4. Update durable decisions and archive this note with accepted evidence.

## Evidence and material decision

- User-approved scope replaces the original one-stable-nudge adapter choice with shared staged escalation; hard enforcement remains undecided.
- External second live-test report observed ten identical notices, no ToolSearch or handover call, and full-report return. The child stated that a short reply would lose its report. Deferred-tool description invisibility, task-output conflict and ambiguous unit boundaries motivate self-sufficient notice content. This is reported evidence, not direct verification here.
- Existing uncommitted adapter work is the baseline and must remain intact.

## Outcome and verification

- Extracted byte-identical OpenCode warn1/warn2/final leads into `source/shared/handover-text.ts`; the Claude batch hook selects the corresponding notice at soft, soft*1.1 and soft*1.2. Shared boundary tests pin parity with OpenCode defaults; OpenCode still supports its existing custom stage offsets and hard limit unchanged.
- Every Claude stage adds exact deferred-tool loading/schema guidance, final-report precedence, the current-step boundary, read-only plugin-storage permission, intact parent readback, and existing incomplete/successor guidance. Root Claude behavior and post-handover lifecycle are unchanged. README and manifests describe escalation.
- Removed `buildChildGateDeny` and `buildLockedFinalReply` after verifying no TypeScript references remain; Claude reply builders now use `READ_FULL`. No remaining imported source export was removed.
- Added four tests (230 total): per-stage essentials, staged leads, adapter boundary sweep and shared OpenCode parity. Existing OpenCode literal-output regression tests pass unchanged. No OpenCode-visible text change is introduced by this unit.
- Direct verification: `npm run typecheck` passed; `npm test` passed all 230 tests with zero failures; `claude plugin validate .` passed with existing author/icon warnings and install-line advice; `git diff --check` passed.
- Independent review inspected source, tests and adapter isolation, reran typecheck/tests/plugin validation, and found no blockers. The review accepted retaining the existing Claude diagnostics header (`stage=unknown`) as a documented scope-preserving limitation; notice selection does not change stored diagnostics.
- Durable decisions updated. Remaining risks: advisory notices can still be ignored; text-only work receives no batch notice; real deferred loading/compliance and parent successor continuation are not verified by unit fixtures. No new live integration evidence is claimed.

## Retest shape

- Set soft to 50000 outside the task prompt and choose a read-only audit workload estimated at several times that size (at least 200000 tokens across inputs and outputs), not a review that fits comfortably in one window.
- Give the child only the audit goal, explicit corpus, sequential full-read method and final deliverable. Include no handover, context-limit, rollover or successor hints. Observe exact stage notices, ToolSearch loading, storage, intact parent readback and default successor continuation independently of the child task instructions.
