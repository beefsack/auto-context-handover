# Cline CLI/SDK adapter

Status (2026-10-29): root-only advisory/storage MVP for `cline@3.0.74` and
`@cline/sdk@0.2.0`. Manual fresh-session continuation; no automatic rollover,
child workflow or compaction changes. Fixtures and non-model loading do not
establish model compliance or end-to-end continuation.

## Pins and primary sources

- [I] [Official CLI installation](https://docs.cline.bot/cline-cli/overview):
  `npm i -g cline`. Registry metadata pins `cline@3.0.74`, binary `cline`,
  repository `cline/cline`, directory `apps/cli`. Its SDK, core, shared, agents
  and llms dependencies are exactly `0.2.0`. npm metadata exposes no gitHead;
  citations below pin shipped packages, not an invented source commit.
- [W] [Writing plugins](https://docs.cline.bot/sdk/guides/writing-plugins):
  `AgentPlugin`, tool registration, file `pluginPaths`, package `cline.plugins`
  manifest and CLI installation. Copying only `cline/index.ts` loses its shared
  relative imports: install the repository package or use its absolute SDK path.
- [P] [Plugin lifecycle](https://docs.cline.bot/sdk/plugins): worker per plugin
  per session, plain-data boundary, session binding, hook timing and policies.
  Hooks default to fail-open (`hookErrorMode: ignore`); five consecutive failures
  disable a plugin. Policy can hide tools. No system-priority guarantee.
- [A] [Agent declarations](https://unpkg.com/@cline/shared@0.2.0/dist/agent.d.ts):
  `AgentModelRequest`, snapshot, tool context and seven hook contracts.
- [R] [Registry declarations](https://unpkg.com/@cline/shared@0.2.0/dist/extensions/contribution-registry.d.ts):
  setup session id, registration, `onDispose` and capabilities.
- [L] [File loader](https://unpkg.com/@cline/core@0.2.0/dist/extensions/plugin/plugin-loader.d.ts)
  and [shipped implementation](https://unpkg.com/@cline/core@0.2.0/dist/index.js):
  default/named plugin export, jiti TypeScript loader and runtime integration.
- [S] [SDK session API](https://unpkg.com/@cline/core@0.2.0/dist/ClineCore.d.ts),
  [host contracts](https://unpkg.com/@cline/core@0.2.0/dist/runtime/host/runtime-host.d.ts)
  and [delegated agent](https://unpkg.com/@cline/core@0.2.0/dist/extensions/tools/team/delegated-agent.d.ts).

## Capabilities and verification boundaries

| Capability | Documented / shipped contract | Observed / unverified |
| --- | --- | --- |
| Measurement | `beforeModel.request` includes systemPrompt, messages, tools and modelTools [A,P]. Snapshot usage is not established as current-window usage. | Adapter serializes those four fields, estimates ceil(chars/4), excluding options/signal and its later notice. Heuristic, not exact provider tokens or billing totals. Accuracy unverified. |
| Window | No model-window field in this hook [A]. Other SDK APIs know models, but no hook-bound window lookup is established. | Integer-only soft default 150000, uncapped. Choose below the configured model's compaction budget; no percentage support. |
| Introduction / injection | `beforeRun.appendContext` creates first-request hook context; `beforeModel.messages` replaces the in-flight request [A,P]. | Root introduction and transient end notice fixture-covered; no system-prefix edit. Trust/compliance unverified. Native prepare-turn compaction can run before this hook. |
| Tools | `setup.registerTool`, JSON schemas, host call identity/snapshot [A,R,W]. | Direct writer/reader, no deferred loader. Registration is not proof of availability under all policies. |
| Storage | Node file access available to plugins [W,P]; no private quota/retention API established. | Adapter-owned immutable files, verbatim handover+summary, first-writer atomic publication, hashed source ids. Real-filesystem fixtures; no quota/TTL/eviction or fsync guarantee. |
| Continuation | `ClineCore.start` creates fresh sessions; `send` continues existing ones [S]. No documented plugin UI-switch API. | Manual new session using reader reference. No automatic create/run, source lock, stop interception or model/override preservation claim. |
| Subagents | Native spawn_agent waits for final result; child runtime has distinct agent/conversation identity and parent linkage [S,A,L]. | Not integrated. Root-only notices/writes; no child handback/replacement/count-limit claims. |
| Installation | Package CLI install and SDK pluginPaths [W,P]. Agent Plugins v1 (skills/MCP) is a separate no-hooks surface [L]. | Pinned CLI help/install and real loader checks are non-model evidence only; actual model routing remains unverified. |

## Storage and guidance limits

- Dedicated `~/.cline/auto-context-handover/<sha256(source-session-id)>/handover.json`;
  unrelated host databases/configs are not modified. New directories/files use
  0700/0600; same-user filesystem access is not a sandbox. Deleting storage loses
  readback. No host-session deletion cleanup; interrupted writes can leave temps.
  Storage follows HOME, not host `--data-dir` or XDG overrides. Default worker
  mode is the verified contract; opt-in sandbox transport remains unverified.
- Setup's root session id and host snapshot bind writes, never a model-authored
  caller id. Unsupported/unattributed writers fail explicitly. Readers hash a
  target sessionID, never resolve model-supplied paths; any equipped caller may
  read any retained id, including children. No parent-only reader authorization.
- First successful write is immutable. Reader returns full text once, source
  session/agent provenance, diagnostics and shared no-repeat/title-based framing.
  Effective model/override/original task/chain are not captured.
- Diagnostics reflect the latest request hook, not proof of model receipt.
  Unobserved/reloaded values remain unknown. Invalid or empty explicit
  AUTO_CONTEXT_HANDOVER_SOFT logs an error and disables notices, not tools.
- Advisory stop only: a model may ignore notices or continue after storage.
  Native compaction stays enabled and may happen before any notice. This adapter
  cannot promise pre-compaction authorship for every window/content type.

## Non-model validation

Final counts are recorded in the [completed change note](../changes/archive/cline-adapter.md).
`ISO`, `REPO` and `CLINE` denote an isolated directory, the repository and
the pinned CLI binary; HOME/XDG/npm state must stay under ISO.

```sh
: "${ISO:?}" "${REPO:?}" "${CLINE:?}"
env -i PATH="$PATH" HOME="$ISO/home" npm_config_cache="$ISO/npm-cache" \
  npm view cline@3.0.74 version dependencies bin repository --json
env -i PATH="$PATH" HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" \
  XDG_DATA_HOME="$ISO/data" XDG_CACHE_HOME="$ISO/cache" "$CLINE" --version
env -i PATH="$PATH" HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" \
  XDG_DATA_HOME="$ISO/data" XDG_CACHE_HOME="$ISO/cache" "$CLINE" plugin --help
env -i PATH="$PATH" HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" \
  XDG_DATA_HOME="$ISO/data" XDG_CACHE_HOME="$ISO/cache" \
  "$CLINE" plugin install "$REPO" --cwd "$ISO/project" --json
```

Observed: CLI version `3.0.74`, install/uninstall help, successful repository
package install with no MCP sync failures. Installer copies the package and
retains `source/shared`; no symlink or source-file-only installation is needed.
Using CLI-bundled `@cline/core@0.2.0` against that installed copy,
`loadAgentPluginFromPath(entry, {freshModule:true})` resolved the default export.
Fake API setup registered both tools; invoking real loaded hooks produced root
intro/heuristic notice, kept the request unchanged and ignored a child snapshot.
Writer/reader retained a whitespace-bearing body with `reason=nudged`. Installed
package uninstall succeeded. These are real-loader/fake-call checks, not actual
host event routing or model execution. The CLI emitted a certificate-store
diagnostic but all local install/help/uninstall operations exited 0.

Reproduce the loader check without starting a session (`CORE` is the installed
CLI's `@cline/core/dist/index.js`; `ENTRY` is install result `entryPaths[0]`):

```js
const { loadAgentPluginFromPath } = await import(CORE);
const plugin = await loadAgentPluginFromPath(ENTRY, { freshModule: true });
const tools = new Map();
await plugin.setup({ registerTool: t => tools.set(t.name, t) },
  { session: { sessionId: "isolated-check" } });
// Invoke hooks/tools with fake host contexts, not ClineCore.start or Agent.run.
if (!["context_handover", "read_handover"].every(n => tools.has(n)))
  throw new Error("Missing handover tools");
```

Do not use legacy `@cline/cli@0.0.13` / `clite`: its missing plugin command was
an initial wrong-package probe, not a limitation of the official CLI. The
official pinned CLI has install/uninstall, but no plugin-list subcommand.
