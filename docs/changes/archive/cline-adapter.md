# Cline CLI/SDK adapter

## Goal and scope

Verify a pinned hook-bearing Cline plugin surface and ship the smallest honest
measured, model-authored handover adapter. Preserve existing adapters and native
compaction; prefer direct loading and shared guidance over a build step.

## Acceptance and approach

- Establish measurement, injection, tools, storage, continuation and child
  capabilities from primary documentation and shipped types/source.
- Implement only supported behavior, with fake-API real-filesystem fixtures and
  real-package typechecking; document installation and limitations.
- Run non-model load checks where supported, full typecheck/tests and existing
  Claude plugin validation; independently review public/storage contracts.
- Update adapter checklist, concise research and tentative decisions; archive
  this note with accepted evidence and outcome.

## Units

1. Pin CLI/SDK packages and establish the concrete adapter contract.
2. Implement adapter and focused fixtures against that contract.
3. Independent review, integration verification and concise documentation.

## Accepted scope and pin

Registry metadata pins official CLI `cline@3.0.74`, whose SDK/core/shared
dependencies are all `0.2.0`. The first probe used legacy `@cline/cli`/`clite`;
that package is not the official documented CLI and its missing plugin command
is irrelevant. Official CLI local single-file install/load/uninstall succeeded.
Target the hook-bearing `AgentPlugin`, not Agent Plugins v1. Direct TypeScript
loading uses the real jiti-backed loader; repository package installation needs
the `cline.plugins` manifest so shared imports are retained.

Accepted MVP direction: root-only advisory/storage with full-request chars/4
measurement at `beforeModel`, introduction through `beforeRun.appendContext`,
direct tools and manual fresh-session reader-reference continuation. No
automatic SDK creation, UI following, hard gate, lock or compaction changes.

## Review and resolutions

- Independent review confirmed default worker per-session module isolation,
  plain-data snapshot delivery to tools, transient request replacement and
  registry/type compatibility. Actual host routing/model compliance is unverified.
- Reproduced shared-instance rebinding: after setup for a second session, the
  first session's retained run could write under the new storage id. Refuse
  repeated setup before mutation/registration; regression preserves the first
  binding. Default worker flow already imports separately per session.
- Documented HOME-based storage despite host data-dir/XDG overrides and possible
  crash-leftover temps; no new path plumbing or cleanup behavior added. Fixed
  misleading object-identity comment and impossible overwrite recovery wording.
- Integration inspection additionally fixed authoritative env injection and
  handover-only seed-size accounting; exact-boundary fixtures prevent inflated
  headers from triggering the warning. Compression advice preserves critical
  instructions, risks and verification distinctions. Corrupt readback never
  authorizes deletion or overwrites; recovery requires storage inspection.

## Final evidence

- `npm run typecheck`: passed all eight projects, including the real pinned SDK
  `AgentPlugin` setup/hooks/tool contract.
- `npm test`: 595 tests / 97 suites passed, no failures/skips/cancellations.
  Includes 25 Cline fake-API fixtures with real os.tmpdir storage: root/child
  isolation, identity/run binding, setup guard, request scope/stages/unknowns,
  invalid env, verbatim retention, two-instance concurrent first-writer body/
  summary consistency, reload readback, modes/errors and exact seed boundary.
- `claude plugin validate .`, isolated configuration: passed with existing
  author/icon warnings and marketplace-install advice, no validation errors.
- Official CLI `3.0.74` version/help and repository package install/uninstall
  exited 0 in isolated state. Package manifest resolves `cline/index.ts` in a
  copied package containing shared imports; no MCP sync failures. Local CLI
  operations printed a certificate-store diagnostic without failing.
- Real CLI-bundled core loader on the installed copy: default plugin loaded,
  both tools registered through fake API; root intro, transient heuristic
  notice, child silence and whitespace-preserving stored readback with nudged
  diagnostics observed. No model/session run or actual event-routing claim.
- `git diff --check`: passed. README installation, twelve-row Cline checklist,
  concise assessment and four tentative decisions updated. Other adapters and
  their entrypoints remain unchanged.

## Outcome and limitations

Complete root CLI/SDK advisory/manual MVP. No automatic continuation, child
workflow, source lock or model-window discovery. Native compaction may precede
measurement; no universal pre-compaction authorship guarantee. Actual host
tool-policy/routing, opt-in sandbox transport, model compliance and fresh-session
continuation remain unverified. Manual retention is explicit; no quota/eviction
or crash durability promise. [Point-of-use assessment](../../research/cline.md).
