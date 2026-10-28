import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseThreshold } from "../source/shared/threshold.ts";
import { softStage } from "../source/shared/handover-text.ts";
import type { AgentInfo, CrushApi, SessionInfo } from "./client.ts";
import { CrushHttpClient } from "./client.ts";
import {
  baseDirFromEnv,
  CrushStore,
  HANDOVER_TOOL,
  READ_TOOL,
  type HandoverDiagnostics,
} from "./store.ts";
import {
  buildAdvisory,
  buildLockedReason,
  TOOL_NAMES,
} from "./text.ts";

export const DEFAULT_SOFT = 150000;
export const SOFT_ENV_VAR = "AUTO_CONTEXT_HANDOVER_SOFT";
export const SOCKET_ENV_VAR = "AUTO_CONTEXT_HANDOVER_CRUSH_SOCKET";
// Release-only pin: the root MVP targets v0.98.2, never an unreleased lifecycle.
export const SUPPORTED_CRUSH_VERSION = "v0.98.2";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function resolveSocket(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[SOCKET_ENV_VAR];
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new ConfigError(`crush hook: ${SOCKET_ENV_VAR} must be an absolute socket path`);
  }
  return value;
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return baseDirFromEnv(env);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
}

export type SoftSpec = { readonly kind: "tokens"; readonly tokens: number } | { readonly kind: "percent"; readonly ratio: number };

/** Absolute integer strings or "70%" percentages via the shared parser. Anything else is a config error. */
export function parseSoftSpec(env: NodeJS.ProcessEnv = process.env): SoftSpec {
  const raw = env[SOFT_ENV_VAR];
  if (raw === undefined) return { kind: "tokens", tokens: DEFAULT_SOFT };
  const trimmed = raw.trim();
  try {
    if (/^\d+$/.test(trimmed)) return parseThreshold(Number(trimmed)) as SoftSpec;
    return parseThreshold(trimmed) as SoftSpec;
  } catch (error) {
    throw new ConfigError(`crush hook: ${SOFT_ENV_VAR} must be a "70%" string or a positive absolute integer of tokens: ${(error as Error).message}`);
  }
}

/**
 * Integer softs are capped at 70% of the known window. Percentages resolve
 * only against a known window; otherwise the soft stays unknown (undefined)
 * and the hook fails open with no notice and no capability.
 */
export function resolveSoftTarget(spec: SoftSpec, window: number | undefined): number | undefined {
  if (spec.kind === "percent") {
    if (window !== undefined) return Math.floor(spec.ratio * window);
    return undefined;
  }
  if (window !== undefined) return Math.min(spec.tokens, Math.floor(0.7 * window));
  return spec.tokens;
}

type HookRecord = Record<string, unknown>;

function asRecord(value: unknown): HookRecord | undefined {
  return typeof value === "object" && value !== null ? (value as HookRecord) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function canonicalDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Latest saved nonzero prompt+completion counter replacement (not totals). Undefined means unknown. */
export function estimateFromSession(session: SessionInfo): number | undefined {
  const prompt = safeInteger(session.prompt_tokens);
  const completion = safeInteger(session.completion_tokens);
  if (prompt === undefined || completion === undefined) return undefined;
  const sum = prompt + completion;
  if (!Number.isSafeInteger(sum) || sum <= 0) return undefined;
  return sum;
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Known model window in tokens; percentages are usable only when this is defined. */
export function windowFromAgent(agent: AgentInfo): number | undefined {
  return positiveFinite(agent.model.context_window);
}

/** Effective model, recorded only. The workspace owns model resolution; overrides are never requested. */
export function modelFromAgent(agent: AgentInfo): string {
  if (agent.model_cfg && agent.model_cfg.provider.length > 0 && agent.model_cfg.model.length > 0) {
    return `${agent.model_cfg.provider}/${agent.model_cfg.model}`;
  }
  if (agent.model.id.length > 0) return agent.model.id;
  return "unknown";
}

function isOwnTool(toolName: string): boolean {
  return toolName === TOOL_NAMES.handover || toolName === TOOL_NAMES.read;
}

interface Observation {
  readonly workspaceId: string;
  readonly model: string;
  readonly window: number | undefined;
  readonly estimate: number | undefined;
  readonly soft: number | undefined;
  readonly nudged: boolean;
  readonly stage: "warn1" | "warn2" | "warn3" | undefined;
}

/**
 * Best-effort observation over the bounded root API. Undefined means fail
 * open: ordinary tools get no nudge and own tools get no capability, so an
 * unreachable or mismatched API can never authorize an unbound MCP tool.
 * Rejects non-root sessions (nonempty parent_session_id) and workspace
 * mismatches by returning undefined.
 */
async function observe(api: CrushApi, sessionId: string, cwd: string, softSpec: SoftSpec): Promise<Observation | undefined> {
  let version: string | undefined;
  try {
    version = (await api.getVersion()).version;
  } catch {
    return undefined;
  }
  if (version !== SUPPORTED_CRUSH_VERSION) return undefined;
  let workspaces: readonly { id: string; path: string }[];
  try {
    workspaces = await api.listWorkspaces();
  } catch {
    return undefined;
  }
  const want = canonicalDir(cwd);
  const workspace = workspaces.find((entry) => entry.path === want || canonicalDir(entry.path) === want);
  if (!workspace) return undefined;
  let session: SessionInfo;
  try {
    session = await api.getSession(workspace.id, sessionId);
  } catch {
    return undefined;
  }
  // Root-only adapter: a nonempty parent means this is not a root session.
  if (session.parent_session_id !== "") return undefined;
  let model = "unknown";
  let window: number | undefined;
  try {
    const agent = await api.getAgent(workspace.id);
    model = modelFromAgent(agent);
    window = windowFromAgent(agent);
  } catch {
    model = "unknown";
    window = undefined;
  }
  const estimate = estimateFromSession(session);
  const soft = resolveSoftTarget(softSpec, window);
  const rawStage =
    estimate === undefined || soft === undefined ? ("ok" as const) : softStage(estimate, soft);
  const nudged = rawStage !== "ok";
  return {
    workspaceId: workspace.id,
    model,
    window,
    estimate,
    soft,
    nudged,
    stage: rawStage === "ok" ? undefined : rawStage,
  };
}

function diagnosticsFor(observation: Observation): HandoverDiagnostics {
  // Reason is intentionally always unknown: this adapter has no persistence
  // feature distinguishing nudged from explicit handover/read calls.
  return {
    reason: "unknown",
    ...(observation.stage === undefined
      ? {}
      : { stage: observation.stage === "warn3" ? ("final" as const) : observation.stage }),
    ...(observation.estimate === undefined ? {} : { estimatedTokens: observation.estimate }),
    ...(observation.soft === undefined ? {} : { soft: observation.soft }),
  };
}

function closedStatus(store: CrushStore, sessionId: string): { closed: boolean; successorId: string | undefined } {
  try {
    if (!store.getHandover(sessionId)) return { closed: false, successorId: undefined };
  } catch {
    // Swallow storage errors and treat the session as open; the server
    // re-verifies strictly before any mutation, so corruption yields an
    // error there, never a write.
    return { closed: false, successorId: undefined };
  }
  let successorId: string | undefined;
  try {
    successorId = store.getStatus(sessionId)?.successorId;
  } catch {
    successorId = undefined;
  }
  return { closed: true, successorId };
}

export async function handleHook(
  input: unknown,
  store: CrushStore,
  api: CrushApi,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookRecord> {
  const softSpec = parseSoftSpec(env);
  const hook = asRecord(input);
  if (!hook) return {};
  const event = nonEmptyString(hook.event) ?? nonEmptyString(hook.hook_event_name);
  if (event !== "PreToolUse") return {};
  const sessionId = nonEmptyString(hook.session_id);
  const cwd = nonEmptyString(hook.cwd);
  if (!sessionId || !cwd) return {};
  const toolName = typeof hook.tool_name === "string" ? hook.tool_name : "";

  // Tool backstop: a closed source is denied and halted for every tool.
  const { closed, successorId } = closedStatus(store, sessionId);
  if (closed) {
    return { decision: "deny", halt: true, reason: buildLockedReason(toolName || "tool call", sessionId, successorId) };
  }

  if (!isOwnTool(toolName)) {
    const observation = await observe(api, sessionId, cwd, softSpec);
    if (!observation || observation.estimate === undefined || !observation.nudged || observation.stage === undefined || observation.soft === undefined) return {};
    // Stable advisory context only: never a permission decision, never an allow.
    return { context: buildAdvisory(observation.stage, observation.estimate, observation.soft) };
  }

  const observation = await observe(api, sessionId, cwd, softSpec);
  // Without a matched workspace there is no safe binding; fail open with no
  // capability so the server rejects the call as unbound. Unknown soft still
  // binds: explicit handover and read recovery must not require a threshold.
  if (!observation) return {};
  const pendingTool = toolName === TOOL_NAMES.read ? READ_TOOL : HANDOVER_TOOL;
  const token = store.createPending({
    tool: pendingTool,
    caller: {
      sessionId,
      workspaceId: observation.workspaceId,
      ...(observation.model === "unknown" ? {} : { model: observation.model }),
    },
    args: hook.tool_input === undefined ? null : hook.tool_input,
    diagnostics: diagnosticsFor(observation),
  });
  // Shallow-merge patch: original args survive, capability is added.
  return { updated_input: { capability: token } };
}

function main(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (error) {
    process.stderr.write(`crush hook: failed to read stdin: ${(error as Error).message}\n`);
    process.exit(2);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`crush hook: stdin is not valid JSON: ${(error as Error).message}\n`);
    process.exit(2);
    return;
  }
  let store: CrushStore;
  let api: CrushHttpClient;
  try {
    // CRUSH_PROJECT_DIR is the host cwd, also the workspace path: fixed by
    // the host, never taken from per-tool input.
    store = new CrushStore(resolveDataDir(process.env));
    api = new CrushHttpClient(resolveSocket(process.env));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
    return;
  }
  handleHook(parsed, store, api, process.env).then(
    (output) => {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    },
    (error: unknown) => {
      process.stderr.write(`crush hook: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

const invokedAsMain = isMainModule();

if (invokedAsMain) main();
