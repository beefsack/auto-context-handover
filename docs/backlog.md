# Backlog

1. OpenCode V2 adapter MVP: built; template, timing wording, variant preservation and rename done. Remaining, in order:
   1. `draft` action (handover stored for user review before any successor starts; loop-guard fallback instead of lock).
   2. Subagent `reset` (continue the child in place after handover, so the parent is not orphaned).
   3. TUI companion that follows rollovers to the successor session.
   Live-verified: lock, hard ceiling, loop guard, seed warning, links, pre-nudge restraint. Unverified live: nondefault variant carry-over.
   Handover storage is session-keyed KV (`docs/decisions.md`). Research: `docs/research/prior-art.md`.
2. Claude Code adapter research (first of the further harness adapters: Claude Code mods, Gemini CLI, Pi), after the OpenCode adapter is proven.
