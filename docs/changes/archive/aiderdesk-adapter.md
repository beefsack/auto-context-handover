# AiderDesk adapter

## Goal and scope

Assess the pinned AiderDesk extension contracts against `docs/adapters.md`, then
ship the smallest useful adapter if measurement, model-written handover and
continuation are supported. Preserve existing adapters and native compaction.

## Acceptance and approach

- Establish primary-source capabilities, caveats and reproducible non-model evidence.
- If feasible, implement a directly loadable extension, shared guidance/thresholds
  where useful, fake-API tests and installation instructions.
- Verify real types, typecheck, full tests and existing Claude plugin validation.
- Independently review public lifecycle/storage contracts and resolve findings.
- Update the requirements checklist and tentative decisions; archive this note.

## Completed units and scope

1. Pinned-source capability investigation, including built-in handoff interaction.
2. Bounded implementation and fixture verification if prerequisites hold.
3. Independent review, final verification and concise documentation.

Pinned investigation establishes directly loaded TypeScript tools, per-step
message transformation, a host estimator and task creation/prompt APIs. Native
handoff uses a separate generation call, so it will not author our handover.

Accepted scope: root Agent-mode advisory/storage MVP, excluding native subagents
and compaction modes. Store verbatim model tool input in working-directory
plugin files scoped by task-id hash. Manual continuation through a new task's
reader reference; no automatic create/run, lock, token gate, native-compaction
changes or UI following. Tentative decisions are in `docs/decisions.md`.

## Review and contract resolutions

- Independent review corrected nonexclusive first-writer publication,
  post-creation claiming, reload-before-finish loss and false admission claims.
  A later real-loader check rejected symlink installation; the forwarding
  entry is verified instead. Host-provided Zod schemas load correctly. The
  continuation claim/outcome machinery was subsequently removed with rollover.
- Final contract inspection found `TaskContext.getTaskDir()`
  returns the working directory, not task-private storage
  (`packages/common/src/extensions.ts:935-941`, `task.ts:769-770` at the pin).
  The first implementation collided across tasks sharing a directory. Fixed
  with sha256(taskId) scopes and shared-directory/different-id regression tests;
  no unsupported task-deletion cleanup claim remains.
- Fresh-task initialization: `createNewTask` only prepares task
  data, while native handoff explicitly calls `newTask.init()` before running.
  `TaskContext` has no exposed `init`; wrappers also do not initialize. No safe
  public background initializer was established. Automatic rollover was removed,
  not left behind a speculative flag; fixtures now forbid task creation/prompting
  including after reload. Manual continuation is explicitly unverified.

## Final verification

- Final independent review checked real shared-directory, initialization,
  reader, loader/schema, event and retention contracts: no concrete findings.
  The concurrent-store fixture was additionally strengthened to use two
  independent extension instances and assert one coherent winning body/summary.
- `node --test "aiderdesk/**/*.test.ts"`: 27 passed, 6 suites, no failures.
  Covers real-filesystem storage, first-writer concurrency, same-working-directory
  task isolation, reload/readback, configuration, measurement/stages, root-only
  registration and absence of automatic create/prompt effects.
- `npm run typecheck`: passed all seven projects against shipped extension types.
- `npm test`: 570 passed, 91 suites, no failures/skips/cancellations.
- `claude plugin validate .` with isolated configuration: passed with existing
  author/icon warnings; no plugin validation errors.
- Executed the reproducible research checks: npm metadata and extension CLI
  version `0.39.0`, CLI help, isolated `jiti@2.6.1` install, actual pinned
  `ExtensionLoader.loadExtension` using a real forwarding entry. On-load and
  both real Zod tool schemas returned `STUB-SMOKE-PASS`; logger stubbed, no
  Electron/full-host/model execution. `git diff --check` passed.
- README, twelve-row requirements checklist, assessment and four tentative
  decisions describe manual-only scope and explicit retention/verification limits.

## Outcome

Complete within advisory/storage-only scope. Automatic rollover is deferred
until safe public fresh-task initialization is established. Manual continuation,
real approvals, model compliance and native-compaction interaction remain
unverified; no end-to-end continuation claim is made.
