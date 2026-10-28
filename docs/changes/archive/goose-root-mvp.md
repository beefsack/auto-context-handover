# Goose root-session MVP

## Goal and scope

- Pin Goose v1.56.0 and add a root-only model-authored handover/reader over stdio MCP, lagged exported usage and explicitly opted-in Stop-denial notices.
- Keep continuation manual in a fresh equipped root. No child workflow, source lock, automatic creation, native-compaction changes or model selection.

## Approach and bounded units

1. Resolve caller binding against pinned source and released binary. Accepted: per-session stdio `AGENT_SESSION_ID`, correlated request metadata and exported `user` session with no parent; no argument-authored caller identity.
2. Implement isolated Goose entrypoints, fixtures and package checks, reusing dependency-free shared guidance/stages.
3. Document setup, capability boundaries and tentative decisions; validate released non-model import/export, hooks/config and MCP tool loading.
4. Independently review caller attribution, public contracts and denial bounds; resolve findings and rerun acceptance checks.

## Acceptance and verification

- Root writes refuse missing/mismatched host identity, children and unavailable root classification; retained model strings are immutable and verbatim.
- Unknown usage fails open. Stop notices are bounded and require explicit opt-in; no ordinary tool gating.
- Fixtures use temporary directories; `npm run typecheck`, `npm test`, `claude plugin validate .` pass.
- Released CLI checks use isolated configuration and no model requests. Distinguish source contracts, fixtures, non-model observations and unverified behavior.
- README installation, adapter checklist, concise research and decisions updated; archive this note at completion.

## Evidence and decisions

- Research pin `ee8500d5` is newer than release v1.56.0; relevant identity/hook/export contracts match the released tag. Release binary checksum and synthetic native-session import/export were checked without a provider.
- Per-session process identity removes the need for input rewriting or shared pending capabilities. Request metadata is correlation, not an OS-user sandbox.
- Implemented `goose/` standalone plugin/MCP/hook package, root classification, immutable storage, manual reference readback, shared stages/template/framing and package checks. README, checklist and research updated; product decisions remain tentative in `docs/decisions.md`.
- Independent review found wire model-name drift, invalid-soft storage refusal, unsupported closure claims and missing standalone packaging. Corrected all; fixture enums/diagnostics and plugin tool-prefix drift also corrected. Re-review found no remaining concrete issues.
- Integration checks additionally corrected unreadable-storage Stop behavior and malformed-stdin exit-2 denial; regression fixtures pass. A review command appended an unintended directory argument to the full test script; the resulting extra file-level failure was removed by invoking the intended command, not changing product behavior.
- Final verification: `npm run typecheck` clean; `npm test` 673/673 (44 Goose tests), no skips/failures; `git diff --check` clean. `claude plugin validate .` passes with existing author/icon warnings. `npm pack --dry-run --json` includes Goose's hidden `.mcp.json` and hook manifest.
- Released v1.56.0 non-model checks: checksum-verified archive, native synthetic-session import/export (matching root id/null parent/usage150); manual Stop opt-in block/opt-out allow and SessionStart banner; real host `mcp-probe` loads two hook rules, lists both tools, reads missing storage and refuses Hidden writer after host identity passes. Direct SDK stdio root storage/readback and metadata refusals also observed. Recipe validation passed.
- Remaining limitations: no actual Stop dispatch, real child attribution, model compliance/final receipt or fresh-root continuation observed. No model-visible standing intro, window discovery, source lock or automatic continuation. Host cap bounds denial loops; storage retention/manual recovery and native compaction limitations are documented.
