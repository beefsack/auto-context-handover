# GitHub Copilot CLI adapter (2026-10-29)

Targets `@github/copilot@1.0.105` (npm latest and CLI version observed).
Experimental CLI extensions supply the SDK bridge that command hooks alone lack.
This is a child-first plugin, not a replacement SDK harness. Checklist:
[adapters](../adapters.md#copilot-cli-subagent-first-mvp).

## Sources and evidence

- [X: Extension tutorial](https://docs.github.com/en/copilot/tutorials/create-an-extension)
- [P: Plugin manifests and commands](https://docs.github.com/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [H: Hook inputs, placement and outputs](https://docs.github.com/copilot/reference/hooks-reference)
- [A: Custom CLI agents](https://docs.github.com/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
- [U: SDK usage](https://docs.github.com/copilot/how-tos/copilot-sdk/features/usage-and-billing)
- [C: Config home and statusline](https://docs.github.com/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
- **S:** SDK shipped/extracted by [CLI 1.0.105](https://www.npmjs.com/package/@github/copilot/v/1.0.105): `docs/extensions.md`,
  `extension.d.ts`, `types.d.ts`, `generated/session-events.d.ts`.
  The shipped extension guide explicitly refers to these declarations for
  full API contracts. These are inspected contracts, not observed callbacks.
  Production checkJs uses development types from `@github/copilot-sdk@1.0.28`;
  its extension/tool/event declarations were compared byte-for-byte with S.

**Documented** means official docs or S declarations. **Observed** means isolated
non-model CLI/package inspection. **Fixture-covered** means synthetic unit inputs.
Actual host callback routing, model compliance and parent receipt are **unverified**.

| Capability | Evidence and limit |
| --- | --- |
| Installed SDK bridge | X documents plugin-shipped, separate Node processes and host-resolved SDK. S `joinSession` accepts tools/hooks and returns an event-capable session. Experimental, interactive-session surface. |
| Current context / window | S `UsageInfoEvent`/`UsageInfoData`: `currentTokens` (whole window, including system messages and tool definitions), `tokenLimit`, optional top-level `agentId`; absent id includes root/session-level events. Ephemeral, not replayed. Use latest attributed child snapshot only, never billing totals or summed requests. Real child emission/cadence unverified. |
| Introductions / cadence | H start-context placement; S SDK session/child-start hooks. Tool-success boundary notices, not a before-every-request gate. Tool-adjacent context may be ignored; no system-priority claim. |
| Identity / tools | S `ToolInvocation.agentId` is experimental and may be absent for all calls in an unattributing runtime. Refuse unidentified handovers rather than accept model-supplied ids. Both tools use defer:never (X/S). Hook child type is host provenance; requested model override remains unknown. |
| Parent delivery | H/S subagent-stop `modifiedResponse` replaces parent-returned text before spill; block wins, last rewrite wins. Return stored short receipt without forcing another model turn. Actual parent receipt unverified. |
| Child coverage | A separate contexts; H excludes built-in general-purpose from start/stop. Other YAML/custom children are intended scope. Missing attribution disables measured handovers conservatively. |
| Deny / closure | S pre-tool deny and direct mutation/reader checks refuse closed attributed children. No hard token gate, universal abort or OS-user sandbox. Disabled/failed hooks and unattributed calls remain limitations. |
| Packaging | P legacy manifest supports extension paths and repository subdirectories. Separate `copilot/plugin.json` avoids root Agent Plugins namespace differences and accidental Codex MCP registration. Installation/listing observed; extension launch remains unverified. |
| Storage | Directories 0700/files 0600; default under Copilot config home, trusted dedicated data-dir override. Atomic immutable exclusive publish; no quota/TTL/eviction or same-user sandbox. Ephemeral usage held in memory, unknown after reload. No reliance on MCP-only plugin-data injection. Both direct tools read closure strictly; ordinary hooks, including pre-tool denial, fail open on corrupt/unreadable closure. No claim about uncaught SDK-hook error handling. |
| Compaction / rollover | H preCompact notify-only. Keep native compaction unchanged; invalidate stale measurement. No automated root rotation. Parent reads and starts same-type successor; requested override comes from its original spawn parameters, not inferred usage. |
| Alternative signals | C documents a statusline command but official input/child usage semantics are not established. Transcript usage schema is unverified. Neither is needed once extensions expose current-window events. |

## Non-model checks

Use an isolated directory, not an existing Copilot home:

```sh
: "${ISO:?Set ISO to an isolated directory}"
: "${ROOT:?Set ROOT to the repository root}"
export HOME="$ISO/home" COPILOT_HOME="$ISO/copilot-home"
export XDG_CONFIG_HOME="$ISO/xdg-config" XDG_CACHE_HOME="$ISO/xdg-cache"
export XDG_DATA_HOME="$ISO/xdg-data" XDG_STATE_HOME="$ISO/xdg-state"
export NPM_CONFIG_CACHE="$ISO/npm-cache"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
npm view @github/copilot version dist-tags
npx --yes @github/copilot@1.0.105 --version
npx --yes @github/copilot@1.0.105 --help
npx --yes @github/copilot@1.0.105 plugin --help
npx --yes @github/copilot@1.0.105 help config
npx --yes @github/copilot@1.0.105 help limits
npx --yes @github/copilot@1.0.105 plugin install "$ROOT/copilot"
npx --yes @github/copilot@1.0.105 plugin list --json
npx --yes @github/copilot@1.0.105 mcp list
```

All exited 0. Version 1.0.105; standalone plugin enabled at 0.1.0; no MCP
servers configured (expected). Direct installs warn of future deprecation in
favor of marketplaces. Listing validates installation, not extension startup,
its extension-manager display name or hook/tool registration. The plugin root
is the extension directory; built-in extensions are not disabled. Plugin help
exposes no validate or extension-list command.
An earlier root-marketplace install registered the Codex MCP server only; it is
not evidence of a Copilot adapter. No model-generated fixtures were obtained.
