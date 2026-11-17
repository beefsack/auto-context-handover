# Pi model-preserving roots and parent-directed child continuation

## Goal and scope

Preserve the current model and thinking level across top-level Pi rollover, and let detected children hand back a recoverable handover instead of attempting their own session replacement. Keep native compaction and other adapters unchanged.

## Material decisions

- Snapshot the predecessor's current provider/model and thinking level before replacement, not the model recorded at an earlier handover write. Carry this plain selection in seed metadata. The new extension instance restores model then thinking during `session_start` reason `new`; fresh `withSession` verifies a successful restoration receipt and effective selection before kickoff. Resume, reload and startup do not replay selection. Failed authentication, unavailable models and mismatches report an error and withhold continuation rather than using defaults.
- Pi has no public child-identity or replacement-capability signal. Recognize pi-subagents' host-built `<active_agent name="..."/>` system-prompt marker or `PI_SUBAGENT_CHILD=1`; do not use `parentSession` or UI mode as identity. This covers its foreground/background and memory-only child construction paths without importing private internals. Missing markers in other child runtimes can admit root behavior; inherited/forged markers can suppress automatic root rollover. User-issued `/handover` bypasses classification and stored closure, reads the source branch independently of shared storage, and still restores/verifies model and thinking selection from adapter seed metadata in the successor.
- Store full handover and summary verbatim in both session entries and one private shared JSON file per host-derived session ID under `join(getAgentDir(), "auto-context-handover")`. SHA-256 filenames, directory 0700/files 0600, atomic temporary-file rename. Retain the latest shared record per ID indefinitely, with no TTL, quota or automatic eviction. No fsync durability or same-user filesystem sandbox promise; crash-leftover temporary files may remain. Failed shared publication requests no continuation, but a branch entry may remain.
- `read_handover({"sessionID":"..."})` reads any retained session by ID, not a path. `{}` preserves the latest active-branch reader for compatibility. Explicit-ID readback is latest-per-session, independent of branch navigation.
- Children never create successors. Successful storage closes the predecessor and returns exact final-reply guidance, without `terminate:true`, so the native parent can receive assistant text. That reply includes the short summary, predecessor ID and exact reader call. The parent reads full text and manually spawns a same-type logical replacement with its own steering/model choices and a reference-only prompt requiring full readback and continuation from "Prioritized next steps".
- Later tool calls, repeated writes and reads are refused for closed predecessors; the next turn repeats final-reply guidance. An explicit user-issued `/handover` remains a recovery override. Unreadable/corrupt shared completion state preserves retained branch closure and fails closed for classified children; an otherwise open root warns once but retains tools, branch readback and manual recovery. A fresh root write can repair corrupt shared JSON. This is model-guided completion with tool-hook refusal, not guaranteed final-message delivery or a hard session-stop boundary. Child threshold propagation remains outside this change.

## Evidence and outcome

- `npm run typecheck` passed all twelve TypeScript projects.
- `npm test` passed 789 tests, including 44 Pi fixtures. Eight new Pi tests cover foreground/background child handling, persistent closure after reload, cross-session verbatim readback, hashed private latest-record storage, malformed/inaccessible shared state, new-instance model/thinking restoration and failure matrices, misclassified-root manual recovery, and non-bricking shared-state corruption handling.
- Existing root automatic dispatch, branch/run scoping, manual recovery, cancellation, seed and stale-context failure fixtures remain passing. The README capability row now describes automatic root rollover rather than manual-first behavior.
- Static inspection of the assessed Pi SDK confirms new-session setup precedes the fresh instance's `session_start` reason `new`, which precedes `withSession`; UI flags do not expose whether replacement handlers are bound. pi-subagents construction supplies its marker in both prompt modes; memory-only children need not have a parent-session header.
- Independent static review of the five changed files, including manual recovery and corruption-handling fixes, found no blockers. The review did not independently execute tests.
- New model-preservation and child behavior have fixture/static evidence only. Real-model final-reply delivery, parent read-then-replace compliance and interactive end-to-end selection preservation remain unverified.

## Remaining live checks

- With an explicitly chosen top-level model and thinking level, confirm a seeded successor retains both before its first provider request; unavailable selection must produce no default-model kickoff.
- For foreground/background and memory-only detected children, confirm storage produces a final assistant continuation reply visible to the parent, no child replacement session, exact cross-session reader call, and later-work refusal.
- Confirm the parent reads the complete handover, supplies its own steering to a same-type replacement, and the replacement reads the predecessor by ID before continuing without duplicated work.
