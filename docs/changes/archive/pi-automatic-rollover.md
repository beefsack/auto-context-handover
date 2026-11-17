# Pi automatic root rollover

## Goal and scope

Make stored root-session handovers automatically open a seeded successor and continue through Pi's documented settled-event command-dispatch path. Keep `/handover` as recovery fallback, native compaction unchanged, and other adapters unchanged.

## Acceptance

- Establish command dispatch and seeded replacement on Pi 1.5.2 without model calls in isolated host state; report interactive following evidence separately.
- Preserve stored handovers and give clear recovery notices on failed dispatch, cancelled replacement or failed continuation.
- Reuse existing loop-guard parameters and semantics only if compatible; otherwise leave a proposal for decision.
- Typecheck, tests and real resource loading pass with zero load errors or warnings.
- Update current Pi documentation and decision; retain explicit live-model verification limits.

## Approach and bounded units

1. Reassess current Pi command dispatch, replacement lifecycle, development types and existing loop guard; validate the non-model probe contract before implementation.
2. Implement automatic dispatch and regression coverage, using the existing command's seeding and fresh-context continuation.
3. Review public lifecycle behavior independently, verify final evidence and reconcile documentation.

## Material decisions

- Automatic root rollover is the default; manual `/handover` remains the fallback.
- No new configuration, changes to other adapters, or invented chain parameters.

## Evidence and outcome

- Automatic requests are created only after successful tool storage, scoped to run/session/active-branch entry and consumed once at settlement. The tool returns `terminate:true`; dispatch expands `/handover` as a command without queue delivery. No historical replay, automatic retry, configuration or other-adapter behavior changes.
- Existing command seeding and fresh-context continuation are reused. Source text is retained; tool-result/preflight recovery guidance covers manual fallback. Cancellation, synchronous dispatch and command/continuation failures notify directly where possible; async dispatch errors use Pi's error surface. Interactive replacement failure is host-fatal before the plugin catch runs; other stale-context notification failures propagate instead of being swallowed.
- Development types migrated from deprecated `@mariozechner/pi-coding-agent:^0` to canonical `@earendil-works/pi-coding-agent:^1`, with canonical Pi and TypeBox `*` peers. No shared dependency versions changed. Pi requires Node >=22.19; the plugin retains its existing floor because Pi imports are type-only.
- `npm run typecheck` passed all twelve projects; `npm test` passed 781 tests, including 36 Pi fixtures. Initial typecheck could not start without dependencies; installation resolved that prerequisite.
- Pi 1.5.2 isolated offline-provider probe exercised the real tool and command: one stored verbatim payload, one distinct seeded successor with source backlink, kickoff admitted and offline successor response received. Two faux streams, zero loader diagnostics/errors and empty stderr. Independent source-file inspection confirmed stored handover and summary verbatim.
- The old 0.73.1 dispatch failure is historical. Current interactive-host source establishes session/view rebinding, not observed interactive behavior. Real-model compliance, interactive TUI following and exact model/settings retention remain unverified.
- Pi chain guard remains proposal-only: existing first-root exclusion, 25%-of-soft productivity and three-strike thresholds need persisted Pi predecessor/pre-call/high-water state and an explicit stop behavior without source locks. No guard is invented here.
- Package-manifest discovery through isolated `DefaultResourceLoader` loaded one extension with zero errors/warnings and empty stderr. Final typecheck and complete suite passed again after review corrections.
- An intermediate targeted run had 35 passes/one failure on uncertain replacement-state notification coverage; final targeted coverage passed all 36 tests. No unresolved failed approach remains.
- Independent lifecycle/public-contract review found no blockers. Resolved its three precision findings: interactive replacement errors are host-fatal, sync dispatch fixtures do not cover host async error delivery, and slash-command expansion rather than `deliverAs` alone controls dispatch.
- Documentation and the existing Pi decision now describe automatic defaults and manual recovery; the Pi backlog clause lists remaining checks only. Outcome complete within scope; real-model/interactive verification and the guard proposal remain separate follow-up work.
