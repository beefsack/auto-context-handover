# Adapter guidance clarity and requirements

## Goal and scope

- Tighten Claude guidance without dropping workflow rules or changing behavior; shared wording may also affect OpenCode.
- Add a point-of-use adapter requirements checklist with evidence links and explicit adapter status.
- Preserve exact markers, parser contracts, source exports, thresholds, lifecycle behavior and retention design. Principles remain unchanged.

## Acceptance

- Root/child introductions, short replies, notices, tool results and reader output avoid unnecessary repetition while retaining every existing rule.
- Requirements cover trusted context, deferred tools, precedence, escalation, parent authorization/count limits, delivery/recovery, successor provenance, reference seeding/lineage, growth, storage and diagnostics.
- Updated unit coverage, typecheck, full tests and plugin validation pass; independent semantic review finds no blockers.
- Report final guidance text, before/after character lengths, shared OpenCode-visible changes and verification limits.

## Approach and units

1. Tighten guidance and corresponding tests; capture original/final lengths and shared-text impact.
2. Add the evidence-linked adapter guide and developer README link.
3. Independently review rule preservation and guide accuracy; resolve findings and verify.

## Verification and outcome

- Claude root guidance states the ask-only policy, progress-stall/growing-work exception and context-size prohibition once. Short/locked replies require parent readback before decisions and refer to the reader-provided successor pointer instead of repeating its payload framing.
- Trusted child introduction, deferred tool loading, current-step precedence, read-only storage permission, mandatory native handback and reader framing remain intact. Stage notices and shared/OpenCode text are unchanged.
- Added `docs/adapters.md` with evidence-linked requirements and explicit root/child adapter differences, fixture coverage versus live evidence, and unassessed future adapters. README links the guide.
- Direct verification: `npm run typecheck` passed; `npm test` passed all 293 tests; `claude plugin validate .` passed with non-blocking author/icon warnings and install-line advice.
- Independent review found no blockers in rule preservation, marker/parser compatibility, adapter status or evidence links; the reviewer independently reran typecheck and all 293 tests successfully.
- Character lengths before/after: root introduction 1862/1595; child introduction 1473/1450; short reply 1227/765; locked reply 977/857 (reply samples use the same summary, child id and provenance). Stage notices remain 1171/1181/1152 characters. Reader framing and shared/OpenCode text are unchanged.
- Complete. No product contract changed, so `docs/decisions.md` needs no amendment. Live parent compliance, multi-generation continuation and native delivery/output limits remain integration risks; no new live compliance evidence is claimed.
