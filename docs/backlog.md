# Backlog

1. OpenCode V2 adapter MVP: built; template, timing wording, variant preservation and rename done. Remaining, in order:
   1. Isolated live tests of existing behaviour: `onHandover.primary: "lock"`, `hard` ceiling, experimental loop guard (README test plan).
   2. `draft` action (handover stored for user review before any successor starts; loop-guard fallback instead of lock).
   3. Subagent `reset` (continue the child in place after handover, so the parent is not orphaned).
   4. TUI companion that follows rollovers to the successor session.
   Handover storage is session-keyed KV (`docs/decisions.md`). Research: `docs/research/prior-art.md`.
2. Claude Code adapter research (first of the further harness adapters: Claude Code mods, Gemini CLI, Pi), after the OpenCode adapter is proven.
