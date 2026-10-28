# Kilo adapter: capabilities and evidence

Status (2026-10-29): root advisory/manual MVP in `kilo/`. Pin
`@kilocode/cli`, `@kilocode/plugin`, `@kilocode/sdk` **7.8.23** and source
`722e4656118fbcdad602179ffd8bde0237007e4a`; current CLI-backed VS Code extension
source also reports `7.8.23`. Legacy Roo-derived extensions are not targeted.
[Install](../../README.md#kilo-root-session-adapter),
[checklist](../adapters.md#kilo-root-session-mvp).

## Sources and capability table

Documented = public guide; source-established = pinned code; observed =
isolated non-model check. None establishes model compliance or continuation.

- [P] [Plugin guide](https://kilo.ai/docs/automate/extending/plugins),
  [legacy contracts](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/plugin/src/index.ts#L60-L78),
  [loader](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/opencode/src/plugin/index.ts#L97-L135),
  [V2 context](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/plugin/src/v2/promise/context.ts).
- [V] [Extension manifest](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/kilo-vscode/package.json#L1-L19),
  [CLI backend spawn](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/kilo-vscode/src/services/cli-backend/server-manager.ts#L100-L135).
- [H] [User-message hook and persistence](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/opencode/src/session/prompt.ts#L1391-L1439),
  [filtered loop](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/opencode/src/session/prompt.ts#L1555-L1569),
  [transform before conversion/editor injection](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/opencode/src/session/prompt.ts#L1810-L1853).
- [U] [Usage normalization](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/opencode/src/session/session.ts#L420-L464),
  [legacy message/session/catalog types](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/sdk/js/src/gen/types.gen.ts).
- [C] [Compaction transform and summary identity](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/opencode/src/session/compaction.ts#L427-L509),
  [retained-tail projection](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/opencode/src/session/message-v2.ts#L663-L724).
- [T] [Tool definition](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/plugin/src/tool.ts),
  [non-model tool-id handler](https://github.com/Kilo-Org/kilocode/blob/722e4656118fbcdad602179ffd8bde0237007e4a/packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts#L129-L131).

| Capability | Documented / source-established | Observed / unverified |
| --- | --- | --- |
| Surfaces | Guide explicitly covers CLI and current VS Code extension [P]; extension spawns bundled CLI `serve` [V]. | CLI loading/registry observed; extension runtime unverified. Not a legacy-extension claim. |
| OpenCode reuse | Kilo retains OpenCode source lineage, but legacy descriptor/hooks differ from V2 `Plugin.define`; Kilo V2 context lacks required session/tool/storage domains [P]. | Root `index.ts` rejected by pinned CLI: `must default export an object with server()`. Separate adapter reuses pure logic, not lifecycle/storage shims. |
| Measurement | Per-response input subtracts cache, output subtracts reasoning [U]. Ordinary transform sees active filtered history before later conversion/injection/pruning [H]. | Shared five-field anchor + Kilo text/tool-output mapping fixture-covered; provider accuracy/window freshness unverified. Never sum Session/billing totals. |
| Compaction | Same transform also feeds summarizer; summary usage measures its input, retained tail may be reordered after summary [C]. | Observer skips paired summary transform; summary/compaction assistants never anchor, old retained-tail anchors excluded by chronology. Fresh ordinary usage required afterward; ambiguous timestamps unknown. Fixtures only. |
| Injection | `chat.message` edits root user parts before persistence; message transform can append transient tail messages [H,P]. | Intro/root exclusion/notice stages fixture-covered; real hook firing/trust/compliance unverified. No system-prefix rewrite. |
| Tools / identity | Direct custom-tool map, tool context sessionID/agent, SDK get returns session parentID [P,T,U]. | Real registry lists each tool once. Fresh matching parentless lookup required at writer; root routing/child refusal fixtures, not model-session observations. |
| Window / stages | Legacy catalog exposes context/output limits, no input limit [U]. Latest user request's provider/model selects context; shared integer cap/percent/stages. | Catalog cached per registration; integer unknown-window fallback uncapped, percentages silent. Invalid configuration disables notices only. Fixture-covered. |
| Storage / reader | Adapter-owned HOME hashed-id immutable handover+summary, atomic first-writer link publish; dirs/files 0700/0600. | Concurrent first-wins, permissions, corruption/reload/full readback fixtures. Any equipped caller may read any retained id; no sandbox/quota/TTL/eviction/deletion cleanup/fsync promise. |
| Continuation | SDK session primitives exist, but no equivalence to V2 in-process rotation, admission or client following is claimed [P,U]. | Manual fresh equipped root reader reference only. No source lock, gate, automatic create/prompt, original-task capture, child workflow or override-preservation guarantee. |

## Implementation boundaries and review

- `kilo/index.ts` has no runtime Kilo import/build: typechecked legacy hooks,
  existing Zod schemas and shared pure helpers. Host-Zod conversion accepts and
  rejects correct types but drops cross-version per-arg descriptions; complete
  tool descriptions survive. This loss is fixture-pinned, not hidden by the cast.
- Intro is once per registration, not lifetime-deduplicated; a new message after
  reload may persist another intro. Compaction can discard it. Notices name the
  tools and read-only storage permission; advisory precedence/compliance is not
  guaranteed. No source lock/stop interception; first stored text cannot change.
- Diagnostics are latest estimate/stage/effective soft plus notice-append
  reason, not receipt; lost transient values are unknown. Effective model,
  override, original task and chain provenance are unknown. Reader returns full
  verbatim text once/shared framing; handover-only chars/4 >50% soft warns only.
- Independent review found summary-transform contamination, invalid id prefixes,
  optional input message-id misuse, cross-version schema-description loss and
  reload-intro overclaim. Resolved with an observation-only skip flag, prefixed
  ids bound to host output message id, host-Zod conversion tests and honest
  reload/loss documentation. The flag is session-scoped; an aborted compaction
  before transform can suppress one later ordinary notice. Integration review
  additionally excluded summary/pre-summary retained-tail usage anchors.
- Development dependency audit: pinned `@kilocode/plugin@7.8.23` adds high
  advisories through `effect@4.0.0-beta.83 -> toml@4.3.0` and nested
  `zod@4.1.8`. These nodes are development-only; Kilo imports in the adapter
  are type-only, shipped schemas use existing root `zod@4.6.7`, and the older
  host Zod is loaded only by conversion tests. No overrides or unrelated
  upgrades: retain host fidelity without introducing runtime imports of these
  paths. Revisit if that import boundary changes. Other audit findings predate
  this adapter.

## Non-model validation

All HOME/XDG paths and project configuration were isolated. Commands below use
absolute scratch/checkout placeholders; external plugins enabled (`KILO_PURE`
unset). No prompts/inference or credentials needed.

```sh
npm install --prefix "$ISO/install" @kilocode/cli@7.8.23
"$ISO/install/node_modules/.bin/kilo" --version
"$ISO/install/node_modules/.bin/kilo" --help
# In an isolated project, kilo.json points at the intact checkout's kilo/index.ts:
"$ISO/install/node_modules/.bin/kilo" debug config --log-level ERROR
"$ISO/install/node_modules/.bin/kilo" agent list --print-logs --log-level DEBUG
"$ISO/install/node_modules/.bin/kilo" serve --hostname 127.0.0.1 --port "$PORT"
# From a separate shell; stop only that server after the checks:
curl -fsS "http://127.0.0.1:$PORT/global/health"
curl -fsS --get --data-urlencode "directory=$PROJECT" \
  "http://127.0.0.1:$PORT/experimental/tool/ids"
```

Observed: version/health `7.8.23`, config contains adapter once, agent listing
loads without plugin errors, real registry includes `context_handover` and
`read_handover` exactly once each. Separate root-entry control logs rejection
and registry lacks both names (exactly two fewer). Schema conversion is a
direct server/host-Zod fixture, not a real model-schema exposure observation.
Extension UI loading, actual hook dispatch, model receipt/stop behavior and
manual continuation remain unverified.

Repository verification: Kilo **35/35** tests using `os.tmpdir()`;
`npm run typecheck` passed; `npm test` **708/708** passed.
`claude plugin validate .` passed with author warnings and an icon advisory.
