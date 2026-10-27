# Live handover behavior

## Goal and scope

- Verify existing lock mode, hard tool ceiling, and experimental loop guard against OpenCode 2.1.4 with real model requests in an isolated project.
- Confirm normal rollover links, variant preservation, and no unprompted handover during ordinary completion.
- Fix demonstrated defects without changing recorded product intent. Draft, reset, and UI following remain out of scope.

## Acceptance and approach

- Preserve exported session evidence for each behavior and distinguish direct observations from source-only conclusions.
- Use small thresholds above measured prompt overhead and bounded requests; stop rather than manufacture a loop-guard result if realistic triggering is impractical.
- Correct the manual test plan and record reusable findings at point of use.
- Add regression coverage for defects; require typecheck and tests before completion.

## Units and verification

1. Inspect headless execution and source contracts; run isolated baseline, lock, and hard-ceiling checks.
2. Exercise rollover and loop guard with measured pre-call snapshots; inspect evidence and repair defects if demonstrated.
3. Review changes and evidence, run final checks, and archive this note with outcomes.

## Outcome and evidence

- Preserved existing backlog changes and partial evidence. Removed fixed model selections from isolated test configurations; manual guidance now requires explicit per-run model input without defaults.
- Baseline verification: typecheck passes; all 77 tests pass.
- Accepted live evidence: lock session `ses_e83a6c47affedEEuurjlMMJysX` has no tools after handover and no successor; hard session `ses_e83a59631ffes4ZfJ7Hu25JwTl` exposes only `context_handover`, which completes. The first lock-session request completed without a nudge or handover call. Exported tool results and a post-plugin context observer corroborate these outcomes.
- Defect fixed: a later locked request refused tool use but omitted the stored-text pointer. Merely appending the hint failed live: a fresh process delivered it, but the model still returned a pointerless refusal. The second approach explicitly prescribes a refusal containing the session ID and cross-session reader hint, following the existing short-reply pattern; the child path is unchanged. A fresh-process recheck visibly returned the exact refusal with `read_handover` and `ses_e83a6c47affedEEuurjlMMJysX`, with no new tool calls or successors. Regression coverage checks primary locked directives and retries. Final direct verification: typecheck and all 78 tests pass.
- Accepted live rollover/seed evidence: `ses_e83a0ea2cffepyuo5zNHA6c387` -> `ses_e83a08dd6ffef1lu2rnSJuhMCy`, soft 1000, full seed estimate about 1759 tokens; the >50% warning appears in the successful tool result.
- Accepted loop evidence: `ses_e839fc4bdffe8n7DZLKmcSlw5O` -> `ses_e839f9774ffePO2FcMKMwb0fuD` -> `ses_e839f689effeiVxbHM3hqDD5zi` -> `ses_e839a8dbfffeznhPZNRXrgdOc7`. The last handover reports three consecutive unproductive successions and creates no fourth successor; subsequent tools are empty. This fixture used soft 120000 and short exchanges, not a large transcript. Offline estimates of about 7600-9700 added tokens were below its 30000-token productivity boundary; these are approximate export-based calculations, not direct internal snapshots.
- Live readback from `ses_e839a1aaeffeXEKAGoWbyMPjOn` exposes the root forward link, intermediate forward/back links, and final predecessor-only link. All exported roots have no parent and retain the `default` variant.
- A client timeout was reported and retried; inspected exports show no duplicate rotation. Total live execution: 22 headless CLI attempts including that retry and both refusal rechecks, plus four automatic successor seed admissions. No test server remains running.
- Final review found the source change minimal and consistent with the lock contract. Direct inspection of final session exports and the full post-plugin directive confirmed the last pending live acceptance condition. Existing backlog content is unchanged.
- Unverified live: productive reset, nondefault variants, and compaction readback. Existing harness checks for variants, loop-streak reset, and stored text remain passing; no additional behavior was introduced.
