# Kilo adapter

## Goal and scope

- Assess current Kilo CLI and VS Code extension plugin surfaces; prefer existing OpenCode entry reuse where compatible.
- Pin Kilo `7.8.23`, source `722e4656118fbcdad602179ffd8bde0237007e4a` and plugin/SDK contracts. Root OpenCode V2 `2.1.4` requires session/tool/storage APIs absent from Kilo's legacy hook surface, so direct reuse is not viable.
- Implement the smallest measured root advisory/storage adapter using shared pure measurement and guidance, direct TypeScript, host-attributed tools and manual fresh-session reader continuation. No native child automation, source lock, hard gate, compaction replacement or UI following.

## Acceptance and approach

- Verify pinned hook call sites and normalization semantics before adapting measurement; use the active compaction-filtered message view, not session totals.
- Immutable private file storage, verbatim model text and explicit unknown diagnostics; ordinary notice failures fail open, writer identity/storage failures are explicit.
- Cover registration, measurement/staging, root/child attribution, immutable storage/readback, unknowns and reload with unit tests using `os.tmpdir()`.
- Preserve existing entrypoints/manifests, add isolated non-model Kilo installation/load evidence, typecheck, full tests and Claude plugin validation.
- Document installation, adapter checklist, source-cited assessment, tentative decisions and final evidence here; archive on completion.

## Current evidence

- Official Kilo plugin documentation declares the same server-plugin surface in the current CLI and VS Code extension. Runtime parity remains unobserved.
- Pinned `plugin/index.ts` accepts legacy function/descriptor hooks, not OpenCode V2 `Plugin.define` setup context. Kilo's experimental V2 context also lacks the required session/tool/storage domains.
- Pinned `session/prompt.ts` invokes message transform before conversion on filtered active history; system construction, editor-context injection and pruning occur later. This limits any pre-conversion measurement claim.

## Outcome

- Implemented `kilo/index.ts`, 35 isolated unit tests and TypeScript/package wiring with exact plugin/SDK development dependencies `7.8.23`. Reuse is limited to pure measurement, thresholds, stages and guidance; real Kilo rejects the root V2 entry.
- README installation, 12-row adapter checklist, pinned capability assessment and tentative decisions updated. Current extension shares the CLI backend by source; only CLI loading/registration is observed.
- Review corrections: skip compaction's paired transform, use prefixed ids bound to the actual output message, test host-Zod conversion and document its per-argument-description loss/reload intro behavior. Integration review also excluded summary-worker and retained pre-summary usage anchors by chronology. No unresolved correctness finding from that review.
- Verification: `npm run typecheck` passed; `npm test` 708/708 passed (Kilo 35/35); `claude plugin validate .` passed with author warnings/icon advisory. Isolated CLI reports 7.8.23; actual tool-id endpoint lists both tools exactly once, root-entry control lacks both and logs descriptor rejection. Latest adapter source reloaded successfully after the anchor correction. No model compliance/continuation claim.
- Audit disposition accepted: exact Kilo development types retained without overrides. Added vulnerable Effect/TOML and host-Zod nodes are development-only, Kilo imports are type-only, and only conversion tests load host Zod. Existing runtime dependencies unchanged; this exposure boundary is documented in the assessment/decisions and must be reassessed before runtime imports change. Other audit findings predate this adapter.
- Final integration recheck: typecheck and all 708 tests passed after explicit SDK declaration; audit inspection confirmed the development-only nodes and type-only imports. All acceptance items complete within the non-model scope; extension loading, model hook dispatch/compliance and manual continuation remain unverified.
