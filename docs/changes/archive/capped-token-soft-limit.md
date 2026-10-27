# Capped token soft limit

## Goal and scope

- Default to 150000 tokens or 70% of the active model window, whichever is smaller, and apply the same cap to explicitly configured integer soft values.
- Include agent/model overrides and per-child markers. Preserve percentage semantics, hard limits, precedence and native compaction.
- Non-goals: new configuration keys, hard-limit changes, handover/rollover changes.

## Acceptance and approach

1. Resolve integer soft values through a dedicated capped resolver; preserve the existing resolver for hard limits. Unknown-window integers still apply; unknown-window percentages fail open.
2. Cover small/large windows, explicit integers, percentages, overrides, child markers and hard-limit independence with unit tests.
3. Update README and promote the user decision dated 2026-10-27. Pass typecheck, tests and diff checks; review the public threshold contract independently.

## Material decisions

- Fixed 70% cap for integer soft values only; percentages are explicit alternatives. Use the active model's input limit, falling back to context.
- Hard resolution and hard-first staging remain unchanged, including fail-open gating when the window is unknown.
- Loop productivity and seed warnings continue to use the effective soft value.

## Evidence and outcome

- Default and explicit integer soft values now share the capped resolver, including agent/model and child overrides; percentages retain their requested value. Hard-limit resolution is unchanged.
- README documents defaults, fixed-cap semantics, unknown-window behavior, child overrides and hard-first staging. `docs/decisions.md` promotes the user decision dated 2026-10-27.
- `npm run typecheck` passed; `npm test` passed all 133 tests; `git diff --check` passed. Coverage includes small/large windows, explicit integers, percentage escape, agent overrides, stored child overrides, unknown windows and uncapped hard limits.
- Independent public-contract review found no blocking issues. Model override capping uses the same resolver as covered agent overrides; existing hard-first staging is preserved.
- Live behavior was not reverified; evidence for this change is unit tests and static review.
