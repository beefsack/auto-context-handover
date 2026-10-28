# auto-context-handover

Measured soft-limit handover plugin for OpenCode V2 (verified against 2.1.4).

The session's own model writes the handover; a linked fresh session continues it automatically, or lock mode stops without a successor. Subagents return only a summary to the parent.

The plugin only measures, warns, hard-gates, and rotates.
`compaction.auto` stays on and untouched. Activation
is runtime only: the plugin registers hooks and tools on host load, no model
calls. The bundled TUI companion follows successful root rollovers when you
are still viewing the old session. It never switches you away from another
session or shows review/confirmation UI. Desktop and web do not auto-follow.

## Install (local directory)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/auto-context-handover", "options": {
      "soft": 150000
    } }
  ]
}
```

Run `npm install` once in this directory (runtime deps for the plugin host).
No build step: the host resolves the root `index.ts` shim and loads `source/`
directly. Node >= 22.18 is required for the `.ts` tests.
The root `tui.ts` companion loads automatically from the same `plugins` entry;
no separate install, `cli.json` entry, or additional option is required.
Local source changes are watched for automatic plugin reload. Keep related
edits coherent: a failed import can leave the previous generation active.
In one live check, a stale missing-export failure persisted across saves until
a clean host restart; inspect load errors before accepting live test evidence.

## Config reference

| Key | Default | Meaning |
| --- | --- | --- |
| `soft` | `150000` | Warn threshold: positive integer tokens or a percentage string. No ratios. Integers resolve as `min(value, floor(0.7 * window))`; percentages use their requested percentage without the cap. Precedence: child prompt marker > agent override > `"provider/model"` > bare `"model"` > this value, resolved against the request's model only. |
| `hard` | unset | Opt-in hard gate, same formats. Past it, every tool except `context_handover` is removed for that request. |
| `modelOverrides` | `{}` | e.g. `{"anthropic/claude-opus-4-6": "60%", "gpt-5": 90000}`; validated independently. |
| `agentOverrides` | `{}` | e.g. `{"build": "80%"}` (highest configured precedence); validated independently. |
| `stages` | `[0, 0.1, 0.2]` | Nudge boundaries relative to soft: warn at soft, then soft*(1+offset). Must be 3 ascending offsets starting at 0; stage texts are fixed. |
| `onHandover.primary` | `"new-session"` | `"new-session"` starts a linked successor; `"lock"` stops with no tools. Other values (including removed actions, `reset` or the old flat string) are setup errors listing the supported actions. |
| `onHandover.subagent` | `"return"` | Only `"return"` is supported. Anything else is a setup error. |
| `handoverDescription` | built-in | Overrides the `context_handover` tool description template wholesale. |

Full example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/auto-context-handover", "options": {
      "soft": 150000,
      "hard": "95%",
      "modelOverrides": { "anthropic/claude-opus-4-6": "60%" },
      "agentOverrides": { "build": "80%" },
      "stages": [0, 0.1, 0.2],
      "onHandover": { "primary": "new-session", "subagent": "return" }
    } }
  ]
}
```

Low-threshold testing: `{ "soft": 2000, "hard": 4000 }` forces warn/hard
quickly. Thresholds resolve against the model catalog window (`limit.input`
preferred, else `limit.context`). Integer soft values resolve as
`min(value, floor(0.7 * window))`, so the default is 150000 tokens or 70% of
the window, whichever is smaller. The same cap applies to configured integers;
explicit percentages remain uncapped. Hard limits are uncapped and take priority
when reached, even if below soft. With an unknown window, integer soft still
applies, percentage soft fails open, and hard gating is disabled. All-zero
provider usage counts as unknown; without usable usage there is no nudge or gate.

### Per-child test override

Start a new subagent's spawn prompt with a namespaced marker line:

```text
[auto-context-handover-test soft=4096]
Complete the bounded task below...
```

`soft` accepts the same capped integer tokens or uncapped percentage strings as
configuration, with the same unknown-window behavior.
The whitespace-separated `key=value` syntax reserves room for future options;
only `soft` is implemented. Unknown keys, duplicate keys, malformed pairs and
invalid values reject the initial child prompt with an explicit error.

The plugin recognizes only the beginning of a real child's initial prompt,
allowing OpenCode's standard subagent banner. It awaits session-keyed storage
before removing the marker from admitted text. Root prompts, later prompts,
quoted material and tool results are not scanned. The override outranks all
configured soft values without changing `hard`, nudges or child return behavior.
It needs no configuration edit or restart, survives reload and compaction,
and is deleted with the child. Descendants and successors do not inherit it.
The first request still needs usable assistant usage before it can be nudged:
give tests at least two model turns, for example by requiring successive tool
calls before completion.

## Behavior

- Measure the latest assistant's normalized input, cache read/write, output,
  and reasoning once, plus trailing text at chars/4, including settled tool
  results. No usage anchor means no warning or hard gate.
- Append a stable, per-request stage nudge to the END of messages, not the
  initial system prompt. The model finishes its unit and calls
  `context_handover({handover, summary})`; text is stored verbatim.
- Primary rollover creates a ROOT with the active agent/model and original
  directory. Readiness, links, and source lock precede successor prompting.
  The seed carries the full handover and backlink; the old session records
  `continued in session <id>`. The TUI follows only if it is still showing the
   source when the successful rollover arrives and after successor lookup.
- Initial child continuation uses reference seeding: the parent reads the full
  handover, then spawns a same-agent-type successor with a prompt instructing
  it to call `read_handover` with the predecessor session ID and continue
  from "Prioritized next steps"; the handover is never pasted into the spawn
  prompt. Both treat the original task as reference context: completed steps
  are done and must not be repeated; predecessor facts are trusted unless
  marked unverified, without relabelling their evidence as the successor's
  direct verification. Targeted re-reads of already-covered material may
  resolve open questions, not repeat completed steps. Continue from
  "Prioritized next steps", independent of section numbering.
- Lock mode creates no successor. A child handover replaces its required
  final report for that session; before storage, read-only task instructions
  still allow the handover tool because it writes only plugin storage. The
  tool result tells the child to end its turn now with exactly the following
  continuation text as its final message and then stop. The native parent
  receives the child's latest completed assistant text, not the tool result.
  The reply carries the short summary, child session ID, and exact
  `read_handover` call plus the reference-seeding successor instruction. A
  successor continues and replaces its predecessor as the same logical
  subagent, not an additional subagent under subagent-count limits. Ask only
  about handover-listed user-owned decisions, except checking in is allowed
  if progress stalls or remaining work grows. The child stop-lock refuses
  later questions or work explicitly, with the exact reader call and a
  successor/fresh-subagent continuation hint, not the old summary. Claude
  native `SubagentHandback` delivery is unchanged.
- The default handover template requires plain disclosure of deviations,
  triggered stop conditions, failed calls and unverified claims. Unresolved
  deviations/stops preclude PASS or completion; summaries must not overclaim.
  Keep open questions explicitly. Do not author your own agent/model/chain
  provenance: the plugin records it; its record takes precedence over prose.
- EXPERIMENTAL loop guard: three consecutive successors adding <25% of soft
  beyond their seed lock instead of rotating. Productive handovers
  reset the streak; the first root handover never counts. Seed >50% of soft
  only warns.

## Claude Code (subagent-only adapter)

The same repository root ships a Claude Code mod (`hooks/`, loaded via
`hooks/hooks.json`; manifest `.claude-plugin/plugin.json`, marketplace
`.claude-plugin/marketplace.json`). Install the repository root as the
plugin/marketplace source; no OpenCode host is involved.

- Only subagent child loops are measured (latest per-request `turn.step`
  usage, never cumulative, never the root window) and nudged per batch with
  staged escalation at soft, soft*1.1, soft*1.2, reusing the OpenCode warn
  leads. A `classic.SubagentStart` introduction explains the installed plugin
  before the child's first prompt; later notices appear next to tool results
  after a batch. Each stage references the introduction and retains the exact
  `mcp__auto-context-handover__context_handover` tool, `ToolSearch select:`
   loader, current-step boundary, full handover/handback action and intact parent
  readback. The introduction carries schema/template and read-only
  plugin-storage guidance. It is skipped only for positively identified
  teammates; unknown ids or unavailable listings still receive it. Teammates
  remain excluded from nudges and refused by the handover tool.
- Roots receive a short context-only introduction through
  `classic.SessionStart` `additionalContext`, before the first prompt rather
  than inside a tool result ([placement contract](https://code.claude.com/docs/en/hooks#add-context-for-claude)).
  It establishes reading incomplete child handovers and continuing without
  confirmation as the user's configured default. A successor replaces its
  predecessor as the same logical subagent, not an additional subagent under
  subagent-count limits. Read the handover before replying or deciding; ask
  only about handover-listed user-owned decisions, never context size, except
  check in if progress stalls or remaining work grows across generations.
  There is no fixed generation cap: parent judgment stays in charge. If a
  child ends without a delivered report, read its handover before messaging
  or resuming it; an existing handover is incomplete work to continue in a
  successor. Never SendMessage to or resume a handed-over child. Pass the
  reader's short successor prompt verbatim; append parent redirection if
  needed, but do not paste the original task or full handover into the spawn.
  Startup/resume/clear/compact/fork context is supported; custom-agent roots
  qualify by absent `agent_id`. Roots are not measured, nudged, gated or
  rolled over and cannot hand over. Tools register session-wide; parent
  readback remains available. Native compaction is unchanged.
- `soft` (plugin userConfig, default `150000`): positive integer tokens
  only, unbounded (the child window is unknown). No percentages, caps, hard
  gates, loop guards, or per-child markers.
- The child calls `context_handover` once, then must call `SubagentHandback`
  and stop. The tool result addresses the child first and retains the short
  reply below; the adapter forwards that stored reply as the handback message
  through the native path without replacing its result or bypassing review.
  Host receipt and classifier outcomes are not independently observed.
  Plain text is a last resort
  only when the handback tool is absent: on the reported native path, unsent
  final text was not shown to the parent. The parent reads a compact view via
  `read_handover` with the `childId` from the short reply. The notice tells the
  child to load the handover tool first (the deferred description is initially
  invisible) and then call it with the full text. Child summaries must include
  `User decisions pending: none` or `User decisions pending: <list>`.
  Default readback contains diagnostics, plugin-recorded provenance,
  generation/chain, next-step count, seed size, pending user decisions, the
  "Prioritized next steps" excerpt and successor pointer. Missing pending
  decisions or unsupported next-step formats are labelled `unknown`, with a
  `full:true` reader hint rather than invented claims. Request
  `read_handover({"childId":"CHILD_ID","full":true})` for the observed
  original task and handover verbatim, once each, with reference-only/no-repeat/
  predecessor-trust framing and native final-report guidance. The final short
  successor prompt starts with a lineage marker and explicitly requests full
  text, including when the child reads before spawn metadata is saved:

  ```text
  [auto-context-handover:continue child:CHILD_ID] First call mcp__auto-context-handover__read_handover({"childId":"CHILD_ID","full":true}) to load the full handover and the original task, then continue from 'Prioritized next steps'.
  ```

  The marker is recognized only at the beginning of the observed spawn
  prompt, allowing leading whitespace. Quoted/mid-text examples are not
  scanned. Malformed reserved prefixes and missing predecessor handovers
  produce unknown lineage, never a silently reset original task. This marker
  is unrelated to the OpenCode per-child soft-limit test marker.
- The successor loads the payload through `read_handover`, not a large
  `SubagentStart` injection. Recorded successor callers also receive full text
  without the flag when their merged spawn/handover metadata identifies this
  target as the immediate predecessor. That link comes from the leading marker
  observed by `agent.spawn`; the pointer's explicit `full:true` handles the
  pre-persistence race. Existing open-reader access permits any live caller
  with tool access to read any stored handover by id, not only a parent or
  successor; there is no caller authorization or new read grant.
  Locked callers still cannot read or work. The short prompt itself contains
  the reader instruction, even if the generic start introduction is absent.
  Tool-output limits/placement remain host integration risks; this route
  avoids parent retranscription and does not claim system-prompt priority.
- Capture the original from the documented
  [`AgentSpawnInput.prompt`](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts),
  not parent memory or inferred task text. Store it once under the origin
  child id; successors retain only that reference and their immediate
  predecessor id. Generation starts at 1 and increments from a stored
  predecessor's metadata. Readback shows generation, predecessor and origin
  ids, plus a top-level next-step item count when the title/list format is
  derivable, otherwise `unknown`. These are progress cues, not a proof of
  productivity. Post-spawn metadata remains recoverable if the child already
  handed over before the spawn result returned; no stored handover is rewritten.
- The shared `seedTooLarge` check warns when the successor-facing payload
  estimate (`ceil(chars/4)`, including framing but not reader headers) exceeds
  50% of the current Claude soft limit. Ask the child to compress carried-over
  finished notes at its next handover, never rewrite stored text. This is
  advisory and excludes host/system/tool overhead; it does not gate work.
- Replies/readback record the agent type and requested model override from
  [`agent.spawn`](https://code.claude.com/docs/en/plugins/mods/reference#subagents),
  with `SubagentStart` type fallback, and prescribe the same type/override
  for the successor. Observed absence is `no override`; unavailable or legacy
  provenance is `unknown, use predecessor spawn params`. Never infer an
  override from usage or the effective/root model. Metadata persists across
  reload in private storage; storage failures can lose provenance. It records
  parameters as this observer saw them, not downstream mod rewrites. The root
  introduction makes this plugin record authoritative over conflicting
  handover prose; the shared template tells children not to restate their own
  agent/model/chain provenance.
- Resumed locked children return an explicit refusal and continuation hint,
  including through native handback. Same-turn initial delivery retains the
  short summary; missing or legacy turn identity selects the locked reply.
  A closed child without an observed successful handback in the current turn
  receives at most one stop correction to call `SubagentHandback`, even when
  its final text matches the short/locked reply. Existing stop blocks and
  active stop hooks are respected; errors fail open. Official
  [tool documentation](https://code.claude.com/docs/en/tools-reference)
  establishes native delivery/classification, not a universal plain-final-drop
  guarantee; the bounded correction conservatively addresses the live report.
- Full text persists in plugin storage ([4 MiB JSON total, shared across
  sessions](https://code.claude.com/docs/en/plugins/mods/reference#limits)).
  Before payload/provenance writes, estimate the whole serialized store with
  the proposed replacement. Above 3 MiB, evict oldest eligible whole chains by
  last activity until it fits. No TTL or configuration; the remaining 1 MiB
  is estimate headroom, not reserved capacity. Reads and continuations refresh
  activity. Legacy/untimestamped records sort oldest; spawn-only orphan
  metadata participates in the same activity ordering. Legacy groups and
  groups with no timestamp form the oldest tier; within each tier, activity
  sorts ascending with chain-id ties. Protect the current chain,
  active/in-flight chains and uncertain
  membership rather than guessing lineage. The legacy/orphan exception means
  no lineage claims at all; malformed/conflicting claims, unresolved references
  and unreadable membership remain protected, including identifiable related
  chains. Unknown keys count toward size but are not reclaimed.
  Expired bodies/originals are
  permanently unavailable; compact closure tombstones keep handed-over
  children locked and reads explicitly report `expired`.
  Insufficient safe space and failed/partial eviction remain explicit and
  retryable; failed handover storage never claims success or locks the child.
  Tombstones consume space too. Concurrent sessions can over-evict; store
  accounting and reclamation are not atomic. Eviction scans run on writes,
  not reads. The estimate sums UTF-8 bytes of JSON-escaped keys and serialized
  values, including object braces, colons and commas, after replacing the
  pending key's old value. It counts all enumerated key families, not just
  handovers; host-internal representation can differ. Incomplete scans refuse
  the pending persistence rather than treating unreadable entries as zero.
  New child records store the model's summary once and derive the short reply;
  historical records with persisted short replies remain readable.
  Active protection combines local in-flight reservations, nonterminal
  listings and persisted child pins. Only documented `completed`, `failed`
  and `killed` statuses release listing protection; unknown statuses retain it.
  A matching `turn.complete` retires the pin; `session.end` best-effort removes
  only that session's pins, never payloads. Crashes or failed cleanup can leave
  stale pins indefinitely, reducing safely reclaimable space.
  Original-task write failures preserve a bounded
  error in spawn metadata when possible and report the cause in full readback;
  if all writes fail, reload can lose that cause and readback reports unknown.
  Handover storage failures are explicit errors, not successful handovers.
  Native output
  limits are unverified integration risks, as are tool availability under
  real allowlists, child feedback routing, classifier review of short returns, resumptions, and
  installed-package loading. Delivery guidance is advisory shaping, not a
  deterministic replacement.
- Per-child usage, baseline, growth, spawn-observation and nudge caches retire
  on closed-child stop or matching turn completion. Handback/correction latches
  survive a blocked stop and retire only at actual turn completion or session
  end. A genuinely new open turn re-enables measurement and re-pins before its
  first request; a lost baseline remains `unknown`, not a fabricated restart.
  Auxiliary retired/provenance/error/seen-turn histories are capped at 1000
  child ids, with at most 10 remembered turn ids per child. Session end clears
  transient measurement and correction state; durable locks remain.
- `hooks/claude-types.ts` is a narrow structural subset of the mod
  contracts, not full API verification, and carries no live version claim.

Adapter developers: [docs/adapters.md](docs/adapters.md) lists the harness-independent
requirements checklist with per-adapter status and evidence.

## Storage

OpenCode fallback B: everything lives in session-keyed KV, never in external files.
The host persists complete tool-call inputs (`packages/schema/src/session-message.ts:148-154`,
`packages/core/src/session/sql.ts:84-96` at pinned `19d87a7`), but server
plugins expose no full-history API and `ctx.session.context` is filtered
(`packages/core/src/session/history.ts:149-179`), so the full text cannot be recovered from the
transcript later. The handover body is therefore stored under
`auto-context-handover:handover:<sessionID>` (lock, loop state,
child soft override and forward/back links beside it) and removed with the session on `session.deleted`.
OpenCode's `read_handover` is a direct (`codemode: false`) tool returning the full
text with `metadata: { truncated: false }`, which bypasses the host's
tool-output truncation instead of spilling to a file. It returns only the
handover, not the old transcript. A full read can consume large context;
the soft-limit estimator sees the result after its anchor, which is
expected behavior, not a safety feature.
Any live caller with tool access can read any stored handover by session id;
the reader checks target existence and storage, not caller authorization.
Locked callers have no tools. Claude has the same open-reader policy but uses
`childId` and compact-by-default readback as described above.

Both adapters store call-time handover diagnostics and show one reader header:

```text
Diagnostics: reason=nudged, stage=warn1, estimated-context-tokens=1050, soft-limit=1000
```

The reason is `nudged` or `not-nudged`, never inferred user intent. OpenCode
uses its pre-call request estimate (including trailing chars/4) and stage;
Claude derives stage from the child's latest per-request usage against soft
(the same boundaries as notices); reason reflects observed batch-nudge
appending independently, not proof the child read it. Claude readback also shows recorded successor
agent/model-override provenance and appends `handback-delivered=yes|no|unknown`
to the diagnostics line. New records start at `no`; a successful native
handback result (no denial/error) persists `yes`, including a locked reply
delivered after resume. This records observed tool success, not independent
parent receipt or classifier internals. Legacy status is `unknown`; a failed
status write can leave stale `no` even after delivery. The current-turn stop
check is in memory, so a reload can cause one extra correction. Unavailable
fields, including lost transient
  state and older records, read as `unknown`. Diagnostics do not persist nudges
  or change request text, thresholds, gating or rollover.

Claude also records the first measured request's context total after a newly
observed child launch, and the latest consecutive request-to-request change
at handover in a separate line:

```text
Baseline: start-context-tokens=42000, last-batch-increase=6500.
```

These use the same per-request input/cache/output sum as context measurement,
not the task notification's cumulative tokens. A negative change is possible
after compaction. A start baseline requires a launch observed in the current
registration without previous child/spawn metadata (or a spawn observed here);
unobserved starts, metadata-read failures and reloads of existing children
report `unknown`, not the first later measurement as a fabricated start.
The last-batch delta needs two consecutive usable measurements, which may both
be after reload. Legacy/unavailable fields are `unknown`. They are
diagnostics only, not a new nudge point or overshoot control.

## Manual test plan

Root-session checks run against an isolated project directory (never the live
config): create `/tmp/opencode/ch-manual`, put an `opencode.jsonc` with the
`$schema` property and this package in `plugins`, and start `opencode` there.
Use `{ "soft": 2000 }` (or similar) so one short exchange crosses the
threshold; the model does the calling, you verify the outcomes.

Ask the user to choose the model explicitly for each live run, and pass it
as a required per-run argument or environment variable with no default.
Never hardcode or pick a model in test files, scripts, or configs. If the
chosen model is rejected, stop rather than substitute another model.
Scripts must reject both unset and empty model arguments/environment variables
before invoking OpenCode; an empty `--model` can otherwise select a default.
Give sessions explicit titles so automatic title generation cannot select
a different model for an auxiliary request.
Check a context observer's `event.model` against the requested model before
accepting evidence. Use a private server (`--standalone`) and an explicit
agent with access to the plugin tools so inherited settings do not obscure
the check.

For headless checks, require the chosen model in the invoking environment:

```sh
: "${LIVE_TEST_MODEL:?Set the model explicitly chosen for this run}"
opencode run --standalone --agent build --model "$LIVE_TEST_MODEL" --title "Handover check" --format json "What is 1234 + 5678? Reply exactly SUM-6912. Do not call any tools."
: "${SESSION_ID:?Set sessionID from the run's JSON events}"
opencode session export "$SESSION_ID" > session.json
```

Run these commands from the isolated project. Obtain `SESSION_ID` from the
run's JSON events; exported tool entries use `.name`, not `.tool`.
First verify ordinary completion without asking for a handover: no usage
anchor exists on the first request, so it should not nudge or hand over.
Then continue that session to cross the threshold. A context-hook observer
loaded after this plugin can independently record remaining tool names and
injected directives; a model's description of its tools alone is not proof.

1. New-session rotation (local directory config).
   Do: with `soft` low, ask the agent to complete a small unit and then call
   `context_handover` with full text plus summary. Nudges are model-facing,
   not UI notifications.
   Expect: tool result names the successor ID; the source session refuses
   further work (tools stripped, locked notice); the successor opens with
   the handover seed plus backlink and `read_handover` hint; `read_handover`
   for the source from any live session shows the verbatim text with
   `continued in <successor>`.

   TUI follow check: keep the source visible during rollover. Expect the TUI
   to switch to the successor without any prompt. Repeat, but navigate to
   another session before the source completes its handover; expect to stay
   there. Lock mode and child return must not switch sessions. Companion setup
   was verified in an isolated OpenCode 2.1.4 TUI without a model call; actual
   rollover navigation still needs this interactive check.

2. Lock mode.
   Do: set `onHandover: { "primary": "lock" }`, cross soft, call
   `context_handover`.
   Expect: no successor is created; the result names the stored session ID
   and points at `read_handover`; the session locks and keeps no tools.
   Later work requests should refuse and direct the user to read that
   stored text from another session.

3. Child return and parent read.
   Do: from the live parent session, launch an ordinary `worker` with a spawn
   prompt starting with `[auto-context-handover-test soft=4096]`, adjusting soft
   for fixed prompt overhead. Use its configured model, without a model
   override or live configuration edits. Run typecheck first: the live host
   loads this working tree directly. Keep this to one or two spawns and require
   at least two model turns before completion, such as successive tool calls.
   The child must wait for the nudge, finish its bounded unit, and call
   `context_handover` with a short summary. Workers cannot spawn other agents.
   Expect: the child returns only the short summary plus its session ID and
   a `read_handover` hint (never the full text); the child locks; the parent
   reads the full text via `read_handover` with the child session ID.
   A live marker check confirmed stripping, the model-observed nudge, one
   handover call, the short child return and full parent readback. Reload,
   compaction, deletion, rejection and non-inheritance cases have unit coverage.

4. Hard gate.
   Do: set `hard` just above `soft`, push usage past it, and ask the agent
   which tools remain before it hands over.
   Expect: every tool except `context_handover` is removed for that request
   and a firm hard-limit directive is shown; calling `context_handover`
   still succeeds.

5. Loop guard: root plus three short successions, then productive reset.
   Do: with `soft` 100000, do a short exchange and then `context_handover`
   to rotate root -> s1 -> s2 -> s3, each successor adding only a sentence
   or two beyond its seed; then in a fresh chain, do enough work to add
   >=25% of soft beyond the seed, followed by short handovers. The short
   exchange before each handover matters: without a measured pre-call
   snapshot the guard skips counting rather than guessing.
   Expect: s3 locks with "loop guard" and no new root; all tools are
   removed on later requests. Read its stored handover from another session.
   The productive chain resets the streak, then locks on the third short one.
   Counts are approximate, so do not expect exact manual outcomes.
   Keep transcripts short even with a larger soft threshold: fixed
   system/tool overhead counts as added tokens, so tiny thresholds can
   classify a sentence-only successor as productive. Explicitly request
   handovers below soft rather than filling the window just to get nudged.
   Separately, with `soft` 1000, a handover body over 2000 characters
   ensures the full seed exceeds 50% of soft; expect a warning, not a block.

6. Forward/back links and read after compaction.
   Do: complete one rotation, then keep working in the successor until
   compaction runs, then call `read_handover` for the source session.
   Expect: the source header shows `continued in <successor>` and the
   verbatim text survives compaction. Both directions resolve only once
   the successor has stored its own handover; before that, the reverse
   link lives in the successor's seed prompt, and `read_handover` for the
   successor reports no handover stored.

7. Deletion cleanup.
   Do: remove a handed-over session (`session.remove`), then call
   `read_handover` for it.
   Expect: the read reports the session does not exist. KV cleanup
   (handover, lock, loop state, both links) is covered in the
   harness, not inspectable via the read tool. This includes child soft overrides.

### Claude parent continuation retest

- Reload the plugin and start a fresh root session. Choose the child model
  explicitly and configure a low enough integer soft limit outside its task
  prompt. Ask for one sequential read-only subagent audit with no handover
  hints and enough work to require continuation.
- Check that the root introduction precedes its first prompt, the child
  introduction/notices arrive, and the child stores a six-section handover
  with pending user decisions in its summary. The parent must read it before
  replying or deciding, then continue in a replacement with the same agent
  type and model override without asking about context or subagent count.
  Require at least two rollovers. Check every child calls `SubagentHandback`
  after storage and every readback reports delivery status. Each parent spawn
  must contain only the reader-provided short prompt, plus optional redirection;
  its successor must read the predecessor before task work. Verify the original
  prompt and handover arrive verbatim, once each, without a memory-filled slot.
  The parent's default read must omit the full original/handover and include
  pending decisions, next steps and pointer; an explicit `full:true` read must
  recover both full texts. A successor's pointer-directed read must always be
  full, including before spawn metadata persistence.
- Follow at least three generations: confirm generation increments, immediate
  predecessor/origin ids, inherited original prompt, title-based continuation
  when next steps are section 7, and no repeated completed work. Targeted
  re-reads may resolve carried open questions. Verify the
  parent notices stalled progress/growing remaining work without a fixed cap.
  Exercise a payload over 50% of soft and check compression advice; in fixtures
  verify malformed/missing pointers, spawn timing, reload and quota failures.
- Exercise a child ending without handback in an isolated fixture: the stop
  correction must request native handback once, not plain text. If no report
  arrives, the parent must read the child id first and continue any stored
  handover in a successor, never SendMessage to or resume the closed child.
  Check the absent-handback-tool fallback stops after the bounded correction.
- Inspect provenance and diagnostics against the spawn and latest usage;
  check first-measured context and last-batch delta independently of the
  task notification's token total, including honest unavailable values;
  confirm root measurement/nudging and native compaction are unchanged.
  Parent compliance and installed-host delivery still need live verification.

## Limitations

- EXPERIMENTAL loop guard is approximate and in-memory parts (request
  identity, pre-call usage, duplicate guard, pending-successor map) reset on
  restart/reload; KV streaks survive. Missing measured pre-call snapshots
  skip counting (including immediate successor handovers). System/tool
  overhead and chars/4 bias productivity, especially at tiny thresholds.
- Non-text media is not char-counted.
- A process crash between successor creation and durable link writes can
  orphan the successor; the same-process pending map covers retries, but a
  retry after a crash may mint a second root. This is a known atomicity gap,
  not a transaction.
- The source lock persists: after an uncertain prompt admission the source
  stays locked and refuses handover retries, so recovery is manual (the user
  opens the successor and pastes via `read_handover`).
- TUI following uses live successful-rollover events only. Missed events
  (for example, while disconnected or before companion activation), failed
  successor lookups, and uncertain prompt admission do not redirect. Opening
  an old session later does not redirect either; use its forward link manually.
- Desktop and web do not auto-follow; there is no interactive review UI.
- No reset or interactive review action: unsupported values are explicit setup
  errors. Storage failures in the context hook still fail open for locks and
  measurement.
- Compaction can drop the visible estimate; the hook keeps a high-water mark
  so pre-compaction progress still counts at handover.
- Isolated OpenCode 2.1.4 live checks confirm lock mode, hard tool removal
  with a callable handover, linked rollover, default-variant preservation,
  the seed-size warning, and locking on the third unproductive successor.
  The restored loop-guard lock fallback has unit coverage but has not had a
  new isolated live run after removal of interactive review. Deletion cleanup
  is unit-tested, not live-tested. Nondefault variants, productive loop-streak
  reset, and readback after compaction were not exercised in these live runs.
