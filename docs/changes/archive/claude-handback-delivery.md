# Claude handback delivery

## Goal and scope

- Prevent a stored child handover from being silently discarded as an undelivered plain-text final.
- Make native SubagentHandback delivery explicit in child guidance and tool results, correct an undelivered stop once per turn, expose persisted delivery diagnostics, and provide verbatim successor seeds plus parent recovery guidance.
- Keep Claude roots context-only, preserve native handback review, and leave OpenCode behavior/text, teammates, thresholds, chain growth and principles unchanged.

## Acceptance

- Confirm the host delivery contract from public documentation/types before changing stop handling; preserve bounded fail-open behavior if the contract is incomplete.
- Closed children with no delivered handback receive a once-per-turn correction to call SubagentHandback, including when their final text matches the short/locked reply.
- Child text mandates handback when available; plain text is an explicit absent-tool last resort. Tool results address the child before the retained parent short reply.
- Parent context prescribes readback before messaging/resuming an undelivered child, never resuming a handed-over child, and verbatim successor seeds. Readback preserves full handover text and shows delivery yes/no/unknown.
- Regression tests, typecheck, full unit tests and plugin validation pass; independent review has no blockers. README and durable decisions match behavior.

## Approach

1. Investigate delivery contracts and implement the bounded adapter changes with regression tests.
2. Inspect source and evidence, reconcile documentation and decisions, and verify required checks.
3. Independently review public contracts, stop behavior, delivery diagnostics and adapter isolation.
4. Record final evidence, risks and retest steps, then archive this note.

## Evidence and decisions

- Supplied live report: first child rollover reached its parent through native handback and continued with the recorded type/model; a successor stored its handover but never called SubagentHandback. The host reported that unsent final text was not shown. The parent followed generic messaging advice, resumed the locked child and received no report.
- The report also observed parent paraphrasing that dropped native-handback instructions. This is reported evidence, not a reproduction.
- Selected changes cover child delivery guidance, stop correction, context-only parent fallback, ready-to-paste seeds and persisted delivery status. Root tool refusal is explicitly excluded.
- Contract evidence: official [tools reference](https://code.claude.com/docs/en/tools-reference), `SubagentHandback`, documents report delivery and pre-delivery classifier review, only for eligible local non-fork children in auto mode. [Canonical mod types](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts), `ClassicResultOf` and `SubagentStopHookInput`, expose stop correction and final-text observation, not report replacement. They do not explicitly guarantee plain-final dropping. Use the supplied report for that observation and retain a once-per-turn fail-open correction rather than infer a universal contract.
- Readback carries the handover only inside the successor seed, avoiding a doubled full-body read. Delivery status means observed native tool success (no denial/error), not independent receipt. Failed status persistence can leave stale `no`; current-turn observation remains in memory and reload can cause an extra bounded correction.

## Outcome and verification

- Completed child-addressed stored results, mandatory native-handback guidance (including locked-work refusal), once-per-turn stop correction, persisted delivery diagnostics, root recovery context and verbatim successor seeds. Implementation changes are confined to `hooks/child.ts`, `hooks/register.ts` and `hooks/register.test.ts`; README and durable decisions describe the contract and its uncertainty. No OpenCode-visible text/behavior changed and no source export was removed or renamed by this change.
- Direct verification after final source changes: `npm run typecheck` passed both projects; `npm test` passed 271 tests in 37 suites, zero failures (ten tests net added). `claude plugin validate .` passed with existing author/icon warnings and marketplace-install advice; `git diff --check` passed.
- Independent read-only review inspected source, tests, public text, root/teammate boundaries, native result preservation, bounded correction, exact once-only seed body, legacy/reload/outage diagnostics and docs. It reran typecheck, all 271 tests and diff checks and found no blockers. Plugin validation was directly verified separately.
- Complete. Reported live failures motivated this change; current verification is unit/contract validation, not a new integration reproduction.
- Text follow-up: replace the seed's nested provenance sentence with direct agent-type/model-override labels and quote both root-introduction reply markers. Known override, observed absence and unknown provenance retain their meanings; seed body and delivery behavior are unchanged.
- Follow-up direct verification: `npm run typecheck` passed both projects; `npm test` passed 272 tests in 37 suites, zero failures; `claude plugin validate .` passed with existing warnings/advice; `git diff --check` passed.

## Remaining risks and retest

- Guidance can still be ignored and native classifier review can withhold a report. Official docs do not establish universal plain-final dropping. The absent-tool fallback may receive one futile correction but cannot loop indefinitely within the turn. Reload can cause one extra correction; failed status writes can leave stale diagnostics. Delivery status is observation, not a parent-receipt guarantee.
- Follow README's Claude parent-continuation retest with enough sequential read-only work for at least two rollovers. Verify storage followed by native handback each time, delivery diagnostics, parent read-before-decision, same-type/model replacement and verbatim successor seeds. Exercise missing handback in an isolated fixture and confirm one correction plus read-before-message parent recovery, never resuming a closed child. Check absent-tool fallback and unchanged root measurement/compaction.
