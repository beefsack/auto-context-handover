# Claude parent continuation

## Goal and scope

- Give Claude roots a context-only plugin introduction establishing configured child continuation, predecessor replacement semantics and read-before-decision guidance.
- Preserve exposed child agent/model provenance in readback and replies, require pending user decisions in child summaries, and derive diagnostics stage from measured usage.
- Keep root measurement, nudging, handover, gating and native compaction unchanged. Exclude teammates, overshoot work, principles and unrelated OpenCode behavior.

## Acceptance

- Verify and cite a non-tool-result root context channel before implementing root guidance; stop for a material channel trade-off.
- Short replies preserve agent/model provenance honestly and require readback before task decisions. Child summaries declare pending user decisions.
- Stage diagnostics match the existing Claude nudge boundaries, with unknown values preserved honestly.
- README and durable decisions match the behavior. Unit tests, typecheck and plugin validation pass; independent review has no blockers.

## Approach

1. Research the mod start hook and exposed child identity fields against source contracts.
2. Implement the bounded Claude adapter/text/storage changes with regression coverage, preserving existing uncommitted work.
3. Inspect changes, verify all checks and request independent review.
4. Record channel citations, final evidence, risks and retest steps; archive this note.

## Evidence and decisions

- A supplied live report says the child stored a complete six-section handover and stopped correctly, but its parent asked without reading it. Reported causes: untrusted handback authority, literal one-subagent counting, missing model override in the reply, and unknown diagnostics stage despite known usage.
- User chose a root context-only introduction, automatic continuation as configured default, and successors replacing predecessors as the same logical subagent. Parent judgment remains responsible for handover-listed user-owned decisions.
- The report is external evidence, not a reproduction. Existing adapter work is the baseline.
- Channel accepted: `classic.SessionStart` `additionalContext`, placed before the first prompt, unlike tool-result-adjacent context ([official placement](https://code.claude.com/docs/en/hooks#add-context-for-claude), [mod event wrapper](https://code.claude.com/docs/en/plugins/mods/events#hook-the-settings-hook-events)). Guard on absent `agent_id`, not `agent_type`, so custom-agent roots still receive context while child loops do not. Reinjection on startup/resume/clear/compact/fork is context only, not a compaction change.
- Provenance source: canonical [mod types](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts), `BaseHookInput`, `ClassicResultFields`, `AgentSpawnInput` and `AgentSpawnResult`; [subagent reference](https://code.claude.com/docs/en/plugins/mods/reference#subagents). `agent.spawn` exposes resolved agent type, requested model override (absent means agent/parent default; ignored for forks), and returned child id/effective model. `SubagentStart` exposes type but not override. Never infer a spawn override from per-request usage or the root model.

## Outcome and verification

- Implemented context-only root introduction in `hooks/child.ts`, typed/wired through `hooks/claude-types.ts` and `hooks/register.ts`. Existing child introduction and staged notices are unchanged. Root context composes with other hooks, skips present child ids including malformed ids, and fails open; no root lifecycle or compaction behavior changed.
- Observe spawn parameters without rewriting them, persist minimal type/override metadata for later child records, and carry it in short replies, locked replies when known, and reader headers. `no override` differs from unknown; unknown provenance directs the parent to predecessor spawn parameters. A missing type can come from `SubagentStart`; closed records are never overwritten.
- Claude short replies contain one successor instruction with type/override provenance and the exact read-before-reply/decision sentence. The Claude tool description requires the summary's pending-user-decisions line. Missing/legacy summaries are not rewritten to claim no pending decisions. Stored handover/summary text remains verbatim.
- Claude diagnostics stage now uses `softStage` on call-time latest usage, independently of delivered-nudge reason. README and decisions updated; all implementation edits are in `hooks/`. No OpenCode-visible text or behavior changed, and no shared/source export was removed or renamed.
- Direct verification: `npm run typecheck` passed both projects; `npm test` passed 261 tests in 36 suites, zero failures; `claude plugin validate .` passed with existing author/icon warnings and marketplace-install advice; `git diff --check` passed.
- Independent read-only review inspected root/teammate boundaries, public text, provenance/reload/outage/legacy behavior and staging; reran the same four checks, confirmed 261 passing tests and found no blockers.
- Complete. This evidence is unit/contract validation, not a live parent-continuation reproduction.

## Remaining risks and retest

- Start context is trusted plugin attribution, not a system-priority override or guaranteed compliance. Native handback still undergoes host classifier review. Installed-version delivery and parent behavior remain unverified live.
- Provenance records parameters as the observer sees them; downstream mod rewrites can differ. Storage outages and unobserved prior spawns can leave fields unknown. Nudge provenance/usage are transient, while successfully persisted spawn metadata survives reload. Batch overshoot remains unchanged.
- Follow README's Claude parent-continuation retest: fresh root, explicitly chosen child model, configured soft threshold outside the task, sequential read-only audit without handover hints. Verify pre-prompt root/child introductions, stored pending decisions, read-before-decision, autonomous same-type/same-override replacement under a one-subagent instruction, and measured diagnostics stage. Confirm no root measuring/nudging or compaction changes.
