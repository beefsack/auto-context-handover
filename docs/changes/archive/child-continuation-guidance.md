# Child continuation guidance

## Goal and scope

- Make child context handovers in both adapters default to successor continuation, while preserving the parent's ability to redirect or escalate genuine user-owned decisions.
- Short replies identify incomplete work, give the exact adapter reader call, and prescribe a same-agent-type successor seeded with the original task pointer, full handover and instruction to continue from section 6.
- Child nudges, tool descriptions and post-handover text describe rollover rather than task completion; require summaries to start with `Context handover (incomplete):`.
- Share dependency-free guidance in `source/shared/` where sensible. Root rollover behavior is unchanged except for the shared section 6 rule.
- Out of scope: successor-chain guards, lifecycle/storage changes and backlog edits. Bounding unproductive child-successor chains follows this change.

## Acceptance

- Both adapters prescribe continuation by default without guaranteeing it or overriding parent judgment.
- Context limits and remaining volume are not user questions. Section 6 contains directly executable successor steps; escalation is limited to user-owned decisions independent of context size.
- Claude uses `mcp__auto-context-handover__read_handover` with `childId`; OpenCode uses `read_handover` with `sessionID`.
- Short replies remain compact for native classifier-reviewed handback. Existing exports and root behavior remain compatible.
- Unit regression coverage in both adapters, typecheck, full tests and Claude plugin validation pass; independent review has no unresolved blocking findings.

## Approach and bounded units

1. Update shared and adapter-facing guidance plus targeted unit tests.
2. Inspect the diff and run typecheck, tests and plugin validation.
3. Independently review public text contracts and regressions; resolve concrete findings.
4. Promote the authorized decision and archive this note with evidence.

## Evidence and material decision

- User-approved scope (2026-10-28): parent continuation is the default; parent redirection remains allowed. Context size alone never creates a user-owned decision.
- External Claude parent live-test report: child nudge, stored handover and native handback succeeded, but the parent did not read or continue. Existing reply lacked a continuation default and the child framed context volume as a pending user decision. These are reported observations, not new verification by this change.
- No live continuation evidence is claimed by this guidance change.

## Outcome and verification

- Implemented shared child rollover guidance, status-prefix handling and compact successor-reply construction in `source/shared/handover-text.ts`. Adapter-specific wrappers supply exact reader calls; the full handover and stored summary remain unmodified.
- Claude child nudges/descriptions/post-handover guidance now distinguish rollover from completion; native classifier-reviewed handback forwarding is unchanged. Existing stored child replies are not migrated.
- OpenCode adds child-only staged nudges and hard directives, selected using the existing real-child criterion (`parentID`) after the threshold is reached. Root nudge and hard-directive output is byte-identical; unreadable identity falls back to the existing root text. Existing exports remain available.
- Regression coverage exercises both adapters' short replies, exact reader arguments, prefix-once behavior, executable section 6, child framing and unchanged root guidance. Initial assertion mismatches were corrected; no unresolved acceptance failure remains.
- Direct verification: `npm run typecheck` passed; `npm test` passed 201 tests; `claude plugin validate .` passed with existing author/icon warnings and installation advice; `git diff --check` passed.
- Independent review inspected the implementation and regression tests, reran typecheck/tests/diff checks and reported no blocking findings. A final test-only correction directly exercises an already-prefixed OpenCode summary rather than testing a refused duplicate handover.
- Decision promoted to `docs/decisions.md`. Remaining risks: continuation guidance is advisory, real parent successor spawning is not verified here, and child-successor chains remain unbounded until the separate chain-guard change.
