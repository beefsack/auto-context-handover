# Copilot CLI adapter

- Goal: assess the current `@github/copilot` CLI against the adapter checklist;
  ship the smallest useful adapter only if measured handover and trustworthy
  session routing are established.
- Scope: primary documentation, isolated non-model CLI/package inspection,
  hooks/plugins/MCP and child delivery; preserve existing adapter entrypoints
  and native compaction. No speculative measurement proxies.
- Acceptance: cited capability/requirements assessment, explicit evidence
  distinctions, README/checklist updates, tentative decisions, independent
  review, typecheck/full tests and existing Claude plugin validation. If an
  implementation is feasible, add fixture tests and isolated installation
  checks; otherwise record exact blockers and unblock conditions.
- Plan: investigate contracts and installed package; decide feasibility;
  implement only supported behavior; review and verify; archive this note.
- Material finding: experimental CLI extensions join the foreground SDK
  session and expose child-attributed usage events, tools and lifecycle hooks;
  command hooks alone lack usage. Ship a child-first extension, not an SDK
  replacement harness. Roots receive continuation guidance/read access only.
- Approach: standalone legacy Copilot plugin directory, leaving root manifests
  unchanged; latest host current-window snapshot, shared threshold/stage
  semantics, immutable verbatim storage and native stop-result rewriting.
- Accepted evidence: final isolated CLI 1.0.105 local subdirectory install and
  JSON listing succeeded (enabled 0.1.0), with no MCP servers configured as
  intended. Installed runtime logic matched the final source byte-for-byte.
  Existing Claude plugin validation passed with existing metadata warnings.
  Neither observation establishes Copilot extension launch or model compliance.
- Candidate repair: genuine checkJs/SDK production types, ephemeral child
  measurements, strict arguments, host provenance and native stop rewriting.
  Direct final checks: typecheck passed all six projects; 48 Copilot fixtures
  passed; full suite passed 543 tests/85 suites, zero failures/skips/cancellations.
  Tests use os.tmpdir() with cleanup. Diff whitespace checks passed.
- Independent documentation review clarified defer policy, whole-window
  numerator, mode bits and adapter-owned failure handling. Official hook docs
  confirm last-response-rewrite precedence; extension-manager name remains
  unverified rather than invented.
- Independent runtime review confirmed two gaps: unused seed-size logic and
  fail-open direct-reader caller-closure checks. Reader now measures handover
  chars/4 against recorded soft, warns only above 50%, and reads caller closure
  strictly before any target. Boundary/unknown-soft, verbatim-once and corrupt/
  unreadable/unrelated-caller fixtures cover the fixes. Follow-up review passed
  with no serious residual findings; top-level lifecycle identity and native
  stop rewriting match SDK contracts and needed no change.
- Ordinary hooks, including pre-tool denial, deliberately remain fail-open on
  closure storage errors; docs and a regression make this limitation explicit.
  Both direct tools fail explicitly. No stronger enforcement was introduced.
- Outcome: self-contained child-first extension, cited assessment, README and
  all twelve adapter rows updated; three tentative decisions recorded.
  Root plugin manifests and existing adapter entrypoints remain unchanged.
- Remaining limits: extension launch, actual callback routing, child usage
  cadence, model compliance and parent receipt are unverified. General-purpose
  lifecycle and absent attribution are unsupported. No root rollover, quotas,
  TTL, eviction, original-task capture, lineage or compact reader. Native
  compaction is unchanged; direct installs carry a deprecation warning.
