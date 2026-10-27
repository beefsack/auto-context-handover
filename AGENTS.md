# AGENTS.md

## Functional Specification

- `auto-context-handover` is a TypeScript plugin for OpenCode V2 2.1.4: measure context, nudge model-written handover, optionally hard-gate tools, and rotate sessions.
- `README.md` describes behavior and installation; `docs/` holds project decisions, principles, research, and change records.

## Live Testing

- Before any live or model-invoked testing, follow the isolated manual plan in `README.md` (separate `/tmp/opencode` directory, never the live config). This does not grant mutation authorization.

## Local-System Information

- Never commit local paths or information about local machines (paths, host names, hardware/resource details); describe test conditions generically.

## Repository Records

- Never record session controls in repository files or commit messages: commit/push permissions, autonomous or supervised modes, agent/model roles and routing, concurrency and approval gates, user availability, or machine-specific resource limits. Record only the work, its evidence, and product decisions.
- Put reusable findings in point-of-use documentation or relevant code comments; do not create generic learnings files.
- `docs/principles.md` and `docs/decisions.md` are binding; `docs/backlog.md` and `docs/changes/archive/` carry governance context.

## Dependency Management

- Runtime and dev dependencies belong in `package.json` (`npm install`); Node `>=22.18` required.
- No build step: the host resolves the root `index.ts` shim and loads `source/` directly.
- Verify with `npm run typecheck` and `npm test`.
