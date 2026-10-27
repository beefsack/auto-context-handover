# Rename to auto-context-handover

## Goal and scope

- Rename package, plugin id, current README/docs references, and pinned code/tests to `auto-context-handover`.
- Keep `context_handover` and `read_handover`, the existing repository directory and absolute paths, historical `docs/research/` and `docs/changes/archive/`, and Orchestrator-owned `docs/backlog.md` unchanged.
- Do not migrate stored data, edit live configuration, commit, or push.

## Acceptance and approach

- Delegate one bounded rename/investigation unit; inspect its diff and independently review the public identity/storage contract.
- Regenerate the package lock; pass typecheck, tests, and package dry run after final edits.
- Report intentional old-name hits, config impact, and plugin-id KV namespace impact with source citations; identify unverified behavior.
- Record the user's 2026-10-27 naming decision and retained tool names in `docs/decisions.md`.

## Outcome and accepted evidence

- Complete: package/lock, plugin id, KV key prefix, diagnostics/nudges and pinned test fixtures now use `auto-context-handover`; tools and directory paths are unchanged. README positioning stays factual, and its verification paragraph distinguishes pre-rename live checks from current checks. Naming decision recorded in `docs/decisions.md`.
- Changed: `package.json`, `package-lock.json`, `README.md`, `source/index.ts`, `source/store.ts`, `source/config.ts`, `source/text.ts`, `source/gate.test.ts`, `docs/decisions.md`, and this note. Implementation Worker reports regenerating lock with `npm install --package-lock-only --ignore-scripts`.
- Lead directly ran after final production/README changes: `npm run typecheck` passed; `npm test` passed 77/77; `npm pack --dry-run` produced the expected `auto-context-handover-0.1.0.tgz` manifest, 12 files. No archive was created by the dry run.
- Lead's standalone-old-name grep found only README absolute paths (lines 20, 50), historical `docs/changes/archive/opencode-v2-mvp.md` (lines 3, 24), and Orchestrator-owned `docs/backlog.md` (line 4). Existing historical/research records and backlog were not edited.
- Lead directly verified the live config's plugin package still points at the unchanged repository directory: no config change needed while the directory stays put; no live config edits made.
- KV finding, directly inspected checkout `19d87a7`, `packages/core/package.json:3` version 2.1.4: `packages/core/src/plugin.ts:80-81` supplies `PluginHost.storage(kv, plugin.id)`, and `packages/core/src/plugin/host.ts:654-680` prepends an encoded plugin-id namespace to every KV operation. Renaming id makes old handovers, links, locks, and loop state inaccessible; pre-rename `read_handover` reports no stored handover, and new-id deletion cleanup cannot remove old-namespace keys. Key-prefix rename also intentionally uses the new project name. Accepted test-data loss, no migration or deletion.
- Independent read-only Worker review found no blocking contract violations; its stale-note observation is resolved here. Lead inspected actual identity/storage/config files and current status. All repository content was already untracked, so no tracked diff or pre-rename baseline exists to prove changes mechanically; current content was reviewed against the contract instead.
- Implementation Worker reported one failed initial test run from a missed capitalized nudge regex; corrected that fixture and passed. Final Lead checks above pass; no unresolved failed approach.
- Unverified: renamed-id live activation, actual live KV orphaning, and end-to-end model/manual behavior. Namespace impact is source-derived, not a live-data experiment. No paid model calls, commits, pushes, data migration, directory move, or live mutations.
- Next action: Orchestrator can remove/advance its project-name backlog item. No implementation work remains.
