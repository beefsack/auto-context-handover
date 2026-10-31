import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { softStage } from "../source/shared/handover-text.ts";
import {
  estimateFromUsage,
  exportSessionJson,
  isRootSession,
  type ExportedSession,
  type SessionReader,
} from "./session.ts";
import { baseDirFromEnv, GooseStore } from "./store.ts";
import { buildStopDenial, SESSION_BANNER } from "./text.ts";

export const DEFAULT_SOFT = 200000;
export const SOFT_ENV_VAR = "AUTO_CONTEXT_HANDOVER_SOFT";
export const STOP_OPT_IN_ENV_VAR = "AUTO_CONTEXT_HANDOVER_GOOSE_STOP";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Positive integer token counts only; percentages and ratios are rejected. */
export function resolveSoft(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SOFT_ENV_VAR];
  if (raw === undefined) return DEFAULT_SOFT;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  throw new ConfigError(
    `goose hook: ${SOFT_ENV_VAR} must be a positive integer of tokens, got ${JSON.stringify(raw)}`,
  );
}

/** Stop denials are explicit opt-in; every other hook output is advisory. */
export function isStopOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STOP_OPT_IN_ENV_VAR] === "1";
}

type HookRecord = Record<string, unknown>;

function asRecord(value: unknown): HookRecord | undefined {
  return typeof value === "object" && value !== null ? (value as HookRecord) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function storedHandover(store: GooseStore, sessionId: string): boolean | undefined {
  try {
    return store.getHandover(sessionId) !== undefined;
  } catch {
    // Unknown storage must permit stopping, not masquerade as absent storage.
    return undefined;
  }
}

/**
 * Stop-only gate plus SessionStart banner. No PreToolUse hook exists, so this
 * hook never mints capabilities, rewrites input, or adds general context.
 *
 * Each Stop event is decided independently: deny only when explicitly opted
 * in, the payload session exports as the same root id, no handover is stored
 * yet, and the latest usage meets the soft limit. Consecutive denials are
 * bounded by the host (GOOSE_STOP_HOOK_BLOCK_CAP, default 8); this hook keeps
 * no loop state. Every unavailable signal fails open to `{}`.
 */
export function handleHook(
  input: unknown,
  store: GooseStore,
  reader: SessionReader,
  env: NodeJS.ProcessEnv = process.env,
): HookRecord {
  const hook = asRecord(input);
  if (!hook) return {};
  const event = nonEmptyString(hook.event) ?? nonEmptyString(hook.hook_event_name);
  if (event === "SessionStart") {
    return { banner: SESSION_BANNER };
  }
  if (event !== "Stop") return {};
  const sessionId = nonEmptyString(hook.session_id);
  if (!sessionId) return {};
  // An invalid soft limit disables Stop notices (fail open) but never blocks
  // SessionStart, the writer, or the reader; the writer stores without
  // soft/stage diagnostics in that case.
  let soft: number;
  try {
    soft = resolveSoft(env);
  } catch (error) {
    process.stderr.write(`goose hook: ${(error as Error).message}\n`);
    return {};
  }
  // An already-stored handover allows the turn to end; there is no lock.
  if (storedHandover(store, sessionId) !== false) return {};
  if (!isStopOptIn(env)) return {};

  let exported: ExportedSession;
  try {
    exported = reader(sessionId);
  } catch {
    return {};
  }
  if (typeof exported.id !== "string" || exported.id !== sessionId) return {};
  if (!isRootSession(exported)) return {};
  const estimate = estimateFromUsage(exported);
  if (estimate === undefined) return {};
  const stage = softStage(estimate, soft);
  if (stage === "ok") return {};
  return { decision: "block", reason: buildStopDenial(stage, sessionId, estimate, soft) };
}

function main(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (error) {
    process.stderr.write(`goose hook: failed to read stdin: ${(error as Error).message}\n`);
    process.exit(1);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`goose hook: stdin is not valid JSON: ${(error as Error).message}\n`);
    process.exit(1);
    return;
  }
  let store: GooseStore;
  try {
    store = new GooseStore(baseDirFromEnv(process.env));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
    return;
  }
  let output: HookRecord;
  try {
    output = handleHook(parsed, store, (id) => exportSessionJson(id, process.env), process.env);
  } catch (error) {
    process.stderr.write(`goose hook: ${(error as Error).message}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
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
