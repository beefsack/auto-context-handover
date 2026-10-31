# AGENTS.md

## Functional Specification

- `auto-context-handover` is a TypeScript plugin for OpenCode V2 `>=2.2 <3`: measure context, nudge model-written handover, optionally hard-gate tools, and rotate sessions.
- `README.md` describes behavior and installation; `docs/` holds project decisions, principles, research, and change records.

## Live Testing

- Root-session live tests follow the isolated manual plan in `README.md` (separate `/tmp/opencode` directory, never the live config). This does not grant mutation authorization.
- For each isolated run, ask the user to choose the model explicitly. Require it as a per-run argument or environment variable with no default; scripts must reject unset or empty values before invoking OpenCode. Never hardcode or select a model in test files, scripts, or configs.
- Child behavior may be tested from the live session using ordinary `worker` subagents whose spawn prompts start with `[auto-context-handover-test soft=4096]` (adjust soft as needed). Use their configured model, never a model override. Keep checks bounded and give them at least two model turns; workers cannot spawn agents.
- The live host loads this working tree directly. Keep source edits coherent and run typecheck before any live test spawn.

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
