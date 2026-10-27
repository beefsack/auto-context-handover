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
      "soft": "70%"
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
| `soft` | `"70%"` | Warn threshold: `"70%"` string or positive absolute integer tokens. No ratios. Precedence: child prompt marker > agent override > `"provider/model"` > bare `"model"` > this value, resolved against the request's model only. |
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
      "soft": "70%",
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
preferred, else `limit.context`); unmeasurable requests fail open (no nudge,
no gate). All-zero provider usage counts as unknown, never as an anchor.

### Per-child test override

Start a new subagent's spawn prompt with a namespaced marker line:

```text
[auto-context-handover-test soft=4096]
Complete the bounded task below...
```

`soft` accepts a positive integer token count or a percentage such as `70%`.
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
- Lock mode creates no successor. Children always return to their parent:
  only the short summary, child session ID, and `read_handover` hint. Their
  stop-lock repeats that short final reply on subsequent requests.
- EXPERIMENTAL loop guard: three consecutive successors adding <25% of soft
  beyond their seed lock instead of rotating. Productive handovers
  reset the streak; the first root handover never counts. Seed >50% of soft
  only warns.

## Storage

Fallback B: everything lives in session-keyed KV, never in external files.
The host persists complete tool-call inputs (`packages/schema/src/session-message.ts:148-154`,
`packages/core/src/session/sql.ts:84-96` at pinned `19d87a7`), but server
plugins expose no full-history API and `ctx.session.context` is filtered
(`packages/core/src/session/history.ts:149-179`), so the full text cannot be recovered from the
transcript later. The handover body is therefore stored under
`auto-context-handover:handover:<sessionID>` (lock, loop state,
child soft override and forward/back links beside it) and removed with the session on `session.deleted`.
`read_handover` is a direct (`codemode: false`) tool returning the full
text with `metadata: { truncated: false }`, which bypasses the host's
tool-output truncation instead of spilling to a file. It returns only the
handover, not the old transcript. A full read can consume large context;
the soft-limit estimator sees the result after its anchor, which is
expected behavior, not a safety feature.

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
