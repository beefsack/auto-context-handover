# AiderDesk adapter assessment

Status (2026-10-29): **root Agent-mode advisory/storage adapter; manual
continuation only**. Automatic rollover is removed: fresh background-task
initialization is not established through the public API. HOME storage scoped by
project identity and task id handles shared working directories. Assessed loader registration was observed
without Electron or a model; model compliance/manual continuation remain
unverified. Native children are excluded. [Change note](../changes/archive/aiderdesk-adapter.md).

## Assessed versions and primary sources

App: `aider-desk@0.90.0-dev`, commit
`831d10d65438a7373920b6927231e3ed09445b68` (2026-10-28), Apache-2.0.
Types/installer: `@aiderdesk/extensions@0.39.0`, npm gitHead
`efe6f331a9f3d8df8739df2420e0e35d4cf7338d`, MIT. The assessed app source and
published types are distinct; both were inspected, and the adapter compiles
against the real published declarations. Host Zod is `4.6.7`, jiti `2.6.1`.

- [E] [Events](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/docs-site/docs/extensions/events.md),
  [API reference](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/docs-site/docs/extensions/api-reference.md),
  [event flow](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/docs-site/docs/extensions/event-flow.md).
- [T] [Extension contracts](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/packages/common/src/extensions.ts):
  `AgentStartedEvent`, `AgentStepStartedEvent`, `TaskContext`, `ProjectContext`,
  `ToolDefinition`, `ExtensionContext`, `Extension`.
- [A] [Agent](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/src/main/agent/agent.ts#L2054-L2105):
  whole-prompt estimator; step dispatch at 1286-1299; native usage formula at 2317-2380.
- [K] [Task](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/src/main/task/task.ts#L949-L1043):
  prompt queue/completion; subagents at 1450-1535; native compaction/handoff at 3640-3856.
- [P] [Project creation](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/src/main/project/project.ts#L92-L184),
  [task wrapper](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/src/main/extensions/task-context.ts),
  [project wrapper](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/src/main/extensions/project-context.ts).
- [F] [Native create-and-run initialization](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/src/main/agent/tools/tasks.ts#L420-L445),
  [task initialization](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/src/main/task/task.ts#L570-L687),
  [working directory](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/src/main/task/task.ts#L769-L771).
- [L] [Loader](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/src/main/extensions/extension-loader.ts),
  [manager](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/src/main/extensions/extension-manager.ts):
  discovery at 853-885, validation/registration at 1050-1206, folder copying at 2026-2054.
- [I] [Installation](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/docs-site/docs/extensions/installation.md),
  [creating extensions](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/docs-site/docs/extensions/creating-extensions.md),
   [native handoff/compaction](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/docs-site/docs/core/handoff-and-compaction.md).
- [V] [Verifier filesystem access](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/packages/extensions/extensions/verifier/index.ts#L65-L96):
  extension-local `config.json` path at line 69, direct `writeFileSync` at line 95.
  The loader's options (17-24) and `createJiti` call (44) install no filesystem sandbox.

## Capabilities and evidence

"Source-established" is a pinned implementation fact, not runtime/model proof.

| Capability | Documented/source-established | Observed / unverified |
| --- | --- | --- |
| Current request measurement | `UsageReportData` is per response/tool, not session totals. Native auto-compaction takes latest sent + received + cache-read and trailing message estimate [A]. `getEstimatedTokens()` separately rebuilds system, tool definitions and saved messages and estimates the whole prompt [A,P]. | MVP uses the latter, never cost-weighted/cumulative totals. Zero/error means unknown. Heuristic accuracy and later extension changes unverified. |
| Model limit | `getModelConfigs()` exposes provider/id/maxInputTokens [T]. Match the active event profile, not an unrelated root model. | Real types compile; unknown-window integer/percent behavior fixture-covered. Provider discovery can fail or be delayed. |
| Per-step trusted injection | `onAgentStarted.contextMessages` introduces workflow; `onAgentStepStarted.messages` is mutable before each Agent call [E,T,A]. Optimize/transform/cache hooks can further alter messages. | Introduction and transient end notices fixture-covered; no system-prefix rewrite or system-priority/compliance claim. |
| Tools and attribution | Custom Zod `ToolDefinition.execute` receives task-bound context [T,L]. Model sees short names; full approval keys are folder-id plus `---` plus tool name [L]. | Real loader instantiation and actual Zod schemas observed. Real approval/callback execution unverified. |
| Blocking/stopping | `blocked` supported on prompt/agent/subagent start and approval events; `onToolCalled` modifies input, not a universal deny. `interruptResponse`/`resumeTask` exist [E,T]. | MVP uses no token gate, source lock or interruption. Disabled tools/approval policies remain host-owned. |
| Automatic rollover | `createTask` prepares, but does not initialize; wrappers call create/run directly [P]. Native create-and-run explicitly calls private `init()` [F]; public context exposes `isInitialized()`, not `init()` [T]. | Absent: unsafe/unestablished automatic path removed. Fresh-task missing-init behavior was not live-tested; no workaround/private import. Manual UI-created continuation remains unverified. |
| UI | Creation accepts `activate`; parent linkage inherits source settings/worktree [P]. Renderer UI components separately expose `activateTask`, not a main-context select method [T]. | Adapter never creates/activates a task. User creates/opens a fresh task normally; no setting/model-preservation promise. |
| Native subagents | `runSubagent` shares its task, adds per-run prompt context, sends `SubagentStarted` and mutable `SubagentFinished.resultMessages` back to the caller [K,E]. Profile identity is not an independent task id. | Excluded: no child-specific storage/measurement/parent delivery port. Native result flow source-established only. |
| Storage | No extension KV contract found. Extensions run in the host main process with unrestricted Node filesystem access: the assessed loader uses plain jiti with no fs sandbox [L], the creating-extensions guide shows `readFileSync`/`axios` use [I], and the bundled verifier reads/writes its own folder via `node:fs` [V]. | Private `~/.aiderdesk/auto-context-handover/<sha256(projectId + '\0' + taskId)>` files scope, verbatim first-writer storage, cross-instance/reload/shared-directory/project-isolation fixtures. No quota/TTL/eviction, task-deletion cleanup, same-user sandbox or fsync promise. |
| Installation/build | Global/project extension dirs, TypeScript class default export; jiti loads directly with host Zod alias [I,L]. | Real forwarding-entry loader check passes. Bare folder copy loses shared imports. Directory symlink is skipped by discovery and direct loading also failed relative-import resolution. |
| Native handoff/compaction | `PromptTemplateEvent` can override prompt text, but native handoff and compaction call separate auxiliary generation, even when defaulting to the task's model [K,I]. | Not reused: same model identifier is not the active session writing its handover. No prompt override/settings changes; native strategies may still run independently. |
| Headless validation | Desktop app is Electron; contracts also recognize Node/headless operation (`getElectronApp()` may return null) [T]. The loader itself does not require Electron [L]. | Actual pinned loader checked with only logger stubbed and module-resolution aliases. Full desktop/server lifecycle and model requests were not exercised. |

Checklist: [all twelve requirements](../adapters.md#aiderdesk-root-agent-task-mvp).

## Lifecycle and limitations

- The model writes the handover through its normal tool call. Text and summary
  are immutable, verbatim, first writer wins via complete-file atomic hard link.
  The tool advises ending the turn; it does not lock or stop the source.
- The user creates/opens a fresh Agent-mode task normally in the same project
  and supplies the returned reader-reference prompt. It identifies the source
  task and shared no-repeat/evidence/title framing; readback includes the full
  text once. Keep the source loaded and its working directory available.
- Storage is `~/.aiderdesk/auto-context-handover/<sha256(projectId + '\0' + taskId)>/handover.json`.
  Identity is host project `baseDir`, then `getProjectDir()`, then task
  `getTaskDir()` if earlier sources are unavailable. Files survive extension
  reload/compaction, worktree moves and removals, but changed project identity
  prevents normal readback. There is no task-deletion cleanup, quota, TTL or
  eviction. Retention is manual; nothing is written inside the project working directory.
  New directories/files use 0700/0600, not a
  same-user sandbox. Publication is not fsync durability; interrupted writes
  may leave temporary files. No original-task capture, context-file copying,
  requested-override observation, parent-only reader or arbitrary-path reader.
- `createTask` calls `prepareTask`, which loads data, not context/worktree init
  [P:195-225]. `init()` loads context, configures worktrees/connectors and emits
  initialization [F]. Native create-and-run and handoff explicitly call it;
  public `TaskContext` cannot. The bundled
  [verifier extension](https://github.com/hotovo/aider-desk/blob/831d10d65438a7373920b6927231e3ed09445b68/packages/extensions/extensions/verifier/index.ts#L226-L267)
  also uses create/run without init, but that is not proof of safe background initialization. With
  no established public initializer and no live proof, automatic rollover is
  deliberately absent, including its attempt/outcome files and prompt hook.
- Rejected approaches: read/check/rename first-writer publication (racy),
  treating `getTaskDir()` as task-private (cross-task collisions), and automatic
  create/run on uninitialized tasks. Current atomic publication and project-scoped
  different-id fixtures address storage. Symlink loading passed plain Node but
  failed real discovery/loader resolution; use a real forwarding entry instead.

## Reproducible non-model checks

Required absolute inputs: `REPO` (installed repository), `PINNED` (app clone at
the commit above), `ISO` (fresh isolated directory). All harness state stays
under `ISO`. No prompts or model selection are needed.

```sh
: "${REPO:?}" "${PINNED:?}" "${ISO:?}"
mkdir -p "$ISO/home" "$ISO/config" "$ISO/cache"
export HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" XDG_CACHE_HOME="$ISO/cache"
export npm_config_cache="$ISO/npm-cache"
npm view @aiderdesk/extensions@0.39.0 version gitHead --json
node "$REPO/node_modules/@aiderdesk/extensions/dist/cli.js" --version
node "$REPO/node_modules/@aiderdesk/extensions/dist/cli.js" --help
npm install --prefix "$ISO/loader" --no-audit --no-fund jiti@2.6.1
export NODE_PATH="$ISO/loader/node_modules:$REPO/node_modules"
node --input-type=module <<'JS'
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { REPO, PINNED, ISO } = process.env;
const require = createRequire(`${REPO}/package.json`);
const jitiPath = `${ISO}/loader/node_modules/jiti/lib/jiti.cjs`;
const { createJiti } = require(jitiPath);
const entry = `${ISO}/extensions/aiderdesk/index.ts`;
await mkdir(`${ISO}/extensions/aiderdesk`, { recursive: true });
await writeFile(entry, `export { default } from ${JSON.stringify(`${REPO}/aiderdesk/index.ts`)};`);
const logger = `${ISO}/logger.mjs`;
await writeFile(logger, 'export default {debug(){},info(){},warn(){},error(...a){console.error(...a)}};');
const jiti = createJiti(REPO, { fsCache: false, moduleCache: false, alias: {
  jiti: jitiPath, zod: require.resolve('zod'),
  '@aiderdesk/extensions': require.resolve('@aiderdesk/extensions'),
  '@/logger': logger, '@common/extensions': `${PINNED}/packages/common/src/extensions.ts`,
}});
const { ExtensionLoader } = await jiti.import(`${PINNED}/src/main/extensions/extension-loader.ts`);
const loaded = await new ExtensionLoader().loadExtension(entry);
if (!loaded) throw Error('Loader failed');
const context = { log(){}, addDisposable(setup){setup();} };
await loaded.extension.onLoad(context);
const tools = loaded.extension.getTools(context, 'agent', { isSubagent: false });
const { z } = require('zod');
if (tools.length !== 2 || tools.some(t => !(t.inputSchema instanceof z.ZodType))) throw Error('Tools failed');
console.log(loaded.metadata.name, tools.map(t => t.name), 'STUB-SMOKE-PASS');
JS
```

Observed: npm version `0.39.0` and gitHead above; CLI version `0.39.0`, help
lists install/list/help; real pinned loader returned `Auto Context Handover`,
`context-handover`, `read-handover`, both real `ZodType`, and
`STUB-SMOKE-PASS`. Discovery's real-folder predicate was checked separately;
the full extension manager/app was not started. No Electron binary or full
headless server was needed for this scoped check.

Repository verification: `node --test "aiderdesk/**/*.test.ts"` (29 passed),
`npm run typecheck` (seven projects), `npm test` (570 passed), and isolated
`claude plugin validate .` (passed with existing author/icon warnings).
Fixtures/loader checks do not establish actual approvals, manual continuation,
native compaction interaction or model compliance.
