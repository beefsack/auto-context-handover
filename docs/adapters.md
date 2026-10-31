# Adapter requirements

Harness-independent checklist for current and future harness adapters,
distilled from live-test findings. Status words: **live-verified** means
observed with a real model and host; **fixture-covered** means the
implementation is covered by unit fixtures while live compliance is not
established; **absent** means the adapter has no such mechanism.
Fixture coverage is never live compliance.

Adapter-specific retention policy is recorded in `decisions.md` with
[Claude retention evidence](changes/archive/claude-size-retention.md); Claude uses
size-based whole-chain eviction with compact closure tombstones, while OpenCode
cleans session-keyed records on session deletion.
Claude's legacy/orphan exception applies only when no lineage is claimed;
malformed, conflicting, unresolved or unreadable membership remains protected.
Store accounting includes unknown keys without making them eviction candidates.
Claude also retires per-child measurements at actual turn completion, preserves
handback correction across blocked stops, and bounds auxiliary histories.
Lost transient diagnostics remain `unknown`; durable closure locks survive.

| # | Requirement | OpenCode | Claude Code | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Standing guidance lives in a trusted pre-prompt channel; later notices reference it. Tool-result-adjacent instructions may be rejected as injection. Nothing here claims system-prompt priority. | Absent by design: no start intro. Nudges append to the END of request messages, never the system prefix (live-verified). | Child intro via start hook, root intro via session start; every staged notice references the intro. Fixture-covered; live model compliance pending. | [Claude child plugin introduction](decisions.md#claude-child-plugin-introduction-2026-10-28), [Claude parent continuation context](decisions.md#user-decision-claude-parent-continuation-context-2026-10-28), [child-plugin-introduction note](changes/archive/claude-child-plugin-introduction.md), [parent-continuation note](changes/archive/claude-parent-continuation.md) |
| 2 | Deferred tools are named in full with their loader, because deferred descriptions are invisible until loaded. | n/a: tools register directly; the hard gate keeps `context_handover` callable (live-verified). | Every intro/notice names the full handover tool plus its `ToolSearch` loader. Fixture-covered; live loading compliance pending. | [Self-sufficient Claude child notices](decisions.md#user-decision-self-sufficient-claude-child-notices-2026-10-28), [nudge-escalation note](changes/archive/claude-child-nudge-escalation.md) |
| 3 | Where task instructions conflict, the notice states precedence for the current step, permits plugin-storage writes under read-only tasks, and bounds "unit of work" to the current step. Shared text alone does not establish this. | Partial: shared child guidance replaces this session's required final report and permits handover-tool plugin-storage writes under read-only tasks before storage (fixture-covered). No trusted intro or added current-step definition; stage leads unchanged. Live compliance pending. | Stated in the child intro and every staged notice. Fixture-covered; live compliance pending. | [Text-only OpenCode parity](decisions.md#user-decision-text-only-opencode-parity-2026-10-28), [Self-sufficient Claude child notices](decisions.md#user-decision-self-sufficient-claude-child-notices-2026-10-28), [child-plugin-introduction note](changes/archive/claude-child-plugin-introduction.md), [nudge-escalation note](changes/archive/claude-child-nudge-escalation.md) |
| 4 | Escalation across rising fractions of soft with stable stage leads. Offsets and boundaries are adapter-configurable; an opt-in hard gate is a separate mechanism, not part of escalation. | Configurable offsets (defaults 0/0.1/0.2) sharing leads with Claude; opt-in hard gate (live-verified). Explicit live boundary verification not recorded. | Fixed soft, soft x 1.1, soft x 1.2 boundaries via shared leads. Fixture-covered; live escalation compliance pending. | [Claude Code MVP](decisions.md#claude-code-mvp-subagents-only-2026-10-28), [Self-sufficient Claude child notices](decisions.md#user-decision-self-sufficient-claude-child-notices-2026-10-28), [Live verification](decisions.md#live-verification-2026-10-27), [nudge-escalation note](changes/archive/claude-child-nudge-escalation.md) |
| 5 | Continuation-by-default must be traceable to user setup, not to the handback text alone. Root structural rollover does not satisfy this for child loops. | Root: structural, successor seeded automatically (rollover live-verified). Child: absent, no parent-facing preauthorization; the reply prescribes a successor but nothing in setup preauthorizes it. Do not credit root rollover here. | Root intro states read-then-replace as the user's configured default. Fixture-covered; live parent compliance pending (a reported parent asked the user instead). | [Claude parent continuation context](decisions.md#user-decision-claude-parent-continuation-context-2026-10-28), [parent-continuation note](changes/archive/claude-parent-continuation.md), [live-handover-behavior note](changes/archive/live-handover-behavior.md) |
| 6 | The successor replaces its predecessor as the same logical subagent under count limits, with the same type, requested model override and variant/effort. Observed absence is `no override`; unavailable is `unknown` (reuse original spawn params including effort); never infer from usage or the root model. Count-limit and provenance rules are harness-specific. | Root: successor retains agent/model/directory and forwards the context hook's variant unchanged (`default` live-verified; nondefault end-to-end unverified). Readback, seeds and child replies state observed variant/effort and require reuse; unknown when unavailable. Child same-type/model/variant guidance and logical replacement are fixture-covered, without requested-override provenance. | Type/model-override provenance and handover-time request effort persist across reload. Replies/readback state observed `turn.step` effort or `unknown` and require original spawn parameters including effort. Fixture-covered; live replacement pending. | [Soft default and successor effort](decisions.md#user-decision-shared-soft-default-and-successor-effort-2026-10-31), [Text-only OpenCode parity](decisions.md#user-decision-text-only-opencode-parity-2026-10-28), [Claude parent continuation context](decisions.md#user-decision-claude-parent-continuation-context-2026-10-28) |
| 7 | Verify the harness's actual final-delivery path before designing around it. A reported single-host observation is not a universal contract. Where the harness provides a native handback path, require it after storage and forward its result unchanged, preserving review. Plain text is an explicit absent-tool last resort only. | Native parents receive the child's latest completed assistant text, not the handover tool result. The result instructs the child to end its turn with the exact continuation reply as its final message (fixture-covered guidance, not deterministic delivery). | Native handback required after storage; delivery status recorded as observed tool success, not parent receipt. Fixture-covered; live receipt pending. | [Text-only OpenCode parity](decisions.md#user-decision-text-only-opencode-parity-2026-10-28), [parity note](changes/archive/opencode-parity-text.md), [Claude handback delivery and recovery](decisions.md#user-decision-claude-handback-delivery-and-recovery-2026-10-28), [handback-delivery note](changes/archive/claude-handback-delivery.md) |
| 8 | Bounded fallback when a child ends without delivery, plus a never-resume rule: the parent reads the handover before messaging and never sends to or resumes a handed-over child, starting a successor instead. A once-per-turn stop correction is one harness's mechanism, not the general requirement. | Locked-child refusal implemented (fixture-covered). Live refusal evidence is root-session only. | Stop correction plus read-before-message recovery implemented. Fixture-covered; live recovery pending. | [Claude handback delivery and recovery](decisions.md#user-decision-claude-handback-delivery-and-recovery-2026-10-28), [Handover status and diagnostics](decisions.md#user-decision-handover-status-and-diagnostics-2026-10-28), [handback-delivery note](changes/archive/claude-handback-delivery.md), [live-handover-behavior note](changes/archive/live-handover-behavior.md) |
| 9 | Seed by reference with lineage; the plugin captures the original task. The short successor prompt (marker plus reader instruction) is passed verbatim with optional redirection appended. The original is captured once from the documented spawn prompt and inherited by reference. Reference-only / no-repeat / predecessor-trust framing; targeted re-reads may resolve explicitly preserved open questions, not repeat completed work. Continue by title, never by section number or relabelled evidence. | Root: full-seed successor prompt; rollover and forward/back links live-verified. Initial child reply: parent reads full, then seeds same-type successor by predecessor `sessionID` reader reference, not pasted text (fixture-covered). No child lineage or original capture. Locked-child refusal retains earlier full-seed wording. Shared framing/open-question wording fixture-covered. | Marker plus reader prompt explicitly requests full text, including before spawn persistence; recorded immediate-predecessor lineage also auto-selects full. Origin-once capture and honest lineage unknowns. Fixture-covered. Earlier multi-generation continuation is reported evidence, not a new live check. | [Text-only OpenCode parity](decisions.md#user-decision-text-only-opencode-parity-2026-10-28), [Reference continuation and lineage](decisions.md#user-decision-reference-continuation-and-lineage-2026-10-28), [Compact readback and provenance](decisions.md#user-decision-compact-claude-parent-readback-and-provenance-2026-10-28), [reference-lineage note](changes/archive/claude-reference-lineage.md), [README Behavior](../README.md#behavior) |
| 10 | Growth stays advisory: the original is stored once per chain, model text stays verbatim, and the seed-size check (>50% of soft) warns only, asking the child to compress carried-over notes at its next handover. No fixed generation cap; checking in on stalled progress or growing remaining work is explicitly allowed. Loop-guard locking and compression advice are per-adapter mechanisms, not a common rule. | Root loop guard (locks after three unproductive successions; productive reset). Lock live-verified; productive reset unverified. Initial child continuation replies allow stall/growth check-ins (fixture-covered); no child growth metadata or automated chain limit. | Compression advice plus stall/growth check-in with no generation cap (parent judgment stays in charge). Fixture-covered; live growth behavior pending. | [Text-only OpenCode parity](decisions.md#user-decision-text-only-opencode-parity-2026-10-28), [Reference continuation and lineage](decisions.md#user-decision-reference-continuation-and-lineage-2026-10-28), [Claude original-task retention](decisions.md#user-decision-claude-original-task-retention-2026-10-28), [Automated handover scope and restored loop fallback](decisions.md#automated-handover-scope-and-restored-loop-fallback-2026-10-27), [reference-lineage note](changes/archive/claude-reference-lineage.md), [README Behavior](../README.md#behavior) |
| 11 | Storage quotas and diagnostics. Quota and retention behavior is per-adapter; do not promise every failure is explicit where fail-open is intentional. Readback shows adapter-defined diagnostics; unavailable fields read `unknown`, including legacy records and post-reload transient loss. | Session-keyed KV cleaned on session deletion (fixture-covered, not live-tested). Diagnostics from the pre-call snapshot including trailing chars/4. Context-hook lock/measurement reads deliberately fail open; mutation-tool reads are strict. | 4 MiB shared store; proposed writes above an estimated 3 MiB reclaim oldest eligible whole chains, retaining closure tombstones and reporting expired reads. Current/active/in-flight/uncertain chains are protected; legacy/untimestamped records sort first, spawn-only orphans participate in activity ordering. Latest-usage stage, independent nudge reason, delivery status, first-measured context and last consecutive request delta (negative allowed). | [Handover status and diagnostics](decisions.md#user-decision-handover-status-and-diagnostics-2026-10-28), [Compact readback and provenance](decisions.md#user-decision-compact-claude-parent-readback-and-provenance-2026-10-28), [Claude size-based retention](decisions.md#user-decision-claude-size-based-retention-2026-10-28), [README Storage](../README.md#storage) |
| 12 | Separate parent decision context from successor working context. Reader access policy is explicit, not inferred from workflow prose. Plugin-recorded provenance overrides conflicting handover prose; the shared template does not ask children to restate their own agent/model/chain. | Full readback remains the default. Any live caller with tool access may read any stored handover by session id; no caller authorization. Shared template change fixture-covered. | Compact parent default: headers, pending decisions, next-steps excerpt, pointer. Explicit `full:true` or recorded successor receives verbatim original/handover; pointer always requests full for spawn races. Unknown extraction points to full, not invented content. Same open-reader policy by child id. Root intro makes provenance precedence explicit. Fixture-covered; new compact behavior live pending. | [Compact readback and provenance](decisions.md#user-decision-compact-claude-parent-readback-and-provenance-2026-10-28), [README Claude adapter](../README.md#claude-code-subagent-only-adapter) |

## Pi root-session MVP

Pi `0.73.1`, pinned source and observed CLI evidence:
[Pi assessment](research/pi.md). **Fixture-covered** below never means model
compliance; only installation/load/registration was observed in the real host.
The root-only scope is deliberate: Pi has no core child primitive.

| # | Pi status against the requirement above |
| --- | --- |
| 1 | `before_agent_start` custom introduction before each loop; host-persisted per user prompt, not system-prefix rewriting. Later transient notices reference it. Fixture-covered; model trust/compliance unverified. |
| 2 | n/a deferred loader: tools register directly. Both tools and `/handover` observed in the real CLI. Allowlists may still disable them. |
| 3 | Intro/notices define the current step (not entire task), replace that session's final report and permit plugin-storage writes in read-only work. Fixture-covered guidance only. |
| 4 | Shared fixed stages soft, soft x 1.1, soft x 1.2. Host estimator and known window, capped integer/default soft and explicit percentages. Unknown usage fails open. Fixture-covered; hard gate absent. |
| 5 | Partial: user must submit `/handover`; thereafter seeding and continuation prompt are automatic. No event/tool-driven replacement; no parent preauthorization claimed. |
| 6 | n/a child replacement/type/count rules. Host owns new-root model resolution; adapter does not select a model or promise override preservation. |
| 7 | n/a native child handback. Root tool stores text and advises ending the turn. Stop/final-message compliance unverified, not intercepted. |
| 8 | n/a child delivery fallback. Root has no lock/never-resume enforcement. Stored handover can be read on the source branch; partial replacement failure recovery is manual. |
| 9 | Root full seed once plus source id/file backlink and host `parentSession`; no reference reader across sessions, original-task capture or child lineage. Shared no-repeat/title-based framing fixture-covered. |
| 10 | Seed >50% of soft warns only; no fixed chain cap or growth classification. Model text stays verbatim. Original-task-once child rule n/a. |
| 11 | Session custom entries in Pi-owned JSONL; active-branch latest lookup; no quota/eviction policy. Ephemeral sessions memory-only; host writes nontransactional. Diagnostics from latest request hook, unknown after reload; fixture-covered. |
| 12 | n/a parent/successor split. Current-branch-only reader takes no target arguments. Source session/effective model are recorded by the host-facing tool, not authored provenance; no model-override claim. Successor receives full seed. |

## Codex subagent-first MVP

Codex `0.165.0`, pinned source, caveats and non-model commands:
[Codex assessment](research/codex.md). **Fixture-covered** never means model
compliance. Installation/MCP registration was observed; real hook firing and
parent continuation remain unverified. Roots are context/read-only.

| # | Codex status against the requirement above |
| --- | --- |
| 1 | Root SessionStart and child SubagentStart extra developer context; later PostToolUse notices reference the introduction. Documented placement, fixture-covered text; trust/compliance unverified. |
| 2 | Full MCP names in intro/notices; no deferred loader established. Both tools listed via SDK stdio. In-session exposure still depends on host policy. |
| 3 | Current-step boundary, replacement of final report and read-only plugin-storage permission stated in intro/notices. Fixture-covered guidance. |
| 4 | Latest input + output from source-only synchronous PostModelRequest, then fixed shared stages at PostToolUse boundaries. No cumulative usage or unstable transcript polling; unknowns fail open. No hard token gate. |
| 5 | Root intro attributes read-then-replace without confirmation to installation default. Fixture-covered; no automatic spawn or live parent-compliance evidence. |
| 6 | Same logical subagent and type/requested override via parent's original spawn params. Host type/effective model recorded; requested override remains unobserved, never inferred from usage. No lineage/type-preservation guarantee. |
| 7 | Native final-text receipt plus bounded SubagentStop correction; source establishes mailbox delivery, not Claude classifier handback. Fixture-covered shaping, actual parent receipt unverified. |
| 8 | Read-before-message recovery and never-resume rule in root intro; persistent closure denies supported tool calls. No universal stop/denial boundary for specialized paths or failed/disabled hooks. |
| 9 | Short reader reference with explicit full read; shared reference/no-repeat/predecessor-trust framing. No captured original task, marker lineage or automatic successor classification. |
| 10 | Shared >50%-of-soft seed warning with chars/4 estimate, compression advice and parent progress check-in; no fixed generation cap. Verbatim retained text. |
| 11 | Private PLUGIN_DATA files, atomic immutable handover+closure, consumed capabilities removed. No quota/eviction/TTL; abandoned pending/temp files can remain. Latest-response diagnostics; unavailable fields unknown. |
| 12 | Compact parent default, `full:true` successor payload once with host provenance and diagnostics. Pending decisions unknown, unsupported next-step extraction points to full. Any live host-bound caller can read any stored child id; closed callers denied. Single-use hook capability supplies caller binding, not model ids. |

## Crush root-session MVP

Assessed release `v0.98.2` and nightly `3538c72`, sources and isolated CLI evidence:
[Crush assessment](research/crush.md). Assessed `v0.98.2` is evidence, not a pin:
the runtime guard accepts any stable major-`0` release, never the nightly lifecycle. Explicit setup authorizes a Unix-socket local-server
integration. Native children bypass hooks. Fixtures and non-model observations
below never establish model compliance or successful continuation.

| # | Crush status against the requirement above |
| --- | --- |
| 1 | Static crush/CONTEXT.md loaded through context-path at agent build; stage notices reference it. Config parsing observed; standing placement source-established, reload cadence/compliance unverified. No dynamic start hook or per-request injection. |
| 2 | Full mcp_auto_context_handover tool names in intro/notices. No deferred loader established; real SDK stdio tool listing observed. In-session exposure/allowlists unverified. |
| 3 | Intro/notices define current step, final-report replacement and read-only plugin-storage permission; setup explicitly authorizes local-server continuation. Fixture-covered guidance, not proof of precedence/compliance. |
| 4 | Fixed shared stages soft, soft x 1.1, soft x 1.2. API reads latest saved prompt + completion, normally one response late at tools, possibly older nonzero values. Window from workspace agent. Capped integers/explicit percentages; unknowns fail open. No hard token gate. Fixture-covered; real usage accuracy unverified. |
| 5 | Opt-in setup enables root creation and one seeded background prompt automatically after model-authored storage, no confirmation. Create/read observed without model; admission wire fixture-covered, real continuation unverified. TUI stays source. No child workflow. |
| 6 | n/a child replacement/count rules. Successor is a root in the same workspace. Workspace owns model resolution; no model/variant/override preservation promise or self-authored provenance. |
| 7 | n/a child handback: child tools bypass hooks. Root final receipt/stop is advisory; HTTP 202 means detached admission, not successful model execution. Native child final-text delivery source-established only. |
| 8 | Stored closure denies/halt supported top-level tools, including both MCP tools. No universal stop or child control; ordinary storage-error checks fail open. Uncertain create/admission requires inspection/manual recovery, never blind retry. Fixture-covered. |
| 9 | Root full verbatim seed once with source backlink and shared no-repeat/predecessor-trust/title framing. No original task capture, child reference seeding or lineage. Fixture-covered. |
| 10 | Actual full seed chars/4 estimate warns above 50% of known soft, compression advice only. No fixed cap/loop guard. Model text remains verbatim. Fixture-covered; host overhead excluded. |
| 11 | Private files 0700/0600; immutable first-writer handover/summary/closure, separate recovery status. No quota/TTL/eviction; pending/temp files may remain. Diagnostics preserve known estimate/current stage/soft, but reason is always unknown: no notice-delivery provenance is persisted between hook processes. Missing fields unknown; no estimated-usage provenance from API. Fixture-covered. |
| 12 | Full readback by sessionID, no compact mode. Any live host-bound root may read any retained id; closed callers denied. Single-use immutable-original-args capability, workspace/session correlation and explicit socket, not model ids or an OS-user sandbox. Fixture-covered; manually invoked hook/read checked separately from actual host firing. |

## Copilot CLI subagent-first MVP

`@github/copilot@1.0.105` experimental CLI extensions:
[capabilities, citations and non-model evidence](research/copilot-cli.md).
Installed plugin listing was observed. Shipped SDK contracts and synthetic
fixtures do not establish actual callback routing, model compliance or receipt.

| # | Copilot status against the requirement above |
| --- | --- |
| 1 | Session/child-start introductions via SDK hooks; later post-tool notices reference installation context. Documented placement, fixture-covered text; trust/compliance unverified. |
| 2 | Direct extension tools, not MCP; defer:never keeps both descriptions available without a loader. Actual registration/visibility unverified. |
| 3 | Current-step boundary, final-report precedence and plugin-storage writes under read-only tasks stated in guidance. Fixture-covered, not guaranteed priority. |
| 4 | Latest child-attributed SDK currentTokens/tokenLimit (whole window, including system and tool definitions), fixed shared stages at soft, soft x 1.1, soft x 1.2. Capped integers/explicit percentages; unknowns silent. No hard token gate or accumulated billing totals. Real emission/cadence unverified. |
| 5 | Root introduction attributes read-then-replace to installed workflow; no automatic spawn. Fixture-covered advisory default. |
| 6 | Same logical child/type/requested override prescribed; host identity/type only, unknown override uses original spawn params. No observed count-limit semantics or model-override provenance. |
| 7 | Native subagent-stop modifiedResponse replaces final parent-returned text with short receipt. Fixture-covered rewrite, actual receipt unverified. General-purpose has no start/stop hooks. |
| 8 | No blocking retry loop: stop rewrite plus persistent closure denies attributed tools. Read-before-message/never-resume guidance; unsupported/disabled hooks and absent attribution are not universal lock enforcement. |
| 9 | Reference reader seed, no-repeat/title-based/predecessor-evidence guidance. No captured original task, automatic successor classification or lineage. |
| 10 | Reader warns when stored handover ceil(chars/4) exceeds 50% of recorded soft; unknown soft skips, reader headers/host overhead excluded. Compression advice only, verbatim text, no fixed generation cap; parent may check in on stalled/growing work. No original-task-once chain storage. |
| 11 | Directories 0700/files 0600, immutable handover/closure via atomic exclusive publish; no quota/TTL/eviction or same-user sandbox. In-memory latest-window diagnostics unknown after reload. Both direct tools read closure strictly; ordinary hooks (including pre-tool denial) fail open on corrupt/unreadable closure. Adapter-owned failure handling, not a guarantee about uncaught SDK errors. |
| 12 | Full readback only, no compact parent mode. Any live caller with tool access may read any retained child id; closed attributed callers denied. Host-bound provenance wins over authored identity; absent invocation attribution refuses handover. |

## AiderDesk root Agent-task MVP

Assessed `0.90.0-dev` / extension types `0.39.0`:
[capabilities, citations and non-model evidence](research/aiderdesk.md).
Real pinned loader registration is observed without Electron or a model;
**fixture-covered** never means actual model compliance or continuation.

| # | AiderDesk status against the requirement above |
| --- | --- |
| 1 | Per-run `onAgentStarted.contextMessages` introduction; transient step-end notices reference it. No system-prefix rewrite or priority claim. Fixture-covered; trust unverified. |
| 2 | Direct custom tools, short names `context-handover`/`read-handover`; full approval ids `aiderdesk---*`. Real loader schemas observed; host policy can disable tools. |
| 3 | Current-step boundary, final-report replacement and dedicated plugin-storage permission under read-only tasks in intro/notices. Advisory, fixture-covered. |
| 4 | Host whole-prompt heuristic (system/tools/saved messages), matched model input window; fixed shared stages, capped integers/uncapped percentages. Unknowns silent. No hard gate. |
| 5 | Absent: advisory/storage-only. User creates/opens a fresh task normally and supplies the reader reference; automatic rollover removed because public fresh-task initialization is unestablished. No child preauthorization. |
| 6 | n/a child replacement. Adapter does not create tasks, select models or promise setting/override preservation. |
| 7 | n/a child handback; children excluded despite native result-transform hooks. Root final stop is advisory, not intercepted. |
| 8 | No source lock or never-resume enforcement. Stored text remains readable after reload; manual continuation only, source must remain loaded/available. |
| 9 | Copyable source task-id reader reference with shared no-repeat, predecessor-evidence and title-based framing; reader returns full text once. No automatic seeding, original-task capture, context-file transfer or child lineage. |
| 10 | Stored model text stays verbatim. No seed-size warning, rewriting, fixed cap, growth classification or loop guard. |
| 11 | HOME plugin files under `~/.aiderdesk/auto-context-handover`, scoped by sha256 of NUL-separated project identity and task id, new directories/files 0700/0600; immutable first-writer handover/summary. No quota/TTL/eviction or task-deletion cleanup; manual retention. Physical files survive worktree removal/movement, but changed project identity prevents normal readback. Latest hook diagnostics; unknown after reload. Shared-directory and cross-project isolation fixture-covered. |
| 12 | Full readback only; any equipped root may read any loaded task in the current project through host lookup. No arbitrary-path or parent-only authorization. Host-recorded task/effective model, no authored provenance/override inference. |

## Cline CLI/SDK root MVP

Official `cline@3.0.74`, SDK/core/shared `0.2.0`:
[capabilities, citations and non-model evidence](research/cline.md).
Package installation and real loader checks do not establish model compliance
or successful fresh-session continuation. Native children are out of scope.

| # | Cline status against the requirement above |
| --- | --- |
| 1 | Root beforeRun appendContext introduction, transient beforeModel notices reference it. First-request hook context, no system-prefix rewrite/priority guarantee. Fixture-covered; compliance unverified. |
| 2 | Direct context_handover/read_handover tools, plain JSON schemas, no deferred loader. Real registration observed; host/plugin/tool policies can hide tools. |
| 3 | Introduction/notices define current-step boundary, final-report replacement and plugin-storage permission in read-only tasks. Advisory, fixture-covered. |
| 4 | Full exposed request serialized chars/4 heuristic (system/messages/tools/modelTools), fixed shared stages. Integer soft default 200000 uncapped; no hook window/percent support. Invalid config disables notices, serialization unknown fails open. No hard gate. |
| 5 | Absent automatic continuation: user creates a fresh equipped session and supplies source reader reference. No parent preauthorization or automatic SDK start. |
| 6 | n/a child replacement/count rules. No model/override preservation promise or model selection. |
| 7 | n/a child handback. Writer stores model-authored strings and advises ending the turn; final delivery/stop compliance unverified. |
| 8 | No source lock or stop correction. Source remains usable but first stored handover cannot be overwritten; manual recovery on corrupt storage. |
| 9 | Fresh-root reference reader, full text once and shared no-repeat/predecessor-evidence/title framing. Recorded source session/agent id; no original-task capture, child lineage or automatic seed. |
| 10 | Verbatim model text; stored-handover-only ceil(chars/4) >50% of recorded soft warns/compression advice only. No fixed generation cap, growth classification or loop guard. |
| 11 | HOME-based private new directories/files 0700/0600, hashed source ids, atomic immutable first-writer publication. No quota/TTL/eviction/deletion cleanup/fsync guarantee; temps may remain. Latest request diagnostics, unknown after reload. |
| 12 | Full readback only; any equipped caller (including children) may read any retained id, no arbitrary path or parent-only policy. Host-bound root snapshot authorizes writes, repeated instance setup refused. Effective model/override unknown, not inferred from authored prose. |

## Amp focused-root MVP

Pinned `@ampcode/plugin@0.0.0-20261028101742-g93a0da1`, offline CLI loader
`0.0.1793203246-g5eab6d`: [capabilities and citations](research/amp.md).
**Fixture-covered** is not model compliance; authenticated routing, UI following
and automatic continuation are unverified. Known children/backgrounds excluded;
parent deletion can make a former child indistinguishable from a root.

| # | Amp status against the requirement above |
| --- | --- |
| 1 | `agent.start.message` introduction after user content; later tool-result notices reference it. No system-prefix rewrite/priority claim; fixture-covered. |
| 2 | Direct registered context_handover/read_handover; offline import/registration observed. Actual in-session names, exposure and loader policy remain unverified. |
| 3 | Intro/notices define current-step/final-report precedence and intro permits plugin-storage writes under read-only tasks. Advisory, fixture-covered. |
| 4 | Active inference-view paged transcript chars/4 plus missing current prompt/result; not full history/billing. Fixed stages; integer soft 200000 uncapped, no window/percent support; unknowns silent. Image/system/schema/deferred overhead omitted. No gate. |
| 5 | Successful source turn end after storage attempts fresh-root creation/seeding automatically, no confirmation. Fixture-covered only; no child parent-default workflow. |
| 6 | n/a child replacement. Source thread.agent() handle creates new root without selecting a model; exact settings/overrides preservation unverified. |
| 7 | n/a child handback. Writer advises ending turn; successful agent.end triggers continuation. Source stop compliance unverified, no interception. |
| 8 | No source lock/stop correction. Exclusive durable attempt claim prevents automatic repeat; reload/error/focus loss can need manual recovery. Uncertain admission requires thread inspection, never blind retry. |
| 9 | Full verbatim seed once, source-id backlink/shared no-repeat/predecessor-evidence/title framing. Manual reader reference available; no original-task capture, child lineage or forward-link transaction. |
| 10 | Seed >50% soft warns/advises compression only; no fixed cap/productivity classification. Stored text unchanged. |
| 11 | HOME private hashed-id files, immutable body/claim and best-effort result status; no quota/TTL/eviction/deletion cleanup/fsync promise. Latest boundary estimate/stage/notice-append reason; lost diagnostics unknown. |
| 12 | Full readback only; any equipped caller can read any retained thread id. Host-bound source id wins over prose; effective model/override/chain unknown. No arbitrary path or parent-only reader policy. |

## Goose root-session MVP

Release `v1.56.0`, pinned contracts and isolated commands:
[Goose assessment](research/goose.md). **Fixture-covered** is not model
compliance. Real host MCP probing/hook parsing was non-model only.

| # | Goose status against the requirement above |
| --- | --- |
| 1 | Absent trusted model-visible standing intro: SessionStart banner is user-only. Self-contained Stop-denial notices supply installation attribution; no system-prefix rewrite. |
| 2 | Full plugin-prefixed names, direct MCP listing observed; no deferred loader established. Installed prefix source-established + drift fixture, actual model-session exposure unverified. |
| 3 | Denial defines current step, final-report replacement and plugin-storage writes under read-only instructions. Explicit setup authorizes denials. Fixture-covered guidance only. |
| 4 | Latest persisted exported usage.total_tokens, else input+output; no cumulative ledger/cache addition. Fixed soft/1.1/1.2 stages; integer-only default 200000 uncapped, window unknown. Unknowns fail open. No hard token gate. |
| 5 | Absent automatic continuation: user opens fresh equipped root and submits reader reference. No parent preauthorization or automatic spawn. |
| 6 | n/a child replacement/count rules. Native children excluded from writing; no model selection/settings/override preservation claim. |
| 7 | n/a child handback. Root tool stores model strings and requests final receipt/stop; actual final delivery/compliance unverified. |
| 8 | No source lock or stop correction after storage. Opt-in Stop denial forces another model turn, bounded by host consecutive-block cap (default8; setup1). Storage found permits Stop. |
| 9 | Manual reader reference, full text once and shared no-repeat/predecessor-evidence/title framing. Source id recorded; no original-task capture, automatic seed, child lineage or successor classification. |
| 10 | Payload chars/4 >50% of recorded soft warns/compression advice only, no rewriting, fixed generation cap or growth classification. |
| 11 | XDG-data/HOME private hashed-id files, immutable first-writer atomic link publication, new dirs/files0700/0600. No quota/TTL/eviction/deletion cleanup/fsync guarantee; temps may remain. Latest persisted estimate/stage/soft, reason always unknown. |
| 12 | Full readback only, any host-bound caller (including children) may read any retained id. Writer pins AGENT_SESSION_ID, matches call metadata and exported root id/type/parent; no authored caller. Real Hidden probe passed binding then refused writer. Not a same-user sandbox. |

## Kilo root-session MVP

CLI/plugin/SDK and CLI-backed VS Code extension source **7.8.23**:
[Kilo assessment](research/kilo.md). Real CLI loading and tool registration
observed without a model; extension dispatch is source-established only.
**Fixture-covered** never means model compliance or continuation.

| # | Kilo status against the requirement above |
| --- | --- |
| 1 | `chat.message` appends a synthetic introduction to the first root user message per registration, persisted by host; reload can repeat it. Later transient tail notices reference it. No system-prefix rewrite/priority claim; compliance unverified. |
| 2 | Direct `context_handover`/`read_handover`, each observed once in the real CLI registry. No deferred loader. Host Zod preserves required string args but drops per-arg descriptions; tool-level guidance remains. Policies may hide tools. |
| 3 | Intro defines current-step boundary, final-report replacement and plugin-storage permission under read-only tasks. Advisory guidance only; fixture-covered. |
| 4 | Latest ordinary normalized five-field usage + trailing text/settled tool outputs at chars/4 over active filtered history. Summary workers and pre-summary retained-tail anchors excluded; fresh usage required after compaction. Fixed shared stages; catalog context window, capped integers/explicit percentages. Unknowns silent, no hard gate. |
| 5 | Absent automatic continuation: user opens fresh equipped root and submits reader reference. No parent preauthorization or automatic create/prompt. |
| 6 | n/a child replacement. No model selection, settings or override-preservation promise. |
| 7 | n/a child handback. Writer stores model strings and advises ending turn; stop/final delivery compliance unverified. |
| 8 | No source lock or stop correction; source remains usable, immutable handover cannot be overwritten. Corrupt storage needs manual recovery. |
| 9 | Manual reader reference, full text once/shared no-repeat/predecessor-evidence/title framing. Host source session/agent recorded; no original task capture, automatic seed, child lineage or successor classification. |
| 10 | Handover-only chars/4 >50% of recorded soft warns/advises compression only. Model text stays verbatim; no fixed cap, productivity classification or loop guard. |
| 11 | HOME private hashed-id files, immutable atomic first-writer publication, new dirs/files 0700/0600. No quota/TTL/eviction/deletion cleanup/fsync promise; temps may remain. Latest estimate/stage/soft/notice-append reason; lost diagnostics unknown. |
| 12 | Full readback only; any equipped caller (including children) may read any retained id. Writer uses host context plus fresh matching parentless session lookup, not authored identity. Model/override/chain unknown; no arbitrary-path or parent-only reader policy, not a same-user sandbox. |

## Qwen Code subagent-first MVP

Pinned `@qwen-code/qwen-code@0.26.3`: [capabilities and primary sources](research/qwen-code.md).
Extension linking and real host MCP connection were observed without a model.
**Fixture-covered** never establishes child hook routing, model compliance or receipt.

| # | Qwen status against the requirement above |
| --- | --- |
| 1 | SessionStart/SubagentStart additionalContext introductions; PostToolUse notices reference installation. Fixture-covered; priority/trust/compliance unverified. |
| 2 | Full mcp__auto_context_handover tool names; no deferred loader established. Real stdio tools/list observed; host policy can hide tools. |
| 3 | Intro defines current-step/final-report precedence and plugin-storage writes under read-only instructions. Advisory, fixture-covered. |
| 4 | Latest identity-matched child ROUND_TEXT prompt+candidates usage, synchronously recorded before tools; no cache/billing accumulation or trailing-result estimate. Fixed shared stages, integer-only default200000 uncapped/unknown child window. Unknowns silent; invalid config disables notices, no hard token gate. |
| 5 | Root intro attributes read-then-replace without confirmation to installation default. Advisory; no automatic spawn or observed parent compliance. |
| 6 | Same logical child/type/requested override via parent's original spawn parameters. Type/effective model/override unknown; no count-limit or provenance guarantee. |
| 7 | Native final-text return plus bounded SubagentStop correction after storage. Fixture-covered guidance, no deterministic rewrite/classifier handback/observed parent receipt. |
| 8 | Read-before-message and never-resume guidance; persistent closure denies supported child tools and both bound MCP calls. No universal stop on disabled/failed hooks. |
| 9 | Short full-reader reference, shared no-repeat/title-based/predecessor-evidence framing. No captured original, lineage or automatic successor classification. |
| 10 | Verbatim text; >50%-of-soft successor-body chars/4 warning/compression advice only. No fixed generation cap/productivity classification; parent may check in on stalls/growth. |
| 11 | HOME private immutable hashed-id handover+closure, unchanged Codex store; no quota/TTL/eviction/deletion cleanup/fsync guarantee. Pending/temp files may remain. Compaction byte floors, corrupt/torn reads unknown; failed floor writes log but can leave stale floors. Diagnostics reflect notice append, not receipt; invalid soft reads unknown. |
| 12 | Compact default, full:true verbatim read; unavailable pending decisions/provenance unknown. Any live host-bound caller may read any composite session:agent id, closed callers denied. Single-use original-args capability, not authored caller identity or same-user sandbox. |

## OpenHands SDK advisory MVP

SDK `1.21.0`, assessed CLI `1.16.0`: [capabilities and citations](research/openhands.md).
SDK-only local composition, not a CLI plugin or replacement application.
Real package load/hooks are non-model observations; **fixture-covered** never
means model compliance or successful continuation.

| # | OpenHands status against the requirement above |
| --- | --- |
| 1 | AgentContext system suffix introduction preserves existing context; UserPromptSubmit notices reference it. Source-established placement, fixture-covered, trust/compliance unverified. |
| 2 | Direct context_handover/read_handover ToolDefinitions, real SDK resolution observed; no deferred loader. Host tool policy can filter them. CLI MCP support does not install these Python tools. |
| 3 | Intro defines current step, final-report replacement and plugin-storage writes in read-only work. Advisory guidance, not priority enforcement. |
| 4 | Latest main-agent per-response prompt+completion, never combined/accumulated/condenser metrics; fixed shared stages only on next user submission. Integer default200000 capped70% known context_window, explicit percentages; unknowns silent. No tool-boundary/Stop notice or hard gate. |
| 5 | Absent automatic continuation; application creates a fresh equipped local Conversation and submits source reader reference. No parent preauthorization or implicit driver loop. |
| 6 | n/a child replacement/count rules. Explicit application binding, no automatic root classifier; inherited tools refuse a different conversation. No settings/override-preservation promise. |
| 7 | n/a native child handback. Writer stores strings and advises ending turn/manual continuation; stop/final receipt compliance unverified. |
| 8 | No source lock, Stop correction or never-resume enforcement. Immutable first write retained; corrupted storage requires manual recovery. |
| 9 | Manual fresh-conversation reader reference, full text once/shared no-repeat/predecessor-evidence/title framing. Host source id recorded; no captured original, lineage or automatic successor classification. |
| 10 | Handover-only chars/4 >50% recorded soft warns/advises next-handover compression only; no rewriting/fixed cap/growth classification. |
| 11 | HOME private hashed-id files, atomic immutable first-writer link publication, new dirs/files0700/0600. No quota/TTL/eviction/deletion cleanup/fsync guarantee; snapshots/temps may remain. Latest memory diagnostics plus independently latched emission, not receipt; reload unknown. Failed writes log/retry and attempt stale-file removal; failed removal can leave stale notices. Native condensation clears usage, not nudge provenance, without modifying condenser. |
| 12 | Full reader only; own exact host object/id required, any equipped caller reads any retained target. No arbitrary-path or parent-only authorization/same-user sandbox. Effective model/override/original task/chain unknown, not authored provenance. |

## Kiro CLI assessment (not shipped)

AWS Kiro CLI stable `2.35.1`, artifact/hash and primary-source capability table:
[Kiro assessment](research/kiro-cli.md). Non-model binary version/help succeeded;
agent validation was authentication-blocked. No Kiro fixtures, adapter,
hook firing, model compliance, MCP registration or continuation are claimed.

| Checklist requirements | Assessment status |
| --- | --- |
| 1-3: introduction, tool loading, precedence | Candidate V3 SessionStart/UserPromptSubmit stdout introduction and `tool_load`/`tool_call` MCP discovery; no implementation or compliance evidence. Ordinary post-tool stdout is ignored. |
| 4: measured staged escalation | Blocked: no established hook-readable active-context usage/transcript estimator. Interactive meter/full-history export are insufficient. ACP context-usage updates belong to the owning client, not ordinary hooks. |
| 5-8: continuation, replacement, delivery, recovery | Fresh `/chat new` documented; subagents return findings, but attributed lifecycle/delivery and bounded Stop recovery unverified. No automatic continuation, source lock or child workflow implemented. |
| 9-12: reference seed, growth, storage, reader policy | Absent implementation. Native session persistence is not plugin handover readback; trustworthy host-to-MCP caller binding remains unestablished. No lineage, quotas or diagnostics claimed. |

The blocker is missing verified contracts, not absence of hooks or a generic
per-model gate. V2 is the binary's default engine; V3 docs require explicit
targeting. [Unblock conditions](research/kiro-cli.md#blockers-and-unblock-path).

## Notes

- OpenCode intentionally differs: no trusted start intro, no native handback, no per-child lineage or growth metadata and no parent preauthorization. Child reply text states logical replacement under count limits and permits stall/growth check-ins; those are advisory instructions, not new mechanisms.
- Claude Code intentionally differs: roots are context-only (no measurement, nudging, handover action, gating or rollover); native compaction is unchanged.
- Pi intentionally differs: root-oriented advisory workflow and manual command
  rollover; no core subagent integration or automatic event-driven replacement.
- Codex intentionally differs: source-pinned observer plus tool-boundary notices,
  hook-bound MCP calls and file storage; no original-task capture, child lineage,
  requested-override observation or automatic parent spawning.
- Crush intentionally differs: release PreToolUse-only root integration via an
  explicit Unix socket; lagged saved counters, no child hooks, no TUI following.
- Copilot CLI intentionally differs: experimental standalone extension plugin,
  current-window events rather than command-hook usage, native stop rewrite and
  direct host-attributed tools. General-purpose lifecycle and unattributed
  runtimes are unsupported; roots do not rotate.
- AiderDesk intentionally differs: root Agent-mode heuristic measurement and
  advisory/storage-only manual continuation, no source lock/UI following; native
  subagents and built-in handoff/compaction are not repurposed.
- Cline intentionally differs: root full-request heuristic and direct SDK hooks,
  HOME-based file storage and manual reference continuation; no hook-window
  resolution, automatic creation, child workflow or source lock.
- Amp intentionally differs: focused-parentless active-view estimation and
  successful-turn-end automatic root attempt using the source agent; no source
  lock, universal child detection, known window or authenticated routing proof.
- Goose intentionally differs: explicit Stop-denial opt-in, lagged native JSON
  export and per-session stdio process binding; no model-visible start intro,
  ordinary tool gate, automatic continuation or source lock.
- Kilo intentionally differs: legacy hook/SDK API, shared pure logic rather
   than an OpenCode V2 shim; root-only anchored advisories and manual reader
   continuation, no KV/source lock/UI following or native child workflow.
- Qwen intentionally differs: native classic command hooks, child transcript
  response records and Codex capability/store reuse; no Gemini BeforeModel,
  child window discovery, Stop telemetry, lineage or automatic parent spawn.
- OpenHands intentionally differs: Python local-SDK composition only; lagged
  previous-response notices on the next user prompt, not inside autonomous runs.
  Manual fresh-context continuation; no CLI injection, Stop gate or child workflow.
- Gemini CLI rows are historical, superseded as a target by the [Antigravity CLI assessment](research/antigravity-cli.md);
  Antigravity CLI itself is assessed docs-only with no shipped implementation.
- Live retest shape for the pending Claude rows: [Claude parent continuation retest](../README.md#claude-parent-continuation-retest).
- A supplied five-generation Claude report observed completed continuation, four parent reads/successor replacements, preserved notes and successful handbacks. That is reported evidence for the previous full-default workflow, not direct verification of this compact-readback change or every pending row.
