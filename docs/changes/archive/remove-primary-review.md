# Remove interactive primary handover

## Goal and acceptance

- Remove the interactive primary handover action, persisted pause state, review hook, and readback status. Accept only `new-session` and `lock`; reject removed values as unsupported setup errors.
- Restore the experimental loop guard's lock fallback after three unproductive successors, without changing measurement or productivity rules.
- Preserve lock, hard ceiling, new-session, child return, and the per-child soft marker.
- Archive the same-child reset investigation and record its shelving and the follow-rollover-only TUI scope in decisions.
- Verify typecheck, the full unit suite, targeted fallback/failure regressions, and a source/reference scan.

## Approach

1. Remove the interactive path and adjust focused tests, preserving the existing lock error handling.
2. Reconcile README and durable decisions; archive the reset investigation without losing findings.
3. Inspect the diff, independently review the changed public contract and stop behavior, and verify acceptance.

## Verification and outcome

- Removed the interactive action, state, hook, readback status, and helpers; restored lock fallback without changing loop accounting. Preserved the existing child marker/return, hard gate, links, and rollover paths.
- Archived the reset investigation with all mechanism findings and the shelving rationale. README and decisions describe the supported actions and follow-only companion scope.
- `npm run typecheck`, `npm test` (110 passed, 0 failed), and `git diff --check` pass. A direct parser assertion confirms the removed primary value rejects setup with the supported values.
- Independent review found no blocking defects. Old pause KV records are intentionally no longer read or maintained; stored handovers remain readable. No migration was introduced.
- Case-insensitive scans find no removed-action references outside change archives, excluding the preserved backlog and historical prior-art research. Neither excluded record describes supported plugin behavior.
- No new isolated live root loop-guard run: the restored fallback has unit evidence only. No live plugin behavior was exercised for this change.
