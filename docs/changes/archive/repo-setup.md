# Repository setup

## Goal and scope

- Add concise root guidance derived from OmniTiler, adapt project facts, and prepare the existing plugin and documentation for version control.
- Keep product behavior and recorded decisions unchanged; exclude dependencies, build/test artifacts, secrets, and machine-specific configuration.

## Acceptance and approach

- Preserve applicable live-test isolation, local-system privacy, repository-record, and dependency-management rules; drop platform/fixture and Rust/Nix/mise specifics.
- Check sibling guidance against project principles and decisions, inspect candidate content and ignore rules, and run `npm run typecheck` and `npm test`.
- Use the sibling's observed type-prefixed commit style for the initial plugin snapshot and repository setup.

## Outcome and accepted evidence

- Root guidance and ignore rules complete; machine-specific installation examples and one historical config reference generalized without changing their meaning.
- No conflicts found between applicable sibling rules and project principles or decisions.
- Direct verification: `npm run typecheck` passed; `npm test` passed 77/77. No live/model behavior tested in this change.
- Direct `git check-ignore` confirmed dependency, build, coverage, and TypeScript incremental artifacts are excluded. Candidate inventory contains only source, package metadata, documentation, and repository guidance.
- Candidate credential/path scans found no secrets or machine-specific paths after cleanup; lockfile resolutions use the public npm registry. Existing historical records and product decisions otherwise preserved.
- Staged inventory verified: 23 project files, no dependencies, build/test artifacts, credentials, or local-only files; `git diff --cached --check` passed.
