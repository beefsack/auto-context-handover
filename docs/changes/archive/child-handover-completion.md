# Child handover completion

## Goal and scope

- Preserve the OpenCode child's summary-bearing continuation reply during the handover turn; apply locked refusal guidance only to later input.
- Keep tools gated immediately after storage and preserve root rotation, hard ceiling and loop guard behavior.
- Align locked-child guidance with reader-reference continuation. Inspect Claude delivery for the same defect; change its behavior only if that defect exists.
- No new continuation automation, provenance capture or configuration.

## Acceptance

- Lifecycle regression covers handover storage, the next context request and final reply, retaining summary and recorded model/effort.
- Later input still receives locked-child refusal; tools remain gated in both phases.
- Terminal, failed/interrupted, missing or unrecognized anchor state closes the reply turn; only recognized continuing assistant states allow the initial summary.
- Locked guidance prescribes successor readback, not parent-pasted full text.
- Typecheck and full tests pass; live evidence and fixture evidence remain distinct.

## Approach

1. Confirm request/turn identity and the immediate-lock cause; implement the smallest phase distinction and regression coverage.
2. Review the actual diff and Claude flow; verify and record outcome.

## Evidence

- Starting tree clean. Prior investigation reports two OpenCode 2.2.5 child handovers completed storage but delivered a generic locked reply instead of the summary; not independently reproduced here.
- Existing parity record explicitly left locked replies unchanged, including historical full-seed wording; this fix supersedes that narrow exception.

## Implementation and verification

- Persists the handover tool's assistant message ID and preserves the stored continuation only while that anchor and subsequent history are error-free assistant steps with `tool-calls` or `length` finishes. Terminal, unknown, missing, unreadable or compacted state and later input select refusal; tools stay gated in either phase. Root behavior is unchanged.
- Retained message-ID detection rather than a request latch: multiple post-tool requests must remain eligible, and persisted completion state must close the turn across reloads. Latest-user matching alone cannot distinguish completed-turn resumption.
- Review rejected the first latest-user-ID approach for summary replay after completion. The assistant-anchor correction initially missed the anchor's own terminal/error state; explicit conservative handling and regressions now address that finding. No failed semantic approach remains accepted as correct.
- Lifecycle fixture covers tool write/result, repeated post-tool hooks, summary/model/effort preservation, final assistant stop, resumed context and new user input. Additional cases cover terminal/error, interrupted continuing finish, absent and unrecognized finish on both anchor and following assistant messages. These establish hook guidance, not actual model delivery.
- Implementation-reported red/green: the new failure-state regression failed on `anchor stop` before the fix and passed afterward. Direct final verification: `npm run typecheck` passed; `npm test` passed 765 tests in 140 suites, zero failures; `git diff --check` passed.
- Independent semantic review cleared the anchor-state finding, confirmed immediate gating and unchanged root behavior in the diff, and found no remaining code blocker. Review did not rerun tests or establish live delivery.
- Claude uses a separate turn-aware native-handback flow and already uses reference-based locked guidance; no matching overwrite was found and no Claude behavior was changed. The OpenCode shared helper now also prescribes reader-reference seeding.
- Host ordering evidence inspected is from the previously assessed OpenCode 2.1.4 source; installed 2.2.5 types confirm assistant IDs, finish and error fields but do not establish current runtime ordering. No live run: loading edited source was not established. Live delivery remains unverified until host restart and a retest exercising the new source.

## Outcome

- Complete and archived: conservative completion-phase handling, reference-only locked guidance and lifecycle regressions accepted. No unresolved implementation finding; live delivery remains unverified as described above.
