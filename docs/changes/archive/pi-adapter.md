# Pi root-session adapter

## Goal and scope

Ship a small root-session Pi extension: host context estimates, trusted
pre-prompt workflow guidance, staged advisory notices, model-written durable
handovers and command-driven fresh-session continuation. Preserve existing
OpenCode/Claude behavior and native Pi compaction. No subagent integration,
automatic event-driven session replacement or hard gate in this MVP.

## Acceptance

- Assess all twelve adapter requirements against pinned primary docs/source,
  shipped types and isolated non-model CLI observations.
- No build step; document local Pi installation and manual rollover clearly.
- Fake ExtensionAPI tests cover thresholds, unknown usage, verbatim persistence,
  reload, cancellation/errors and replacement-context seeding.
- Typecheck, complete unit suite, Claude plugin validation and isolated Pi
  extension load/registration checks pass.
- Independent review resolved; outcome and evidence archived here.

## Approach and bounded units

1. Capability investigation: npm Pi 0.73.1, pi-mono commit
   `781152fc24841dc54b22284514604048ebe5e2c9`.
2. Implement root extension and fixtures, reusing dependency-free shared text
   and threshold logic; register `context_handover` and `/handover`.
3. Document assessment, installation, requirements mapping and tentative
   adapter decisions; verify and independently review.

## Material findings

- Session replacement is command-context-only. A stored handover can seed a
  new session through `newSession` setup and a fresh `withSession` context.
- The documented tool-to-command `sendUserMessage` example is not executable
  command dispatch in this pinned release: extension-origin messages disable
  slash-command expansion. Source and an isolated command probe agree.
  Therefore rollover needs an actual user command; do not queue a literal
  slash command and claim automatic continuation.
- Pi has no core subagent primitive; child-specific requirements are n/a,
  not claimed as implemented.

## Shipped design and decisions

- `pi/index.ts` registers direct handover/read tools, a root-oriented intro,
  transient stage notices, `--handover-soft` and `/handover`; the root package
  manifest discovers it without a build. Existing adapters are unchanged.
- Host `getContextUsage` drives the shared stages. Integer soft defaults to
  150000 capped at 70% of a known window; explicit percentages stay uncapped.
  Unknown usage fails open. Invalid flags report an error and disable notices.
- Session custom entries retain model text and summary verbatim. Reader scope
  is current-branch-only; newest malformed payloads never replay older text.
  Pi owns retention; ephemeral and nontransactional persistence are explicit.
- Command rollover waits for idle before reading current state, seeds full text
  once and initiates continuation through only the fresh replacement context.
  Cancellation and uncertain post-teardown failure have distinct guidance.
- Six ordinary product decisions are recorded explicitly as tentative in
  `docs/decisions.md#pi-root-session-mvp-2026-10-28`. No principle changes.

## Review and resolution

- Independent review found a stale-snapshot race: commands can arrive during
  streaming, so reading before `waitForIdle` could select an old handover or
  reject one not yet stored. Fixed by reading only after idle; fixtures cover
  missing-to-stored, older-to-newer and failed waits.
- Resolved silent invalid-flag fallback with explicit error/no substitution;
  tightened current-step/intro references, host-authored provenance and
  post-teardown outcome wording. Added newest-invalid refusal coverage.
- Re-review accepted all code resolutions and found no remaining code defects
  or documentation overclaims; its remaining stale-note finding is closed by
  this archived outcome update.

## Verification and outcome

- `npm run typecheck`: three projects, exit 0.
- `npm test`: 370 passed, 0 failed; 28 Pi fixtures. These cover registration,
  usage/threshold unknowns and stages, verbatim payloads/reload/active branches,
  invalid input/storage errors, idle ordering, cancellation, setup errors and
  fresh-context-only continuation.
- Isolated Pi 0.73.1: local `install` and `list` succeeded; package discovery
  and explicit `-e` loading both worked. `--help` exposed `--handover-soft`;
  an actual model-free observer command saw `context_handover`, `read_handover`
  and `/handover`. All checks exited 0 with no extension-load errors.
- Claude plugin validation passed with attribution/icon warnings and no errors.
  `git diff --check` passed. `npm pack --dry-run --json` includes the Pi entry
  and manifest plus required shared sources.
- Pinned primary-source capability table, exact portable commands, version
  correction, storage/lifecycle limitations and subagent-extension candidates:
  `docs/research/pi.md`. README installation and `docs/adapters.md` updated.
- No model compliance, live handover authorship, precise host model retention
  or end-to-end rollover is established. Manual command initiation is the
  supported boundary, not automated threshold-driven session replacement.
