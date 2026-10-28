import { spawnSync } from "node:child_process";

export const GOOSE_BIN_ENV_VAR = "AUTO_CONTEXT_HANDOVER_GOOSE_BIN";
export const EXPORT_TIMEOUT_MS = 15000;
/** Upper bound for one `session export` payload; oversize exports are refused and treated as unknown. */
export const EXPORT_MAX_BUFFER = 16 * 1024 * 1024;

export class SessionExportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`goose session: ${message}`);
    this.name = "SessionExportError";
    this.code = code;
  }
}

export interface ExportedUsage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly total_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_write_input_tokens?: unknown;
}

export interface ExportedSession {
  readonly id: unknown;
  readonly session_type: unknown;
  readonly parent_session_id: unknown;
  readonly usage?: unknown;
  readonly provider_name?: unknown;
  readonly model_config?: unknown;
}

export type SessionReader = (sessionId: string) => ExportedSession;

export type SessionRunner = (
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => { status: number | null; stdout: string; stderr: string };

/** Goose binary for `session export`. Explicit env override wins; otherwise PATH lookup. */
export function resolveGooseBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[GOOSE_BIN_ENV_VAR];
  if (override !== undefined) {
    if (override.length === 0) throw new SessionExportError("INVALID_BIN", `${GOOSE_BIN_ENV_VAR} must not be empty`);
    return override;
  }
  return "goose";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Runs `goose session export --session-id <id> --format json` and parses the
 * native Session. The supplied env is passed to the child explicitly so the
 * caller controls which session DB the CLI sees (HOME/XDG); the default is
 * process.env. Only a retrieval failure is reported, never guessed. Payloads
 * past EXPORT_MAX_BUFFER throw EXPORT_TOO_LARGE and count as unknown usage.
 */
export function exportSessionJson(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  run: SessionRunner = defaultRun,
): ExportedSession {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new SessionExportError("INVALID_ID", "session id must be a non-empty string");
  }
  const bin = resolveGooseBin(env);
  let result: { status: number | null; stdout: string; stderr: string };
  try {
    result = run(bin, ["session", "export", "--session-id", sessionId, "--format", "json"], env);
  } catch (error) {
    if (error instanceof SessionExportError) throw error;
    throw new SessionExportError("SPAWN_FAILED", `could not run session export: ${(error as Error).message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
    throw new SessionExportError("EXPORT_FAILED", `session export failed for ${JSON.stringify(sessionId)}: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new SessionExportError("EXPORT_INVALID", `session export for ${JSON.stringify(sessionId)} is not valid JSON`);
  }
  const record = asRecord(parsed);
  if (!record) throw new SessionExportError("EXPORT_INVALID", `session export for ${JSON.stringify(sessionId)} is not an object`);
  return record as unknown as ExportedSession;
}

function defaultRun(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(bin, [...args], { encoding: "utf8", timeout: EXPORT_TIMEOUT_MS, env, maxBuffer: EXPORT_MAX_BUFFER });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOBUFS") {
    throw new SessionExportError(
      "EXPORT_TOO_LARGE",
      `session export exceeded ${EXPORT_MAX_BUFFER} bytes; treating usage as unknown`,
    );
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Root-only check: the native export must be a `user` session with a null
 * parent. Subagents (`sub_agent` + parent id) and every other type fail.
 * Unverifiable shapes fail closed (not a root).
 */
export function isRootSession(session: ExportedSession): boolean {
  return session.session_type === "user" && session.parent_session_id === null;
}

/**
 * Context estimate from the latest provider report (`usage`). Prefers
 * `total_tokens`; falls back to input+output. Cache breakdown fields are
 * subsets of input (source: Usage docs in
 * goose-provider-types/src/conversation/token_usage.rs) and are never added
 * on top. The cumulative `accumulated_usage` billing ledger is ignored.
 * Unknown when no safe positive count exists.
 */
export function estimateFromUsage(session: ExportedSession): number | undefined {
  const usage = asRecord(session.usage);
  if (!usage) return undefined;
  const total = safeCount(usage.total_tokens);
  if (total !== undefined && total > 0) return total;
  const input = safeCount(usage.input_tokens);
  const output = safeCount(usage.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const sum = input + output;
  if (!Number.isSafeInteger(sum) || sum <= 0) return undefined;
  return sum;
}

/** Source-bound model from the native export only; never from model input. */
export function modelFromExport(session: ExportedSession): string {
  const config = asRecord(session.model_config);
  const fromConfig = config?.model_name;
  if (typeof fromConfig === "string" && fromConfig.length > 0) return fromConfig;
  return "unknown";
}
