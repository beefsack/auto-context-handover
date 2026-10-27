# Draft handover

## Goal and scope

- Support `onHandover.primary: "draft"`: preserve the session model's handover for user review, without creating or starting a successor.
- Use draft instead of lock when the experimental loop guard trips.
- Keep automatic new-session and lock behavior, and subagent return behavior unchanged. Subagent reset and UI companions are out of scope.

## Approach and decisions

- Use the existing tool surface, not a new UI: pause the source with a persistent draft marker, retain only `read_handover` for review, and direct the user to open a fresh session and explicitly request readback/continuation if desired.
- Draft is not a lock: users may inspect and discuss the stored text in the source, but model-facing guidance prohibits continuing the task there. Repeated handover calls cannot overwrite a pending draft.
- Manual continuation does not create automatic chain links or carry identity; the user chooses the new session. A later companion can improve review/navigation.
- OpenCode 2.1.4 source (`19d87a7`): server tool registration supports direct tool results (`packages/plugin/src/promise/tool.ts`); commands are void callbacks (`packages/plugin/src/promise/command.ts:7-26`). `synthetic(resume:false)` does not wake execution (`packages/core/src/session/session.ts:286-328`), and pending synthetic text is not rendered as a delivered message (`packages/core/src/session/projector.ts:672-717`). A command-only review cannot provide a visible model-free review message; no such command is added.

## Acceptance and bounded work

1. Add validated primary draft configuration, persistent pending-draft storage/cleanup, review-only context guidance, and loop-guard draft fallback; targeted regression tests.
2. Independently review behavior and failure paths; resolve concrete findings.
3. Update README and durable decisions; run typecheck, full unit suite, and isolated live checks for explicit draft, review, and loop fallback.

## Verification and outcome

- Implemented primary draft config, persistent review-only pause/cleanup, readback status, overwrite refusal, and loop-guard draft fallback. Existing rotation and lock paths are unchanged; child-under-draft regression confirms parent return still wins.
- Review found missing child-under-draft coverage and stale config/helper wording; corrected all three. No unresolved correctness findings.
- Direct final verification: `npm run typecheck`, `npm test` (90/90), and `git diff --check` pass. Tests cover review above hard, reload/config-change persistence, marker failures, strict read failures, loop-state warning, and cleanup.
- Accepted isolated live draft: `ses_e837d741effeUKOhnktVKlT1Iy` stored text without a successor; follow-up read it verbatim and declined a separate task. Post-plugin observer recorded only `read_handover` after the pause. Explicit fresh-session continuation `ses_e837c6c28ffeczhzKy8kjpmRQU` read the source and returned the requested sentinel without automatic links. A preceding tiny-threshold continuation nudged immediately after readback; the accepted continuation used a larger soft threshold.
- Accepted isolated loop chain: `ses_e837c0dddffeNW746sThEGlLCu` -> `ses_e837bd1a8ffeVlMeuUnUOocH6x` -> `ses_e837b6d24ffemX7mdSXS8qMr7f` -> `ses_e837b3145ffeXpngRhHmbES8DV`. The final handover reported draft pause; follow-up readback retained the predecessor and draft status, with only `read_handover` exposed. Session listing confirmed exactly four roots, no fourth successor. Raw tool results and observer logs were inspected directly.
- README config/reference/manual checks and durable decisions updated. Existing backlog edits preserved without further changes.
- Not live-tested: review above hard, reload persistence, cleanup, child-under-draft behavior, productive streak reset, nondefault variants, and compaction readback. Relevant harness coverage passes. Editable review and explicit continuation/navigation remain companion follow-ups; no new UI or command was introduced.
