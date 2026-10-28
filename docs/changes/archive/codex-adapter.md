# Codex CLI adapter

## Goal and scope

Assess current OpenAI Codex CLI against the adapter requirements using primary
documentation, pinned source and isolated non-model CLI checks. Ship the smallest
useful adapter only if context measurement, identity, trusted introduction and
handover delivery contracts are established; otherwise document the blockers.
Native compaction and existing adapters remain unchanged.

## Acceptance

- Capability assessment distinguishes documented, source-established, observed
  and unverified evidence, with citations and a pinned release.
- Cover all requirements in `docs/adapters.md`, especially transcript usage,
  child identity/delivery, introduction placement, MCP caller binding, packaging
  and hook trust.
- If feasible, provide no-build implementation, fixture tests and isolated
  registration validation. If blocked, state the exact unblock path instead.
- Update README, adapter checklist and tentative decisions; independently review
  the result; run typecheck, tests and Claude plugin validation.

## Approach

1. Establish release, hook/plugin contracts and feasibility from source and CLI.
2. Review feasibility before choosing implementation or assessment-only scope.
3. Complete documentation and any feasible implementation, independently review,
   verify and archive this note with accepted evidence.

## Design

- Target npm `@openai/codex@0.165.0`, source tag `rust-v0.165.0`.
  Thread-spawned subagents have host-derived ids in lifecycle/tool hooks.
- Use source-established synchronous `PostModelRequest` usage observation and
  staged notices at tool boundaries. These observation-only hooks are absent
  from the public hooks guide; require the pinned release and disclose this.
- A plain MCP server receives no caller id. Bind calls using synchronous
  `PreToolUse`: save an immutable request containing host identity and original
  arguments under a random single-use capability, then rewrite MCP arguments
  to that capability. The MCP server rejects unbound/direct calls. Missing or
  failed hooks therefore cannot grant model-supplied caller authority.
- Keep roots context-only, children handover-capable, open reads for live
  callers, and persistent child closure. Defer original-task capture, lineage,
  spawn-override provenance, automatic spawning and root rollover.

## Outcome and accepted evidence

- Shipped `codex/` lifecycle hooks, private file storage, host-bound MCP server
  and fixtures; portable root manifests and compatibility overlay. Existing
  adapters remain unchanged. `@modelcontextprotocol/sdk@1.32.2` is a declared
  runtime dependency; direct TypeScript loading needs no build.
- [Assessment](../../research/codex.md) records the capability table, primary
  source pins, hook trust UX, requirements coverage and limitations. README and
  the adapter checklist describe installation and the partial coverage honestly.
  Seven tentative decisions are recorded in the Codex section of decisions.md.
- Direct verification: `npm run typecheck` passed four projects; `npm test`
  passed 434 tests, including 64 Codex fixtures, zero failures/skips. Isolated
  `claude plugin validate .` passed with existing author/icon warnings.
- Direct isolated Codex checks: the existing repository marketplace registered,
  plugin installation/listing showed enabled 0.1.0, `mcp get` showed the expanded
  installed-root stdio command/cwd and PLUGIN_ROOT/PLUGIN_DATA. An SDK stdio
  client initialized the installed server, listed both tools and observed an
  unbound call rejected (`isError:true`, empty stderr). Narrow subsequent
  readback/branch cleanup changed no manifest or tool schema; final source is
  covered by the final suite, not a new installed-host behavior claim.
- Investigation evidence: npm/CLI version 0.165.0, source tag/commit established;
  source proves host child identity, latest-response usage, synchronous observer
  ordering, MCP argument rewriting and best-effort native final-text routing.
  Separate non-model command-hook probes reported correct JSON from a foreign
  cwd and spaced data path. These are reported probes, not real host hook firing.
- Independent review: no security defects found; exact payload-key evidence
  request resolved with pinned runtime/schema/upstream fixture citations.
  Removed the unregistered PreModelRequest branch. Added missing reader
  extraction/truncation and exact chars/4 seed-warning edge fixtures.
  Orphan claim files on crashes remain explicitly documented.
- Integration inspection caught missing root reader binding before acceptance;
  fixed and covered with root-hook-to-server read/refusal tests. A worker's
  initial provenance test expected nudging from measurement alone; corrected
  the fixture to emit a notice first, preserving the observed-notice oracle.
  The initial conservative chars-as-tokens warning was replaced with the
  intended chars/4 estimate and exact shared boundary fixtures.
- Setup failures were not product results: a custom marketplace at the wrong
  manifest location failed, then succeeded at the documented location; a final
  isolated home was initially absent, then created. `doctor` ignored a bogus
  hook event, so it was rejected as a hook validator.

## Remaining verification limits

- Source-only PostModelRequest contract is deliberately pinned and disclosed.
  Hook loading/override is source/documentation-established, not independently
  observed through a noninteractive hook listing/validator. Real hook execution,
  trust review, model compliance, final receipt and successor continuation remain
  unverified. No end-to-end or live-model success is claimed.
- No original task capture, lineage, requested-override provenance, automatic
  spawn/root rollover, hard threshold gate, quota or automatic eviction.
