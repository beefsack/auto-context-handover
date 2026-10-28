# Claude size-based retention

## Goal and authorized policy

- Replace indefinite Claude payload retention with fixed size-based whole-chain eviction; OpenCode behavior is unchanged.
- Before writes, estimate the complete serialized store with the pending value. Above 3 MiB, reclaim oldest eligible whole chains by last activity until the projected store fits. No TTL or configuration. The host cap remains 4 MiB.
- Preserve compact closed-child tombstones: expired reads are explicit and handed-over children remain locked. Reads and continuations refresh activity.
- Legacy/untimestamped payloads sort oldest; orphan spawn metadata participates. Never infer missing lineage. Protect the current chain, active/in-flight chains, and uncertain membership outside the explicit legacy/orphan boundary.
- Failed or partial reclamation is explicit and retryable. Insufficient safe space fails explicitly; failed handover storage never claims success or closes the child. Concurrent over-eviction is accepted, not race-free behavior.

## Scope

- Claude store accounting, activity and lifecycle metadata, tombstones and backward-compatible reads.
- Remove duplicated persisted summaries where safe; prune per-child memory without disrupting handback correction, resumability or pending callbacks.
- Update decisions, README and adapter evidence. No threshold or OpenCode lifecycle changes.

## Acceptance

- Fixtures cover oldest-first whole-chain eviction, legacy/orphans, protected chains, activity refresh, tombstone locks/expired reads, failed/partial deletion, quota refusal, old/new read formats, and memory retirement.
- Eviction scans run on writes only. Estimate includes all keys and the proposed replacement, not only payload families.
- Document exact membership/protection boundaries, estimate and concurrency limitations.
- `npm run typecheck`, `npm test`, and `claude plugin validate .` pass; independent review has no unresolved blockers.

## Accepted outcome

- Whole-chain reclamation includes original prompts, spawn metadata, activity and all generations, retaining closure tombstones. Legacy groups and untimestamped groups share the oldest tier; activity and chain id determine order within each tier.
- Protect current, active/in-flight and uncertain chains, including identifiable related references. The legacy/orphan exception requires no lineage claims; malformed/conflicting/unresolved claims do not qualify. Unreadable inventory refuses the pending write before any cleanup.
- New records retain the lossless summary once and derive the short reply; legacy replies remain readable. Reads/continuations refresh activity without eviction scans.
- Matching completion retires measurements and pins; blocked stops preserve handback correction. New open turns re-pin before the request. Auxiliary histories are bounded at 1000 child ids and 10 remembered turns per child, including reader-only provenance hydration.
- README, decisions and adapter requirements describe the accepted behavior and limits. No OpenCode lifecycle, threshold or shared handover-instruction changes.

## Evidence and open risks

- Official limits: https://code.claude.com/docs/en/plugins/mods/reference#limits (4 MiB JSON total; shared session-end budget).
- Canonical API: https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts (`store.keys/delete`, session and child lifecycle).
- Shared-store read/modify/write is non-atomic: https://code.claude.com/docs/en/plugins/mods/interface#save-from-more-than-one-session.
- Tombstones themselves consume space; no promise of indefinite successful writes or globally atomic eviction. Active-session visibility is local, so persisted protection must remain conservative.
- Implementation adds 34 regression fixtures over the 302-test baseline. Final direct verification passes `npm run typecheck`, `npm test` (336 tests in 43 suites; zero failures/skips), `claude plugin validate .` (existing author/icon warnings and marketplace-install advice) and `git diff --check`.
- Intermediate plugin validation rejected nested helpers receiving `$`; moving them to top level exposed a further direct validation failure for optional member access on `$`. Source must use the host validator's supported direct-access form; passing TypeScript alone is insufficient.
- Canonical-summary, timestamp and hook-allowlist fixture assumptions were reconciled. The former provenance-read-outage success expectation is superseded by explicit incomplete-scan refusal: no write or lock, with successful retry after recovery.
- Hardening covers incomplete-store refusal, partial-cleanup errors, timestamp-preserving tombstones, refcounted pre-spawn reservations and terminal-status/pin retirement. A fixture exposed stale turn callbacks overwriting newer measurements; bounded seen-turn tracking prevents that regression.
- Independent review confirmed fixes for raw/identity-conflicting related-chain protection and completed-open-child memory retirement with safe resumption. A subsequent review found rejected-spawn reservation leakage; one actual `finally` now releases exactly once while preserving the original rejection, with overlap coverage.
- Independent source review reports no unresolved blockers for the retention implementation. Stale pins without observed completion remain an explicitly documented conservative-protection limitation, not permission to expire or release still-in-flight chains at a blocked stop.
- Documentation reconciliation exposed provenance-cache hydration bypassing the existing 1000-entry cap. All nine insertions now use one bounded helper; a reader-only regression hydrates 1001 ids and verifies oldest eviction/newest retention when stored provenance becomes unavailable. Targeted independent follow-up accepted the correction, regression and documentation with no unresolved blockers, and independently reran typecheck and diff checks.
- Remaining limits: non-atomic cleanup can over-evict across sessions; stale pins, tombstones, unknown keys and protected chains can exhaust safe space. Partial cleanup is not rolled back, but refuses the pending write explicitly for retry. Bounded/transient history loss can degrade diagnostics to `unknown`. The aggregate JSON estimate is not host quota telemetry, and fixtures/CLI validation do not establish live host/model compliance.
