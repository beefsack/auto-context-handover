# Subagent soft-limit marker

## Goal and scope

- Accept an initial child prompt marker `[auto-context-handover-test soft=4096]` without configuration changes.
- Parse extensible `key=value` syntax, implement only `soft`, reject unknown keys, persist before admission, and strip the marker.
- Override configured soft thresholds for that child only; preserve hard-gate and handover behavior.
- Persist through reload/compaction, clean up on deletion, and never inherit into descendants or successors.
- No root overrides, later-history scanning, reset behavior, or broader configuration changes.

## Acceptance and approach

- Use `session.prompt` before admission, recognizing the initial child prompt after the standard banner.
- Store the override in session-keyed KV and apply it ahead of configured soft precedence in `context`.
- Cover parsing, rejection, scope, persistence, cleanup, precedence, and unchanged hard behavior with unit tests.
- Update configuration/test documentation and durable decisions; retain the usable-usage-anchor limitation.
- Verify with typecheck, the full test suite, and a bounded live child return check after coherent source edits.
- Determine source hot-reload behavior from host source or observation.

## Units and verification

1. Implement marker parsing, persistence, integration, tests, and inspect host reload behavior.
2. Review the public prompt contract and update documentation.
3. Run final checks and live verification; record accepted evidence and archive this note.

## Verification and outcome

- Implemented prefix-only banner-aware parsing, strict pair validation, awaited session-keyed persistence, soft precedence, and deletion cleanup. Documentation covers configured precedence, marker syntax, two-turn tests and empty-model rejection for isolated checks.
- Independent review found an admission-retry leak: an existing stored record bypassed validation and stripping when downstream admission had failed. Removed the redundant existence gate; empty-history retries now validate, persist and strip again. Regression coverage includes changed/invalid retries and corrupt records.
- Unit verification passes: typecheck and 118 tests. Coverage includes unknown/duplicate/malformed/unclosed markers, initial-child scope, persistence failures, soft precedence with unchanged hard gating, reload/compaction, descendant isolation and deletion.
- Source inspection at OpenCode 2.1.4 `19d87a7` shows local graph watching and plugin reactivation (`packages/core/src/plugin/module.ts:28-40`, `supervisor.ts:214-246`), fingerprinted reloads (`packages/plugin/src/source.ts:13-39`), Node cache-busted imports (`source.node.ts:10-51`) and Bun cache invalidation (`source.bun.ts:12-70`). Failed loads retain the last good generation (`supervisor.ts:79-90`).
- Initial live check `ses_e834b3588ffe7iexkAPI7iWSw7` used `soft=14000` and five model requests, with usage exceeding that threshold, but reported no nudge. Direct export inspection shows the marker was not stripped. Contemporary host logs repeatedly reported `Export named 'HANDOVER_DESCRIPTION' not found` while current `source/text.ts:6` exports it and typecheck passes. This attempt supplied no accepted plugin-behavior evidence.
- A clean host restart recovered loading without further production edits. Server logs after restart showed the local graph loaded/watched and zero plugin load/reload failures. The stale failure's precise cache/runtime cause is not established; source implements automatic reload, but reload did not recover that earlier failed state by itself.
- Accepted live check `ses_e8334b977ffez96hkmq32ehj1Z` used `soft=14000`. Direct export inspection confirms the initial marker was stripped, the configured request identity remained consistent across six requests, three separate sequential reads completed, and exactly one successful `context_handover` returned only the short summary/session ID/reader hint. The child's stored handover reports the exact final-warning nudge after the first read. Direct parent `read_handover` recovered the full six-section text; no config changes were needed.
- Independent review findings are resolved. Typecheck, all 118 tests and diff whitespace checks pass. No unresolved acceptance blocker remains. Reload/compaction persistence, deletion, rejection and descendant isolation remain unit coverage rather than additional live checks.
