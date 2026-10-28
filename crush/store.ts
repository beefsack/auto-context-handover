import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HANDOVER_TOOL = "context_handover" as const;
export const READ_TOOL = "read_handover" as const;

export const DATA_ENV_VAR = "AUTO_CONTEXT_HANDOVER_DATA";

export type PendingTool = typeof HANDOVER_TOOL | typeof READ_TOOL;

export interface HandoverDiagnostics {
  readonly reason: "nudged" | "not-nudged" | "unknown";
  readonly stage?: "warn1" | "warn2" | "final";
  readonly estimatedTokens?: number;
  readonly soft?: number;
}

export interface HandoverRecord {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly model: string;
  readonly handover: string;
  readonly summary: string;
  readonly closed: true;
  readonly diagnostics: HandoverDiagnostics;
}

export interface CallerContext {
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly model?: string;
}

export interface PendingRequest {
  readonly tool: PendingTool;
  readonly caller: CallerContext;
  readonly args: unknown;
  readonly diagnostics: unknown;
}

export interface RolloverStatus {
  readonly successorId?: string;
  readonly admitted?: boolean;
  readonly error?: string;
}

export class DuplicateHandoverError extends Error {
  readonly code = "DUPLICATE_HANDOVER";
  constructor(sessionId: string) {
    super(`crush store: handover already stored for session ${JSON.stringify(sessionId)}`);
    this.name = "DuplicateHandoverError";
  }
}

export class PendingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`crush store: ${message}`);
    this.name = "PendingError";
    this.code = code;
  }
}

export function baseDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[DATA_ENV_VAR];
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`crush store: ${DATA_ENV_VAR} must be an absolute directory path`);
  }
  return value;
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

function assertCaller(value: unknown): asserts value is CallerContext {
  if (typeof value !== "object" || value === null) throw new PendingError("INVALID_CALLER", "caller must be an object");
  const caller = value as Record<string, unknown>;
  if (!isNonEmptyString(caller.sessionId)) throw new PendingError("INVALID_CALLER", "caller.sessionId must be a non-empty string");
  for (const key of ["workspaceId", "model"] as const) {
    if (caller[key] !== undefined && typeof caller[key] !== "string") {
      throw new PendingError("INVALID_CALLER", `caller.${key} must be a string`);
    }
  }
}

function assertHandoverRecord(value: unknown): asserts value is HandoverRecord {
  if (typeof value !== "object" || value === null) throw new Error("crush store: handover record must be an object");
  const record = value as Record<string, unknown>;
  for (const key of ["sessionId", "workspaceId", "model", "handover", "summary"] as const) {
    const field = record[key];
    if (key === "handover" || key === "summary") {
      if (typeof field !== "string") throw new Error(`crush store: handover record ${key} must be a string`);
    } else if (!isNonEmptyString(field)) {
      throw new Error(`crush store: handover record ${key} must be a non-empty string`);
    }
  }
  if (record.closed !== true) throw new Error("crush store: handover record closed must be true");
  const diag = record.diagnostics;
  if (typeof diag !== "object" || diag === null) throw new Error("crush store: handover record diagnostics must be an object");
  const diagnostics = diag as Record<string, unknown>;
  if (diagnostics.reason !== "nudged" && diagnostics.reason !== "not-nudged" && diagnostics.reason !== "unknown") {
    throw new Error('crush store: handover record diagnostics.reason must be "nudged", "not-nudged", or "unknown"');
  }
  if (diagnostics.stage !== undefined && diagnostics.stage !== "warn1" && diagnostics.stage !== "warn2" && diagnostics.stage !== "final") {
    throw new Error("crush store: handover record diagnostics.stage must be warn1, warn2, or final");
  }
  if (diagnostics.estimatedTokens !== undefined && !isFiniteNumber(diagnostics.estimatedTokens)) {
    throw new Error("crush store: handover record diagnostics.estimatedTokens must be a number");
  }
  if (diagnostics.soft !== undefined && (!isFiniteNumber(diagnostics.soft) || diagnostics.soft <= 0)) throw new Error("crush store: handover record diagnostics.soft must be a positive number");
}

function assertRolloverStatus(value: unknown): asserts value is RolloverStatus {
  if (typeof value !== "object" || value === null) throw new Error("crush store: rollover status must be an object");
  const status = value as Record<string, unknown>;
  for (const key of Object.keys(status)) {
    if (key !== "successorId" && key !== "admitted" && key !== "error") {
      throw new Error(`crush store: rollover status has unknown field ${JSON.stringify(key)}`);
    }
  }
  if (status.successorId !== undefined && !isNonEmptyString(status.successorId)) {
    throw new Error("crush store: rollover status successorId must be a non-empty string");
  }
  if (status.admitted !== undefined && typeof status.admitted !== "boolean") {
    throw new Error("crush store: rollover status admitted must be a boolean");
  }
  if (status.error !== undefined && typeof status.error !== "string") {
    throw new Error("crush store: rollover status error must be a string");
  }
}

function assertPendingRequest(value: unknown): asserts value is PendingRequest {
  if (typeof value !== "object" || value === null) throw new PendingError("PENDING_CORRUPT", "pending request must be an object");
  const request = value as Record<string, unknown>;
  if (request.tool !== HANDOVER_TOOL && request.tool !== READ_TOOL) {
    throw new PendingError("PENDING_CORRUPT", "pending request tool must be context_handover or read_handover");
  }
  assertCaller(request.caller);
  if (!("args" in request)) throw new PendingError("PENDING_CORRUPT", "pending request args is missing");
  if (!("diagnostics" in request)) throw new PendingError("PENDING_CORRUPT", "pending request diagnostics is missing");
}

export class CrushStore {
  readonly baseDir: string;

  constructor(baseDir: string) {
    if (!isNonEmptyString(baseDir)) throw new Error("crush store: baseDir must be a non-empty string");
    this.baseDir = baseDir;
  }

  private handoversDir(): string {
    return path.join(this.baseDir, "handovers");
  }

  private pendingDir(): string {
    return path.join(this.baseDir, "pending");
  }

  private statusDir(): string {
    return path.join(this.baseDir, "status");
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
    if (!isNonEmptyString(sessionId)) throw new Error("crush store: sessionId must be a non-empty string");
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
      throw new Error(`crush store: handover record for ${JSON.stringify(sessionId)} is corrupt`);
    }
    try {
      assertHandoverRecord(parsed);
    } catch {
      throw new Error(`crush store: handover record for ${JSON.stringify(sessionId)} is corrupt`);
    }
    return parsed;
  }

  /** Atomic status/metadata update for a source session. Never rewrites the verbatim handover. */
  updateStatus(sessionId: string, patch: RolloverStatus): RolloverStatus {
    if (!isNonEmptyString(sessionId)) throw new Error("crush store: sessionId must be a non-empty string");
    assertRolloverStatus(patch);
    const dir = this.statusDir();
    ensureDir(dir);
    const finalPath = path.join(dir, idToFile(sessionId));
    let current: RolloverStatus = {};
    try {
      const raw = fs.readFileSync(finalPath, "utf8");
      try {
        const parsed: unknown = JSON.parse(raw);
        assertRolloverStatus(parsed);
        current = parsed;
      } catch {
        throw new Error(`crush store: rollover status for ${JSON.stringify(sessionId)} is corrupt`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next: RolloverStatus = { ...current, ...patch };
    assertRolloverStatus(next);
    const tmpPath = path.join(dir, `.tmp-${randomBytes(16).toString("hex")}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(next), { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, finalPath);
    fs.chmodSync(finalPath, 0o600);
    return next;
  }

  getStatus(sessionId: string): RolloverStatus | undefined {
    if (!isNonEmptyString(sessionId)) throw new Error("crush store: sessionId must be a non-empty string");
    const finalPath = path.join(this.statusDir(), idToFile(sessionId));
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
      throw new Error(`crush store: rollover status for ${JSON.stringify(sessionId)} is corrupt`);
    }
    try {
      assertRolloverStatus(parsed);
    } catch {
      throw new Error(`crush store: rollover status for ${JSON.stringify(sessionId)} is corrupt`);
    }
    return parsed;
  }

  createPending(request: PendingRequest): string {
    assertPendingRequest(request);
    const dir = this.pendingDir();
    ensureDir(dir);
    const token = randomBytes(32).toString("hex");
    const finalPath = path.join(dir, `${token}.json`);
    const tmpPath = path.join(dir, `.tmp-${randomBytes(16).toString("hex")}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(request), { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, finalPath);
    fs.chmodSync(finalPath, 0o600);
    return token;
  }

  consumePending(token: string): PendingRequest {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
      throw new PendingError("INVALID_TOKEN", "pending token must be 64 lowercase hex characters");
    }
    const dir = this.pendingDir();
    const sourcePath = path.join(dir, `${token}.json`);
    const claimPath = path.join(dir, `${token}.claim-${randomBytes(16).toString("hex")}.json`);
    try {
      fs.renameSync(sourcePath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PendingError("PENDING_NOT_FOUND", "pending request not found or already consumed");
      }
      throw error;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(claimPath, "utf8");
    } catch (error) {
      removeQuiet(claimPath);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PendingError("PENDING_NOT_FOUND", "pending request not found or already consumed");
      }
      throw error;
    }
    removeQuiet(claimPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PendingError("PENDING_CORRUPT", "pending request is corrupt");
    }
    assertPendingRequest(parsed);
    return parsed;
  }
}
