# Goose adapter: capabilities and evidence

Status (2026-10-29): root-only MVP in `goose/`, release **v1.56.0**,
commit `9949cf926cd42f1d128b9991ed23a496ecace896`. The earlier `ee8500d5`
screen was unreleased; relevant hook/identity/export contracts match this tag.
No live model compliance or continuation evidence. Native children cannot
write; manual fresh-root continuation only. [Install](../../README.md#goose-root-session-adapter).

## Sources and capability table

Documented = public guide; source-established = pinned release code;
observed = isolated non-model command, not a model session.

- [H] [Hook guide](https://github.com/aaif-goose/goose/blob/v1.56.0/documentation/docs/guides/context-engineering/hooks.md),
  [payload/loader/protocol](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/hooks/mod.rs).
- [S] [Stop operation](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/agents/state_machine/ops_stop_hook.rs),
  [default cap/environment](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/agents/agent.rs#L641-L649),
  [user-only banner](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/agents/state_machine/session.rs#L253-L268).
- [I] [Per-session extension sets](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/agents/extension_manager/mod.rs#L682-L718),
  [stdio environment](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/agents/extension_manager/mod.rs#L859-L879),
  [call metadata](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/agents/mcp_client.rs#L745-L810),
  [session header](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/session_context.rs).
- [U] [Session and usage replacement vs ledger](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/session/session_manager.rs),
  [cache subsets](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose-provider-types/src/conversation/token_usage.rs),
  [model_name](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose-provider-types/src/model.rs),
  [JSON export](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose-cli/src/commands/session.rs#L293-L335).
- [P] [Plugin discovery](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/plugins/discovery.rs),
  [plugin MCP expansion/naming](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/plugins/mcp_servers.rs),
  [extension key normalization](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose/src/config/extensions.rs#L22-L30).
- [C] [CLI export/import and non-model mcp-probe](https://github.com/aaif-goose/goose/blob/v1.56.0/crates/goose-cli/src/cli.rs#L1461-L1623).

| Capability | Documented / source-established | Observed / unverified |
| --- | --- | --- |
| Measurement | Hook input has session id but no usage/window [H]. Export serializes Session; `usage` replaces latest report, `accumulated_usage` accumulates billing [U]. Cache counts are input subsets. | Native JSON import/export roundtrip observed. Adapter prefers total, else input+output, ignores ledger/cache addition. Actual provider accuracy/freshness unverified; not a live window. |
| Injection | No general additionalContext/input rewrite. Stop denial creates hidden-user/visible-model user-role message; only Stop/PreToolUse can block. SessionStart banner is model-invisible [H,S]. | Two hook rules loaded by real binary; manual stdin outputs checked. Actual Stop firing/compliance unverified. No trusted standing introduction claimed. |
| Caller binding | Session-scoped stdio process receives AGENT_SESSION_ID; each call receives agent-session-id metadata [I]. Child leases have their own session. | Real host mcp-probe passed identity checks: reader worked, Hidden writer refused. Root writer/read roundtrip also observed through direct SDK stdio. Actual root-session host routing unverified. |
| Root exclusion | Export session_type `user` plus null parent, matching id; unknown fields fail closed. `SubAgent` wire enum is `sub_agent` [U]. | Child refusal fixture-covered. Import coerces synthetic children into users; never credit that as real child validation. |
| Tools/packaging | `.mcp.json` produces extension `plugin:server`, normalized then `__tool`; plugin hooks at hooks/hooks.json [P,H]. | Real host lists both tools using probe extension; installed prefix source-established + manifest-drift fixture. No plugin-prefix runtime observation in a model session. |
| Denial bounds | Host counts consecutive Stop denials, overrides above cap (default 8; GOOSE_STOP_HOOK_BLOCK_CAP) [S]. No adapter loop state. | Setup recommends cap 1, affecting all Stop hooks. Cap behavior source-established, not exercised with a model. Export/unknown checks fail open; existing storage permits Stop. |
| Continuation | Fresh equipped root reads retained id. Resume/duplicate carries history, not fresh-context rollover. | Manual reference/read framing fixture-covered. No automatic creation/UI following/source lock; model-authored final/continuation unverified. |
| Storage | Adapter-owned immutable verbatim record, hashed id, atomic link publication; new dirs/files 0700/0600. | Permissions, duplicate writers, corruption, reload/readback fixture-covered. No quota/TTL/eviction/deletion cleanup/fsync guarantee or same-user sandbox. |

## Implemented boundaries

- Root writer pins process identity, correlates metadata, then runs read-only
  `goose session export --session-id ID --format json`. No model-supplied caller
  parameter or Crush-style capability rewrite. Missing/mismatch/child/export
  error refuses storage. Reader needs matching process/call identity but may
  read any retained id, including from children; no parent-only policy.
- Explicit `AUTO_CONTEXT_HANDOVER_GOOSE_STOP=1` enables Stop denials, otherwise
  storage remains available for explicit requests. Integer-only soft defaults
  to 150000 uncapped (window unknown). Shared stages soft/1.1/1.2. Invalid soft
  logs/disables notices, not tools; writer omits unavailable soft/stage.
- Native export includes conversation, but only usage/root/model fields are
  used. A 15-second/16-MiB subprocess bound may make large sessions unknown:
  Stop fails open, writer refuses unavailable root classification. Environment
  is inherited explicitly so CLI and MCP see the same DB. Native compaction
  is untouched and may preempt a turn-end notice.
- Diagnostics reason always unknown; current stage is not notice-delivery
  provenance. Effective model uses `model_config.model_name`, never provider
  name or authored text. No requested-override/original-task/lineage capture.
- Full readback keeps model text once and shared evidence/no-repeat/title
  framing. Payload chars/4 >50% of known soft warns/compression advice only.
  No rewriting, hard gate, source lock or fixed chain cap. Retention is manual;
  storage deletion loses handovers, crash-leftover temporary files can remain.

## Isolated non-model validation

Release asset: [v1.56.0 archive](https://github.com/aaif-goose/goose/releases/download/v1.56.0/goose-x86_64-unknown-linux-gnu.tar.gz),
published SHA256 `225a929b35b5130fb691eafdb50be236f2c0a150019b53973775938f8f19c281`
checked at download. Binary reports `1.56.0`.

Set absolute scratch paths before commands; all HOME/XDG and Goose root paths
must be isolated. `SESSION_JSON` is a synthetic native Session fixture with
bare `conversation: []`, `session_type: "user"`, null parent and usage 100/50/150.
Import assigns a new id; use that id as SID, not the fixture's old id.

```sh
: "${ISO:?}" "${BIN:?}" "${REPO:?}" "${SESSION_JSON:?}"
export HOME="$ISO/home" GOOSE_PATH_ROOT="$ISO"
export XDG_CONFIG_HOME="$ISO/config" XDG_DATA_HOME="$ISO/data"
export XDG_STATE_HOME="$ISO/state" XDG_CACHE_HOME="$ISO/cache"
mkdir -p "$HOME" "$ISO/.agents/plugins"
ln -s "$REPO/goose" "$ISO/.agents/plugins/auto-context-handover"
cd "$ISO"
"$BIN" --version
"$BIN" info
"$BIN" session import "$SESSION_JSON"
"$BIN" session list --format json
: "${SID:?set to the imported session id}"
"$BIN" session export --session-id "$SID" --format json
export AUTO_CONTEXT_HANDOVER_GOOSE_BIN="$BIN"
export AUTO_CONTEXT_HANDOVER_GOOSE_DATA="$ISO/handovers"
export AUTO_CONTEXT_HANDOVER_SOFT=100 AUTO_CONTEXT_HANDOVER_GOOSE_STOP=1
jq -n --arg id "$SID" '{event:"Stop",session_id:$id}' |
  node --experimental-strip-types "$REPO/goose/hook.ts"
# probe.json: {"steps":[{"action":"listTools"},
# {"action":"callTool","name":"read_handover","arguments":{"sessionID":"missing"}},
# {"action":"callTool","name":"context_handover","arguments":{"handover":"h","summary":"s"}}]}
RUST_LOG=info "$BIN" mcp-probe "node --experimental-strip-types $REPO/goose/server.ts" --script probe.json
```

Observed: import/export usage 150, matching root id/null parent; manual Stop
over soft yields block/final-stage, opt-out yields `{}`, SessionStart banner
contains installed names. Real mcp-probe creates a Hidden session (no model),
logs `Loaded plugin hooks rule_count=2` for Stop/SessionStart, persists enabled
plugin config, lists both tools, successfully reads a missing record, refuses
Hidden writer at root check after passing host identity. `info` paths were
isolated; recipe validation also passed. Probe names extension `probe`, so it
does not establish actual installed plugin tool prefix dispatch.

Separate real SDK stdio process: lists tools, rejects missing/mismatched
metadata, stores imported-root model strings and reads them verbatim; prefixed
tool name accepted. This is manually supplied metadata, not proof of root
host dispatch. Actual hooks, child attribution, models, trust/compliance,
native final delivery and manual fresh-root continuation remain unverified.
