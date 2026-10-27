# Backlog

1. OpenCode V2 adapter MVP: built; template, timing wording, variant preservation and rename done. Remaining, in order:
   1. TUI companion that follows rollovers to the successor session (follow only; no review or interactive UI).
   Shelved: subagent `reset` (low value vs `return`; background-compaction blocker), TUI draft review. Removed: `draft` (in git history, `a7f77ad`). Done: per-child soft marker. Live-verified: lock, hard ceiling, loop guard, seed warning, links, pre-nudge restraint, draft, marker. Unverified live: nondefault variant carry-over.
   Handover storage is session-keyed KV (`docs/decisions.md`). Research: `docs/research/prior-art.md`.
2. Claude Code adapter research (first of the further harness adapters: Claude Code mods, Gemini CLI, Pi), after the OpenCode adapter is proven.
