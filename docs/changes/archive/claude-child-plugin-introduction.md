# Claude child plugin introduction

## Goal and scope

- Establish the plugin's purpose before a Claude child's task so later tool-result-adjacent context notices have honest attribution and a known workflow.
- Use `classic.SubagentStart` additional context; do not rewrite the parent's task prompt. Keep Claude roots and all OpenCode text/behavior unchanged. No new enforcement.
- Inject unless the agent is positively identified as a teammate. Unclassified ids receive the introduction; teammates otherwise remain excluded from notices and refused by the handover tool.

## Acceptance

- Introduction arrives through the start hook, preserves other hook output, and names the exact deferred-tool loader and handover action.
- Each staged notice references the introduction and retains enough instructions to work if the introduction is missing.
- Tests cover start-hook classification, composition and failures, plus teammate nudge exclusion and handover refusal; existing OpenCode output regressions remain unchanged.
- Typecheck, full unit tests and plugin validation pass; independent review has no unresolved blockers.
- Record the channel choice, user-approved unknown-id behavior and rationale in decisions; archive this note on completion.

## Approach and bounded units

1. Implement the start hook, concise child text, and regression coverage.
2. Inspect the actual changes and verify typecheck, unit tests and plugin validation.
3. Independently review the public text, root isolation, teammate boundary and hook failure behavior.
4. Record accepted evidence and remaining integration risks, then archive this note.

## Evidence and decisions

- Reported live finding: a child treated `PostToolBatch` additional context as tool-result prompt injection and explicitly ignored it. This is user-reported evidence, not a reproduced integration result.
- Official [hook context placement](https://code.claude.com/docs/en/hooks#add-context-for-claude) distinguishes start-of-conversation `SubagentStart` context from tool-result-adjacent `PostToolBatch` context. The [SubagentStart contract](https://code.claude.com/docs/en/hooks#subagentstart) places additional context before the first prompt and covers built-in/custom/plugin agents, resumes, and teammate messages. It does not establish system-prompt priority or model compliance.
- The mod type contract maps `SubagentStart` to `additionalContext`. Its input carries `agent_id` and `agent_type`, not a teammate flag. Agent listing documents agents "so far" without start-event insertion timing.
- User chose to introduce unclassified ids rather than risk missing a newborn child. Skip only positively identified teammates; preserve existing teammate nudge and tool restrictions. This can deliver the introduction to an unclassified teammate, without enabling its handover action.

## Outcome and verification

- Added a child-start introduction in `hooks/child.ts`, the minimal `classic.SubagentStart` type contract, and start-hook wiring that preserves other hook fields/contexts. Unknown/unclassified ids, unavailable listings and listing failures receive the introduction; only positively identified teammates are skipped. Missing/invalid ids and invalid hook results remain untouched; hook failures do not block admission.
- Staged notices retain the unchanged shared OpenCode leads and thresholds, reference the introduction, and preserve exact deferred-tool loading, full-text handover/stop, current-step boundary, intact parent readback and incomplete/successor guidance. Schema/template rationale and read-only plugin-storage permission now live in the introduction. OpenCode and Claude root behavior remain unchanged.
- Added twelve tests net (242 total): start-hook composition/classification, unavailable listing API, repeated events, invalid inputs/results, catch replay, delegated introduction details and teammate/unknown-id boundary regressions. Confirmed teammates receive no nudges and the handover tool refuses them.
- Direct verification: `npm run typecheck` passed; `npm test` passed all 242 tests with zero failures; `claude plugin validate .` passed with existing author/icon warnings and marketplace-install advice; `git diff --check` passed.
- Independent review inspected the current source and boundary tests, reran typecheck, all 242 tests and diff checks, and found no blockers. Plugin validation was directly verified separately, not rerun by the reviewer.
- Implementation reported a transient malformed adapter edit during simplification, repaired before final verification. The final adapter structure was inspected and typechecked; effects of any intervening host reload are unverified.
- README and durable decisions updated; implementation complete. No new live delivery, model-compliance or parent-continuation evidence is claimed.

## Remaining risks and retest

- Start context is not a system-prompt override; later notices remain advisory tool-result-adjacent text and may still be ignored. Text-only work still receives no batch notice. An unclassified teammate may receive the introduction, as explicitly accepted, but remains unable to hand over.
- Repeated/resumed start-event deduplication and reinjection after compaction rely on the documented host behavior, not a new live check.
- Reload the plugin with `/reload-plugins` or start a new Claude session. Repeat the reported Haiku child audit with a configured low enough soft threshold and no handover hints in its task prompt. Inspect the child's transcript for the introduction before its first prompt, the staged batch notices referencing it, exact ToolSearch loading and a full handover call, intact parent readback and default successor continuation. Confirm the root receives no introduction/nudge and a teammate still receives no nudges or handover action.
