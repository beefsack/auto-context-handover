# Claude Code subagent handover MVP

## Goal and scope

- Add a Claude Code mod for subagent handovers only. Root sessions receive no context nudges, handover action or rollover; native compaction remains untouched. The root may read a child's stored handover.
- The child model writes the full structured handover and short summary. Store accepted text verbatim, return summary plus child ID and reader hint, and refuse subsequent tool work in that child.
- Keep the OpenCode GitHub installation, root entrypoints and behavior unchanged. Use root Claude plugin/marketplace packaging and extract only genuinely reusable threshold logic and handover instructions.
- Defer automated root rollover, child-window discovery, percentage thresholds, hard ceilings, loop accounting, per-child test overrides, agent-team support and cross-process orchestration. Do not add SessionStart seeding or root seed-size handling.

## Acceptance

- Observe per-request child usage, never cumulative turn/session totals or the root's window. Invalid/missing usage does not nudge. Integer soft defaults to 150000 and remains uncapped while the child's window is unknown.
- Add stable feedback after child tool batches at the soft boundary. Root events and engine-internal/teammate loops remain unchanged.
- Persist handover and stop state together; handle duplicates and storage failures without claiming success or losing accepted text.
- A parent can read the full stored text using the child ID returned in the short reply.
- Deny new tool work in handed-over children. Preserve the native SubagentHandback classifier path when applicable, forwarding only the model-authored short summary plus plugin reader metadata. No synthesized report bypasses classification.
- Final-response shaping is guidance, not a deterministic final-answer replacement. A SubagentStop correction must be bounded by stop_hook_active, not an indefinite continuation loop.
- Credit-free tests cover event wiring, isolation, storage, refusal, handback forwarding and OpenCode regression behavior; typecheck both adapters against their documented contracts.

## Approach and bounded units

1. Verify only measurement, child identity, feedback, return and packaging contracts.
2. Implement root packaging, dependency-free shared pieces and the bounded child adapter with unit fixtures. No spawn-marker parser unless clearly necessary.
3. Independently review classifier preservation, root isolation and public packaging; run typecheck and tests after fixes.

## Evidence and limits

- [Public mod declarations](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts), header 2.1.277: TurnStepInput.agentId identifies the child loop; TurnStepResult.usage holds per-request input/output/cache counts. SessionContextUsage describes the session's window, not a verified per-child lookup.
- [Mod events](https://code.claude.com/docs/en/plugins/mods/events): turn.step observes subagents. [Mod API](https://code.claude.com/docs/en/plugins/mods/api): register custom tools and serve them in tool.call; $.store persists plugin-private JSON, with a 4 MiB total limit.
- [Hooks](https://code.claude.com/docs/en/hooks): PostToolBatch runs before the next model request, carries agent_id and can add context; SubagentStop can request correction but cannot replace the returned report. Auto-mode children may deliver the report through SubagentHandback before stopping.
- [Tool reference](https://code.claude.com/docs/en/tools-reference): SubagentHandback is classifier-reviewed and is provided to eligible local, non-fork auto-mode children. Its message argument is documented in the hooks reference, though absent from the older public built-in input table. Keep forwarding through the ordinary tool chain.
- [Marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference): source "./" supports a repository-root plugin. [Mod reference](https://code.claude.com/docs/en/plugins/mods/reference): hooks/hooks.json loads the module; its runtime has no Node globals.
- These are documentation/type observations, not live verification. Child feedback routing, tool availability under real allowlists, classifier-reviewed short returns, resumptions and installed-package loading remain unverified integration risks.

## Material decision

- User chose "Option C - do nothing for the top level". Preserve unattended root work through native compaction rather than introducing a manual rollover stop. Automated root continuation remains future research.

## Outcome

- Implemented root Claude plugin/marketplace manifests, the Node-free adapter and credit-free event fixtures under `hooks/`. The reader takes `childId`, not reserved host field `agentId`; the caller's loop identity cannot be confused with the read target.
- Extracted only the threshold parser and common six-section text into `source/shared/`. Existing OpenCode imports remain compatible through re-exports; no adapter layout move or entrypoint change.
- `npm run typecheck` passed for both adapters. `npm test -- --test-reporter=dot` passed all 176 tests, including existing OpenCode coverage. `git diff --check` passed. A direct comparison against the prior `source/text.ts` confirmed byte-identical OpenCode handover-description output; root/server/TUI entrypoints were unchanged.
- Independent review found no blocking defects. A subsequent targeted integration correction tracks native handback completion and the bounded stop-correction latch by child turn. Tests verify different closing text does not cause correction after completed handback, native deny/error still permits one correction, and a resumed turn resets the latches. Native results are returned unchanged; classifier delivery internals are not inferred.
- Material implementation choices: integer-only uncapped soft, one stable nudge per over-limit tool batch, explicit-ID readback from open sessions, one durable record combining text and closed state, and execution denial through `tool.call`. These are adapter choices, not claims of live parity with OpenCode.
- Remaining integration evidence: child feedback routing and identity bridging, inherited tool availability, classifier-reviewed short report delivery, resumed-child refusal, host-session metadata and installed-package loading. Final text shaping outside native handback remains advisory; text-only work is not intercepted. In-memory correction/delivery state resets on reload. Already admitted parallel work is not cancelled.
- Storage has a shared 4 MiB quota and no retention cleanup in this MVP; quota failures refuse persistence instead of claiming success. Native reader-output truncation is unverified. If both storage and agent listing fail, loop-scoped tools fail closed, potentially affecting an otherwise excluded loop; root tools without a loop ID remain unchanged.

## Hook failure policy (agent-adopted, 2026-10-28)

- [Failure semantics](https://code.claude.com/docs/en/plugins/mods/events#handle-a-hook-that-fails): an uncaught throw, timeout or invalid result skips the hook before `next`, so even a gating hook fails open. After `next`, its result stands without dispatching again. A registration's `.catch` may return the event's normal result/refusal, forward through `next`, or leave the hook absent with `undefined` ([public declarations](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts), `CatchHandler`). If the catch itself fails, the host falls back to the same skip/replay behavior.
- [`next.error` and `next.called`](https://code.claude.com/docs/en/plugins/mods/reference#the-hook-function): catch reasons are `throw`, `timeout` or `re-entry`; when already called, catch's `next(event)` replays the prior settled outcome, including any rewritten call, rather than running it again. Handlers have a [one-second execution budget](https://code.claude.com/docs/en/plugins/mods/reference#limits); these handlers make no host API calls or retries of their own.
- `session.start`, `classic.PostToolBatch` and `classic.SubagentStop` explicitly fail open through replay-safe `next`. Failed tool registration must not stop a session; nudges and the bounded final-reply correction are advisory. Existing downstream blocks, context and stop decisions remain unchanged, with no extra correction or continuation on failure. The streaming `turn.step` observer keeps its existing local fail-open measurement handling; no additional streaming catch is needed.
- `tool.call` first checks `next.called` and replays any prior outcome unchanged, including native handback success, refusal or error. Before dispatch, a failure refuses loop-scoped calls and this adapter's tools with a diagnostic identifying the failure kind. Ordinary root tools pass through. Do not re-read storage or agent listings in the catch: an uncertain closed-child gate must not reopen or forward an unshaped report, and adapter failures must not fall through or claim successful storage. This intentionally can refuse an open child or excluded loop on exceptional failure; it does not change the unknown-usage fail-open rule or successful-path isolation.
- Credit-free fixtures exercise all three failure kinds before and after `next`, checking one downstream effect, prior-result identity, unchanged stored text, root pass-through and loop/adapter refusal. An injected uncaught handover error also verifies no persistence/dispatch and release of the in-flight latch. Timeout/re-entry and host replay are contract fixtures, not real host execution evidence.
- Verification: `npm run typecheck` passed; `npm test` passed all 193 tests (17 catch-policy additions). `claude plugin validate .` passed with all three registrations reported as "gating hook with .catch"; the three missing-catch warnings are gone. Unrelated author/icon warnings and installation advice remain. `git diff --check` passed. Independent review found no blocking issue.
