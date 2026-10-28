import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HANDOVER_TOOL = "context_handover" as const;
export const READ_TOOL = "read_handover" as const;

export const DATA_ENV_VAR = "AUTO_CONTEXT_HANDOVER_GOOSE_DATA";
const DATA_SUBDIR = "auto-context-handover-goose";

export interface HandoverDiagnostics {
  readonly reason: "unknown";
  readonly stage?: "warn1" | "warn2" | "final";
  readonly estimatedTokens?: number;
  readonly soft?: number;
}

export interface HandoverRecord {
  readonly sessionId: string;
  readonly model: string;
  readonly handover: string;
  readonly summary: string;
  readonly diagnostics: HandoverDiagnostics;
}

export class DuplicateHandoverError extends Error {
  readonly code = "DUPLICATE_HANDOVER";
  constructor(sessionId: string) {
    super(`goose store: handover already stored for session ${JSON.stringify(sessionId)}`);
    this.name = "DuplicateHandoverError";
  }
}

/**
 * Base directory for goose adapter storage. An absolute
 * AUTO_CONTEXT_HANDOVER_GOOSE_DATA wins when set; otherwise a fixed subdir
 * under XDG_DATA_HOME (or ~/.local/share). Never resolves inside the live
 * Goose data dir, so adapter storage cannot collide with session state.
 */
export function baseDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATA_ENV_VAR];
  if (override !== undefined) {
    if (override.length === 0 || !path.isAbsolute(override)) {
      throw new Error(`goose store: ${DATA_ENV_VAR} must be an absolute directory path`);
    }
    return override;
  }
  const xdg = env.XDG_DATA_HOME;
  if (typeof xdg === "string" && xdg.length > 0) return path.join(xdg, DATA_SUBDIR);
  const home = env.HOME;
  const root = typeof home === "string" && home.length > 0 ? home : os.homedir();
  return path.join(root, ".local", "share", DATA_SUBDIR);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function idToFile(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex") + ".json";
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  fs.chmodSync(dir, 0o700);
}

function removeQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {}
}

function assertHandoverRecord(value: unknown): asserts value is HandoverRecord {
  if (typeof value !== "object" || value === null) throw new Error("goose store: handover record must be an object");
  const record = value as Record<string, unknown>;
  for (const key of ["sessionId", "model", "handover", "summary"] as const) {
    const field = record[key];
    if (key === "handover" || key === "summary") {
      if (typeof field !== "string") throw new Error(`goose store: handover record ${key} must be a string`);
    } else if (!isNonEmptyString(field)) {
      throw new Error(`goose store: handover record ${key} must be a non-empty string`);
    }
  }
  const diag = record.diagnostics;
  if (typeof diag !== "object" || diag === null) throw new Error("goose store: handover record diagnostics must be an object");
  const diagnostics = diag as Record<string, unknown>;
  if (diagnostics.reason !== "unknown") {
    throw new Error('goose store: handover record diagnostics.reason must be "unknown"');
  }
  if (diagnostics.stage !== undefined && diagnostics.stage !== "warn1" && diagnostics.stage !== "warn2" && diagnostics.stage !== "final") {
    throw new Error("goose store: handover record diagnostics.stage must be warn1, warn2, or final");
  }
  if (diagnostics.estimatedTokens !== undefined && !isSafeNonNegativeInt(diagnostics.estimatedTokens)) {
    throw new Error("goose store: handover record diagnostics.estimatedTokens must be a safe non-negative integer");
  }
  if (diagnostics.soft !== undefined && (!isSafeNonNegativeInt(diagnostics.soft) || diagnostics.soft <= 0)) {
    throw new Error("goose store: handover record diagnostics.soft must be a positive safe integer");
  }
}

export class GooseStore {
  readonly baseDir: string;

  constructor(baseDir: string) {
    if (!isNonEmptyString(baseDir)) throw new Error("goose store: baseDir must be a non-empty string");
    this.baseDir = baseDir;
  }

  private handoversDir(): string {
    return path.join(this.baseDir, "handovers");
  }

  saveHandover(record: HandoverRecord): void {
    assertHandoverRecord(record);
    const dir = this.handoversDir();
    ensureDir(dir);
    const finalPath = path.join(dir, idToFile(record.sessionId));
    const data = JSON.stringify(record);
    const tmpPath = path.join(dir, `.tmp-${randomBytes(16).toString("hex")}.tmp`);
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    // Exclusive hard-link publish: readers never observe a partial file and a
    // second writer loses with EEXIST instead of overwriting.
    try {
      fs.linkSync(tmpPath, finalPath);
    } catch (error) {
      removeQuiet(tmpPath);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DuplicateHandoverError(record.sessionId);
      throw error;
    }
    removeQuiet(tmpPath);
  }

  getHandover(sessionId: string): HandoverRecord | undefined {
    if (!isNonEmptyString(sessionId)) throw new Error("goose store: sessionId must be a non-empty string");
    const finalPath = path.join(this.handoversDir(), idToFile(sessionId));
    let raw: string;
    try {
      raw = fs.readFileSync(finalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`goose store: handover record for ${JSON.stringify(sessionId)} is corrupt`);
    }
    try {
      assertHandoverRecord(parsed);
    } catch {
      throw new Error(`goose store: handover record for ${JSON.stringify(sessionId)} is corrupt`);
    }
    return parsed;
  }
}
