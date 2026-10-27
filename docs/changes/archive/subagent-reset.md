# Subagent reset

## Goal and acceptance

- Add opt-in `onHandover.subagent: "reset"`; retain default `return`.
- Continue the same child from its verbatim model-written handover while the parent's existing spawn waits for the real final result. Never create a root from a child.
- Persist a readable reset checkpoint, define repeated-unproductive-reset handling, and extend the initial-child marker to select reset without configuration edits.
- Verify unit coverage, typecheck, the full test suite, and bounded live same-child continuation and parent delivery. Update README and durable decisions.

## Investigation and blocker

- OpenCode 2.1.4 `19d87a7` admits `session.compact` without waiting for execution (`packages/core/src/session/session.ts:259-276`). The active tool must return before the runner handles that item at the next step boundary (`packages/core/src/session/runner/llm.ts:81-157,186-193`). This preserves the existing child execution and pending parent result; awaiting idle inside the tool would deadlock.
- A compaction hook can supply the active model's exact handover without another model call (`packages/core/src/session/compaction.ts:582-591,835-847`). Set `metadata.keepID` to null, because normal summary wrapping merges a retained-tail ID otherwise (`:513-515`). Completed compactions provide the durable effective-history cutoff (`packages/core/src/session/history.ts:149-179`).
- A material reliability gap remains: held background compactions can be applied without running the hook (`packages/core/src/session/compaction.ts:301-321,395-418`). Manual compaction is not exempt. A previously generated summary can therefore replace the requested handover and retain old context.
- Background compaction is experimental and off by default (`packages/core/src/session/compaction.ts:259-265`; `packages/core/src/config/plugin/compaction.ts:16`). The public plugin context has no compaction-settings or held-summary invalidation API (`packages/plugin/src/promise/plugin.ts:26-55`; `packages/plugin/src/promise/session.ts:154-175`).
- A later asynchronous event-driven retry is not an accepted solution: it can race the next model request, and replaying the original seed can discard intervening work. Persistent request filtering alone does not advance the durable cutoff and must also handle native compaction and retained tails.

## Outcome

- Investigation only; no production or test changes accepted.
- Shelved: low value relative to live-verified child `return`, which better follows the principle of deferring to parent agents. The background-compaction blocker above prevents shipping the baseline manual-compaction path as generally reliable.
- Future baseline: `session.compact` with the compaction hook supplying the verbatim model-written handover and `metadata.keepID: null`. Revisit only with a reliable way to prevent stale held summaries from bypassing that hook; no public invalidation API currently exists.
