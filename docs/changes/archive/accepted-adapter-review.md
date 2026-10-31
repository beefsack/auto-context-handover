# Accepted adapter review

## Goal and scope

Apply the completed review of all 57 tentative adapter decisions. Preserve accepted behavior except the requested popularity eligibility/priority, latest-version policy and HOME-based AiderDesk storage. Antigravity remains unchanged apart from acceptance markers; backlog maintenance is outside this change.

## Acceptance

- No pending-review markers remain; assessed versions remain evidence, not exact support pins.
- Future adapter eligibility requires baseline popularity with the threshold pending further research and user selection; historical assessment order is not future priority.
- Harness dependencies and installation instructions use latest versions or major/major.minor ranges, never patch pins. Refresh the npm lockfile.
- Verify AiderDesk extension filesystem access from assessed source before moving storage. If unrestricted, use private HOME storage without project collisions, preserving first-writer atomic publication and current-project loaded-task reader scope.
- Preserve honest confidence limits for estimators and experimental/undocumented surfaces.
- Typecheck, full unit suite, relevant Python tests and diff privacy scan pass; no model runs are needed.

## Approach

1. Verify and implement AiderDesk storage with regression coverage and point-of-use documentation.
2. Relax harness version specifications and refresh dependencies; verify compatibility without extensive adapter rework.
3. Accept and revise durable decisions and reconcile documentation.
4. Independently review storage/security and public-contract changes, run final gates, and archive this note with evidence.

## Material decisions and evidence

- User accepted all previously tentative entries, subject to the revisions above.
- Latest harness releases are targeted with accepted breakage risk; any necessary constraint must stop at major or major.minor precision.
- Unverified measurement or unstable host-surface confidence may come from experiments, unofficial documentation or prior art; this does not establish live compliance.
- Assessed AiderDesk source permits external filesystem writes: `src/main/extensions/extension-loader.ts:17-24,44` uses ordinary jiti without a filesystem sandbox; `packages/extensions/extensions/verifier/index.ts:69,95` constructs and writes extension-local `config.json`. Storage now hashes NUL-separated host project identity and task id under HOME; physical retention does not guarantee readback after project relocation. Existing project-local records are not migrated.
- Refreshing OpenCode to 2.2.0 failed typecheck at `source/index.ts:7`: `@opencode/ai` no longer exports `Message`. The allowed major.minor range `~2.1` restores compatibility without adapter rework. Other harness type dependencies use broad major ranges; Amp's prerelease-only package uses unpinned `*`.
- npm's Kilo latest tag resolves 7.8.18 rather than the assessed 7.8.23. Typecheck and fixtures pass on the resolved types; host-loading evidence remains specific to the assessed release. OpenHands `>=1,<2` resolves SDK 1.59.0 and passes its Python suite.
- Integration inspection found Crush's exact runtime version gate. It now accepts stable major-0 releases while retaining nightly rejection, explicit server/workspace/root checks and capability binding. Three regression tests cover stable updates and rejected versions.

## Outcome

- All 57 pending-review markers removed; popularity eligibility/priority, latest-version policy and confidence limits are durable decisions. Antigravity behavior is unchanged.
- AiderDesk HOME storage preserves immutable verbatim first-writer atomic publication, current-project loaded-task reader scope and 0700/0600. Tests cover no project writes, identical task ids across projects, permissions, readback and concurrent publication. Independent review found no blocking storage/security or version-guard issues.
- Final `npm run typecheck`: all 12 projects pass. Final `npm test`: 760 pass, 0 fail (140 suites). Focused AiderDesk/Crush suites: 93 pass, 0 fail (29 AiderDesk, 64 Crush).
- `PYTHONPATH=openhands python openhands/test_handover_adapter.py` against installed SDK 1.59.0: 26 pass, 0 fail. Historical assessment evidence remains distinct from new fixture verification; no model compliance claim is added.
- `git diff --check` passes. Added-diff scan finds no local-machine paths or identifiers. Installation commands use latest releases; exact assessment versions/commits remain evidence.
- No implementation decision remains pending. Popularity threshold selection follows the separate ranking research.
