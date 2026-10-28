# Crush adapter

## Goal and scope

- Refresh Crush capabilities against the adapter checklist using primary docs,
  pinned release source and an isolated installed binary.
- If prerequisites are established, ship the smallest measured handover adapter
  with fixture coverage and documented installation. Otherwise publish the
  assessment, explicit blockers and an unblock path without speculative code.
- Preserve existing adapters and native compaction. Reimplement concepts only;
  do not vendor Crush's FSL-licensed implementation.

## Acceptance

- Capability table distinguishes documented, source-established, observed and
  unverified behavior, including measurement, injection, child identity/delivery,
  MCP caller binding, storage and packaging.
- README and adapter requirements reflect the actual supported scope.
- Any implementation has focused fixtures and non-model installation checks.
- Typecheck, full tests and Claude plugin validation still pass.
- Independent review findings are resolved; record outcome and archive this note.

## Approach

1. Establish a pinned capability assessment and feasible scope.
2. Implement a bounded MVP only if measured context and safe host identity are
   available through supported integration surfaces.
3. Review the public contract and security-sensitive identity assumptions,
   verify the final tree, and document accepted evidence and limitations.

## Material decision

- Native children are excluded from hooks, so no child integration.
- The initial assessment-only conclusion was rejected after inspecting the
  local server's OpenAPI-backed workspace/session/agent routes. Root creation
  and queued prompt admission exist without an external process supervisor.
- Root MVP: static standing guidance, source-pinned server reads for
  last-saved response counters/window, staged tool-boundary notices, hook-bound
  MCP handover/read tools, private storage, root creation and one seeded prompt.
  No TUI auto-follow, native-compaction changes, child behavior or token gate.
- Explicit installation authorizes one same-workspace root creation and seed
  through an absolute user-selected Unix socket. No server discovery or TCP.

## Accepted evidence and current state

- Assessment covers release `v0.98.2` and nightly `3538c72`, clearly separated.
- Source establishes latest-nonzero-response token replacement, no usage in
  hook payloads, static context placement, child exclusion and final-text
  delivery, top-level MCP rewriting, deny/halt and ignored turn-hook results.
- Isolated binary/config probes are reported in the assessment; hook/model
  execution and actual DB reads during hooks are not established by them.
- Initial assessment review found two documentation issues:
  Fantasy establishes after-tools usage saving (not unknown ordering), and
  Crush shallow-merges capability patches (not argument replacement). Both
  claims are corrected with pinned citations. The stop verdict was subsequently
  superseded by the local-server investigation.
- README/checklist/research now describe root scope, explicit local-server
  installation and its risks; tentative decisions replace the superseded stop.
- Isolated server probe established workspace/root creation and reads without
  model calls; POST agent admission remains source-established, not exercised.
- Integration corrections include the six-section template, honest unknown
  reason, retained estimates, uncertain-admission recovery, status readback,
  actual-seed warnings, root/response-id checks, fake admission wire tests and
  symlink-safe executables. Unknown-window percentages suppress notices without
  disabling explicit readback/handover; unknown diagnostics stay unknown.
- Release server probe confirmed version, OpenAPI (69 paths), workspace/root
  creation, zero counters, session identity and empty-model/window agent reads.
  Exact README config including paths with spaces parsed. Manual executable
  hook/SDK integration exposed a symlink entrypoint bug, now corrected. Both MCP
  tools list, unbound reads fail and a manually bound read reports no handover.
- Final direct regression evidence: `npm run typecheck` passes all five projects;
  `npm test` passes 495/495 (61 Crush tests plus 434 existing tests), no failures,
  skips or cancellations. Focused Crush run also reported 61/61.
- `claude plugin validate .` passes with existing author/icon warnings;
  `git diff --check` passes. Package dry-run includes Crush code and standing
  context. Release non-model API/config/manual hook/SDK check exits zero.
- Independent final security/public-contract review: PASS, no blockers or
  concrete changes requested. Reviewer independently typechecked Crush and
  inspected binding, authorization, closure, concurrency, recovery, retention
  and documentation. Informational finding: status updates are last-writer-wins;
  the single-writer flow and explicit no-transaction limitation are accepted.
- Earlier assessment review's two findings (after-tools usage-save ordering and
  shallow-merge input semantics) were resolved with pinned source citations.

## Outcome and remaining limitations

- Root MVP complete: release-pinned hook/MCP/server integration, standing context,
  private verbatim storage, explicit local-server continuation and recovery,
  shared instructions/thresholds/stages/seed warning, tests and install docs.
  Existing adapters and native compaction are unchanged.
- Five tentative product decisions are recorded in `docs/decisions.md` under
  "Crush root-session MVP" for user review.
- Actual host hook dispatch, model compliance, configured-model usage accuracy
  and successful seeded continuation remain unverified. Server creation/reads,
  exact config parsing and standalone MCP execution are non-model observations;
  prompt admission is source-established and fake-socket fixture-covered only.
- No child hooks, TUI following, hard token gate, override preservation guarantee,
  original-task capture, lineage or loop guard. Counters normally lag and may be
  older; diagnostic reason is unknown. Same-user storage/socket trust is not a
  sandbox; no quota/TTL/eviction, fsync durability or cross-system transaction.
  Crashes can orphan a successor; uncertain admission requires inspect-first
  manual recovery and never a blind resubmission.
