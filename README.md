# auto-context-handover

Measured soft-limit handover plugin for OpenCode V2 (verified against 2.1.4).

The session's own model writes the handover; a linked fresh session continues it, and subagents return only a summary to the parent.

The plugin only measures, warns, hard-gates, and rotates.
`compaction.auto` stays on and untouched. Activation
is runtime only: the plugin registers hooks and tools on host load, no model
calls. There is no TUI companion (deferred): the successor starts without
switching your visible session; its ID is in the tool result and in the old
session's forward link.

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

## Config reference

| Key | Default | Meaning |
| --- | --- | --- |
| `soft` | `"70%"` | Warn threshold: `"70%"` string or positive absolute integer tokens. No ratios. Precedence: agent override > `"provider/model"` > bare `"model"` > this value, resolved against the request's model only. |
| `hard` | unset | Opt-in hard gate, same formats. Past it, every tool except `context_handover` is removed for that request. |
| `modelOverrides` | `{}` | e.g. `{"anthropic/claude-opus-4-6": "60%", "gpt-5": 90000}`; validated independently. |
| `agentOverrides` | `{}` | e.g. `{"build": "80%"}` (highest precedence); validated independently. |
| `stages` | `[0, 0.1, 0.2]` | Nudge boundaries relative to soft: warn at soft, then soft*(1+offset). Must be 3 ascending offsets starting at 0; stage texts are fixed. |
| `onHandover.primary` | `"new-session"` | `"new-session"` or `"lock"`. Anything else (including the old flat string or `draft`/`reset`) is a setup error. |
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
  `continued in session <id>`. The TUI does not follow automatically.
- Lock mode creates no successor. Children always return to their parent:
  only the short summary, child session ID, and `read_handover` hint. Their
  stop-lock repeats that short final reply on subsequent requests.
- EXPERIMENTAL loop guard: three consecutive successors adding <25% of soft
  beyond their seed lock instead of rotating. Productive handovers reset the
  streak; the first root handover never counts. Seed >50% of soft only warns.

## Storage

Fallback B: everything lives in session-keyed KV, never in external files.
The host persists complete tool-call inputs (`packages/schema/src/session-message.ts:148-154`,
`packages/core/src/session/sql.ts:84-96` at pinned `19d87a7`), but server
plugins expose no full-history API and `ctx.session.context` is filtered
(`packages/core/src/session/history.ts:149-179`), so the full text cannot be recovered from the
transcript later. The handover body is therefore stored under
`auto-context-handover:handover:<sessionID>` (lock, loop state, and forward/back
links beside it) and removed with the session on `session.deleted`.
`read_handover` is a direct (`codemode: false`) tool returning the full
text with `metadata: { truncated: false }`, which bypasses the host's
tool-output truncation instead of spilling to a file. It returns only the
handover, not the old transcript. A full read can consume large context;
the soft-limit estimator sees the result after its anchor, which is
expected behavior, not a safety feature.

## Manual test plan

Each check runs against an isolated project directory (never the live
config): create `/tmp/opencode/ch-manual`, put an `opencode.jsonc` with the
`$schema` property and this package in `plugins`, and start `opencode` there.
Use `{ "soft": 2000 }` (or similar) so one short exchange crosses the
threshold; the model does the calling, you verify the outcomes.

1. New-session rotation (local directory config).
   Do: with `soft` low, ask the agent to complete a small unit and then call
   `context_handover` with full text plus summary. Nudges are model-facing,
   not UI notifications.
   Expect: tool result names the successor ID; the source session refuses
   further work (tools stripped, locked notice); the successor opens with
   the handover seed plus backlink and `read_handover` hint; `read_handover`
   for the source from any live session shows the verbatim text with
   `continued in <successor>`.

2. Lock mode.
   Do: set `onHandover: { "primary": "lock" }`, cross soft, call
   `context_handover`.
   Expect: no successor is created; the result names the stored session ID
   and points at `read_handover`; the session locks and keeps no tools.

3. Child return and parent read.
   Do: from a parent session, launch a subagent that crosses soft and calls
   `context_handover` with a short summary.
   Expect: the child returns only the short summary plus its session ID and
   a `read_handover` hint (never the full text); the child locks; the parent
   reads the full text via `read_handover` with the child session ID.

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
   Expect: s3 locks with "loop guard" and no new root; the productive chain
   resets the streak, then counts up and locks on the third short one.
   Counts are approximate, so do not expect exact manual outcomes.

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
   (handover, lock, loop state, both links) is covered in the harness, not
   inspectable via the read tool.

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
- No TUI companion: successors start unattended but never switch your view.
- No reset/draft actions: unsupported values are explicit setup errors.
- Compaction can drop the visible estimate; the hook keeps a high-water mark
  so pre-compaction progress still counts at handover.
- The rename is verified by `npm run typecheck`, `npm test`, and
  `npm pack --dry-run`. Earlier isolated OpenCode 2.1.4 checks confirmed
  session creation and plugin activation before the rename, without model
  prompts. Live activation under the new id and end-to-end model behavior
  remain unverified.
