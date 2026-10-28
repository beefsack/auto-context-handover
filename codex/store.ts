import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HANDOVER_TOOL = "context_handover" as const;
export const READ_TOOL = "read_handover" as const;

export type PendingTool = typeof HANDOVER_TOOL | typeof READ_TOOL;

export interface HandoverDiagnostics {
  readonly reason: "nudged" | "not-nudged";
  readonly stage?: "warn1" | "warn2" | "final";
  readonly estimatedTokens?: number;
  readonly soft: number;
}

export interface HandoverRecord {
  readonly childId: string;
  readonly parentSessionId: string;
  readonly agentType: string;
  readonly model: string;
  readonly handover: string;
  readonly summary: string;
  readonly closed: true;
  readonly diagnostics: HandoverDiagnostics;
}

export interface CallerContext {
  readonly sessionId: string;
  readonly childId?: string;
  readonly agentType?: string;
  readonly model?: string;
}

export interface PendingRequest {
  readonly tool: PendingTool;
  readonly caller: CallerContext;
  readonly args: unknown;
  readonly diagnostics: unknown;
}

export interface Observation {
  readonly estimatedTokens?: number;
  readonly soft: number;
  readonly nudged?: boolean;
}

export class DuplicateHandoverError extends Error {
  readonly code = "DUPLICATE_HANDOVER";
  constructor(childId: string) {
    super(`codex store: handover already stored for child ${JSON.stringify(childId)}`);
    this.name = "DuplicateHandoverError";
  }
}

export class PendingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`codex store: ${message}`);
    this.name = "PendingError";
    this.code = code;
  }
}

export function baseDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.PLUGIN_DATA;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("codex store: PLUGIN_DATA is required");
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
  for (const key of ["childId", "agentType", "model"] as const) {
    if (caller[key] !== undefined && typeof caller[key] !== "string") {
      throw new PendingError("INVALID_CALLER", `caller.${key} must be a string`);
    }
  }
}

function assertHandoverRecord(value: unknown): asserts value is HandoverRecord {
  if (typeof value !== "object" || value === null) throw new Error("codex store: handover record must be an object");
  const record = value as Record<string, unknown>;
  for (const key of ["childId", "parentSessionId", "agentType", "model", "handover", "summary"] as const) {
    const field = record[key];
    if (key === "handover" || key === "summary") {
      if (typeof field !== "string") throw new Error(`codex store: handover record ${key} must be a string`);
    } else if (!isNonEmptyString(field)) {
      throw new Error(`codex store: handover record ${key} must be a non-empty string`);
    }
  }
  if (record.closed !== true) throw new Error("codex store: handover record closed must be true");
  const diag = record.diagnostics;
  if (typeof diag !== "object" || diag === null) throw new Error("codex store: handover record diagnostics must be an object");
  const diagnostics = diag as Record<string, unknown>;
  if (diagnostics.reason !== "nudged" && diagnostics.reason !== "not-nudged") {
    throw new Error('codex store: handover record diagnostics.reason must be "nudged" or "not-nudged"');
  }
  if (diagnostics.stage !== undefined && diagnostics.stage !== "warn1" && diagnostics.stage !== "warn2" && diagnostics.stage !== "final") {
    throw new Error("codex store: handover record diagnostics.stage must be warn1, warn2, or final");
  }
  if (diagnostics.estimatedTokens !== undefined && !isFiniteNumber(diagnostics.estimatedTokens)) {
    throw new Error("codex store: handover record diagnostics.estimatedTokens must be a number");
  }
  if (!isFiniteNumber(diagnostics.soft)) throw new Error("codex store: handover record diagnostics.soft must be a number");
}

function assertObservation(value: unknown): asserts value is Observation {
  if (typeof value !== "object" || value === null) throw new Error("codex store: observation must be an object");
  const observation = value as Record<string, unknown>;
  if (!isFiniteNumber(observation.soft)) throw new Error("codex store: observation soft must be a number");
  if (observation.estimatedTokens !== undefined && !isFiniteNumber(observation.estimatedTokens)) {
    throw new Error("codex store: observation estimatedTokens must be a number");
  }
  if (observation.nudged !== undefined && typeof observation.nudged !== "boolean") {
    throw new Error("codex store: observation nudged must be a boolean");
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

export class CodexStore {
  readonly baseDir: string;

  constructor(baseDir: string) {
    if (!isNonEmptyString(baseDir)) throw new Error("codex store: baseDir must be a non-empty string");
    this.baseDir = baseDir;
  }

  private handoversDir(): string {
    return path.join(this.baseDir, "handovers");
  }

  private observationsDir(): string {
    return path.join(this.baseDir, "observations");
  }

  private pendingDir(): string {
    return path.join(this.baseDir, "pending");
  }

  saveHandover(record: HandoverRecord): void {
    assertHandoverRecord(record);
    const dir = this.handoversDir();
    ensureDir(dir);
    const finalPath = path.join(dir, idToFile(record.childId));
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
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DuplicateHandoverError(record.childId);
      throw error;
    }
    removeQuiet(tmpPath);
  }

  getHandover(childId: string): HandoverRecord | undefined {
    if (!isNonEmptyString(childId)) throw new Error("codex store: childId must be a non-empty string");
    const finalPath = path.join(this.handoversDir(), idToFile(childId));
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
      throw new Error(`codex store: handover record for ${JSON.stringify(childId)} is corrupt`);
    }
    try {
      assertHandoverRecord(parsed);
    } catch {
      throw new Error(`codex store: handover record for ${JSON.stringify(childId)} is corrupt`);
    }
    return parsed;
  }

  setObservation(childId: string, observation: Observation): void {
    if (!isNonEmptyString(childId)) throw new Error("codex store: childId must be a non-empty string");
    assertObservation(observation);
    const dir = this.observationsDir();
    ensureDir(dir);
    const finalPath = path.join(dir, idToFile(childId));
    const tmpPath = path.join(dir, `.tmp-${randomBytes(16).toString("hex")}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(observation), { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, finalPath);
    fs.chmodSync(finalPath, 0o600);
  }

  getObservation(childId: string): Observation | undefined {
    if (!isNonEmptyString(childId)) throw new Error("codex store: childId must be a non-empty string");
    const finalPath = path.join(this.observationsDir(), idToFile(childId));
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
      throw new Error(`codex store: observation for ${JSON.stringify(childId)} is corrupt`);
    }
    try {
      assertObservation(parsed);
    } catch {
      throw new Error(`codex store: observation for ${JSON.stringify(childId)} is corrupt`);
    }
    return parsed;
  }

  resetObservation(childId: string): void {
    if (!isNonEmptyString(childId)) throw new Error("codex store: childId must be a non-empty string");
    try {
      fs.unlinkSync(path.join(this.observationsDir(), idToFile(childId)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
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
