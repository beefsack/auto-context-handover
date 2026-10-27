# TUI rollover following

## Goal and scope

- Automatically follow a root rollover only when the TUI is still showing its source session.
- No interactive UI, review, desktop/web support, or change to lock/child behavior.
- Ship the companion with the existing package and installation entry.

## Acceptance

- Verify the OpenCode 2.1.4 package-loading and event contracts against source.
- Follow only an existing successor; never use a fixed delay or displace another viewed session.
- Cover testable behavior with unit tests; pass typecheck and tests.
- Demonstrate isolated companion loading without a model call.
- Document installation and a short manual TUI rollover check; end-to-end rollover remains unverified until exercised interactively.

## Implemented approach

1. Add a root `tui.ts` shim, included in package files, preserving conventional server entry resolution.
2. Add namespaced successor metadata only to successful root-rollover results. Listen for `session.tool.success`, verify the successor through the client, and recheck the current source route before navigation. Ignore non-source routes, invalid metadata, unavailable successors, and disposal during lookup.
3. Add targeted tests, verify isolated no-model activation, and document installation and the remaining interactive check.

## Material decisions

- Use the existing structured tool-success metadata/event path, not human-text parsing, custom RPC, or shared KV.
- Follow live rollover events only. Do not redirect when opening historical sessions or backfill missed events: that would change ordinary navigation behavior beyond following a currently viewed rollover.
- No new config or dependency; no JSX or interactive UI.

## Accepted evidence and outcome

- The public V2 plugin guide documents a package `./tui` export loaded automatically with the server part; the TUI guide documents event subscriptions and current-route navigation.
- Pinned `19d87a7`: `packages/plugin/src/host.ts:25-64` resolves conventional root `tui` alongside `index`; `packages/plugin/src/tui/context.ts:63-87,142-152` exposes event subscriptions, session lookup, and routes. `packages/schema/src/session-event.ts:534-548` carries result metadata on `session.tool.success`.
- Existing root rollover verifies successor existence, persists links and locks, and admits the successor prompt before returning success (`source/index.ts`). Its existing result text and behavior remain unchanged; metadata is additive.
- `npm run typecheck` passed; `npm test` passed all 121 tests. New coverage checks metadata presence/absence, route guards, failed/missing/mismatched lookups, duplicate in-flight events, and cleanup.
- `npm pack --dry-run --json` includes both root entry shims and the companion implementation. `git diff --check` passed.
- Independent review found no concrete issues with the pinned API/event/navigation contracts, including session-tab navigation.
- An isolated private OpenCode 2.1.4 TUI, with no prompt or model invocation, logged production `tui.ts` import completion and `auto-context-handover-tui` setup completion. No plugin failure appeared. An earlier activation probe used a mismatched CLI version and did not establish setup; only the pinned run is accepted evidence.
- README documents automatic loading from the existing plugin entry and a short interactive check. Actual end-to-end rollover navigation remains unverified; it is intentionally left for interactive verification. Missed events and historical sessions do not auto-redirect.
