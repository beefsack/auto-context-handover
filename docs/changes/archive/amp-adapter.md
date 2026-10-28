# Amp adapter

## Goal and scope

Ship the smallest honest Amp plugin MVP: active-view transcript estimation,
advisory staged notices, host-thread-bound model-authored storage/readback, and
fresh-context continuation where the public contract supports it. No native
compaction changes, speculative usage counters, or model selection.

## Acceptance and approach

- Verify primary plugin documentation and pinned shipped types, including
  event/tool continuation, thread binding, storage and subagents.
- Reuse dependency-free shared guidance/stages; direct TypeScript if supported.
- Cover behavior and storage with fake-API unit fixtures in temporary storage;
  compile against real package types.
- Document installation, capability boundaries and tentative decisions; update
  adapter checklist and concise research assessment.
- Verify typecheck, full tests, Claude packaging validation and available
  isolated non-model Amp installation/help/load checks. Distinguish fixtures,
  observed registration and unverified model compliance/continuation.
- Independently review public contracts and persistence/continuation behavior;
  resolve findings and archive this note with final evidence.

## Units

1. Establish pinned API/loader capabilities and select a bounded MVP.
2. Implement adapter, fixtures and package/typecheck wiring.
3. Review implementation independently, integrate documentation and verify.

## Accepted scope and evidence

- Existing Cline and Pi adapters provide shared-text and advisory/storage
  precedents; Amp feasibility assessment requires active-view-only estimation.
- Pinned Amp types expose `thread.agent()` and unrestricted
  `Agent.createThread({show:true})`, followed by `appendUserMessage` to start
  work. Use the source agent, not an arbitrarily chosen built-in mode.
- Bounded design: focused parentless threads only; introduction at agent.start,
  notices appended to supported textual tool results, automatic root creation
  at successful agent.end after storage. Persist an exclusive attempt marker
  before external creation; uncertain effects require manual inspection, never
  automatic retry. No source lock or forced cancellation.

## Review and resolutions

- Independent review identified partial estimates at the pagination cap,
  overstated nudged diagnostics for unsupported result shapes, a focus test
  whose pending work was already consumed, and inconsistent skip diagnostics.
  Capped unfinished walks now return unknown; reason reflects actual append;
  fresh pending focus-loss has a direct regression; reader distinguishes no
  claim from uncertain post-claim effects instead of silent ambiguity.
- Integration inspection fixed tool-use/input ids incorrectly proving result
  inclusion: only terminal tool-result ids deduplicate the current output.
  Exact diagnostic fixtures cover absent results, placeholders and final results.
- Creation rejection is uncertain, never proof of no side effect. Claim-only,
  corrupt/unreadable outcome/claim and lost-id persistence paths advise manual
  inspection; failed successor-id recording prevents seeding. Reader warns
  against blind append retries. Two-instance concurrent first publication
  preserves an intact verbatim body/summary pair and private modes.
- Non-model installer initially lacked its configured temporary directory;
  pre-creating it restored bundled native-module loading. This was setup, not
  an adapter failure. Real directory-forwarder loading then passed with a
  throwing-plugin negative control.

## Final evidence

- `npm run typecheck`: passed all nine projects, including real pinned Amp
  `PluginAPI` event/tool/thread contracts; runtime import is type-only.
- `npm test`: 629 tests / 102 suites passed, zero failures/skips/cancellations;
  34 Amp fake-API fixtures with real os.tmpdir storage. Covers stages/config,
  paging/unknowns/deduplication, output/status preservation, attribution,
  immutable concurrency/private modes, verbatim replay, diagnostics/reload,
  exact single seed, duplicate ends, focus guards and recovery failures.
- `claude plugin validate .`: passed with existing author/icon warnings and
  marketplace-install advice, no validation errors.
- Amp `0.0.1793203246-g5eab6d`: isolated installer/version/help succeeded.
  Real `plugins exec <entry> session.start --data '{}'` loaded the direct entry
  and directory forwarder, exit 0. Deliberately throwing plugin exited 1 before
  readiness. Default-export fake-API check registered both tools and three
  lifecycle handlers. These establish load/registration, not real event routing.
- `amp plugins list`: global-plugin connection failure, exit 1.
  `amp plugins show-agent-options`: missing-key refusal, exit 1. Separate tools
  listing entered device login and was stopped. SaaS-authenticated catalog,
  callback routing, client following and model continuation remain unverified.
- `git diff --check`: passed. README install/limits, twelve-row Amp checklist,
  concise cited assessment, reassessment link and four tentative decisions
  updated. Existing adapters/entrypoints and backlog unchanged.

## Outcome and limitations

Complete focused-root advisory MVP with one automatic continuation attempt per
stored handover, source-agent handle reuse and manual readback recovery. No
known window/exact usage, universal child detection, source lock, hard gate,
retention cleanup or setting-preservation guarantee. Native compaction can
precede notices; paging is not a snapshot; omitted context can undercount.
Exclusive claims prevent automatic repeats but do not make remote creation or
admission transactional. No live model compliance/continuation claim.
[Point-of-use assessment](../../research/amp.md).
