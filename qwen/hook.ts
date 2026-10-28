import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { softStage } from "../source/shared/handover-text.ts";
import {
  CodexStore as QwenStore,
  HANDOVER_TOOL,
  READ_TOOL,
  type HandoverDiagnostics,
} from "../codex/store.ts";
import {
  buildNotice,
  CHILD_INTRO,
  lockedReply,
  readInvocation,
  ROOT_INTRO,
  shortReply,
  successorPrompt,
  TOOL_NAMES,
} from "./text.ts";

export { TOOL_NAMES, successorPrompt };

export const DEFAULT_SOFT = 150000;
export const SOFT_ENV_VAR = "AUTO_CONTEXT_HANDOVER_SOFT";
export const DATA_DIR_NAME = "auto-context-handover";
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Qwen adapter state lives under ~/.qwen/auto-context-handover (HOME-based). */
export function baseDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME;
  const root =
    typeof home === "string" && home.length > 0 ? home : os.homedir();
  if (typeof root !== "string" || root.length === 0) {
    throw new ConfigError("qwen hook: HOME is required");
  }
  return path.join(root, ".qwen", DATA_DIR_NAME);
}

/**
 * Integer-only soft limit, uncapped (the child window is unknown).
 * Returns undefined for explicitly invalid values: notices are disabled but
 * reader/writer identity binding keeps working with default diagnostics.
 */
export function resolveSoft(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[SOFT_ENV_VAR];
  if (raw === undefined) return DEFAULT_SOFT;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

type HookRecord = Record<string, unknown>;

function asRecord(value: unknown): HookRecord | undefined {
  return typeof value === "object" && value !== null ? (value as HookRecord) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
}

/** Opaque collision-safe child key: parent session id + agent id. */
export function childKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

/**
 * Derive the child transcript path from a hook input. The hook input's
 * transcript_path is always the ROOT transcript (<projectDir>/chats/<sessionId>.jsonl);
 * a child transcript lives at <projectDir>/subagents/<sessionId>/agent-<agentId>.jsonl
 * (getAgentJsonlPath sanitizes [^a-zA-Z0-9_-] to _, so only strict safe ids
 * are accepted). Returns undefined for roots, unsafe ids, or unexpected layouts;
 * the root transcript is never parsed as a child.
 */
export function childJsonlPath(input: HookRecord): string | undefined {
  const transcript = nonEmptyString(input.transcript_path);
  const sessionId = nonEmptyString(input.session_id);
  const agentId = nonEmptyString(input.agent_id);
  if (!transcript || !sessionId || !agentId) return undefined;
  if (!isSafeId(sessionId) || !isSafeId(agentId)) return undefined;
  if (path.basename(transcript) !== `${sessionId}.jsonl`) return undefined;
  const chatsDir = path.dirname(transcript);
  if (path.basename(chatsDir) !== "chats") return undefined;
  const projectDir = path.dirname(chatsDir);
  return path.join(projectDir, "subagents", sessionId, `agent-${agentId}.jsonl`);
}

function checkpointPath(baseDir: string, key: string): string {
  return path.join(
    baseDir,
    "checkpoints",
    `${createHash("sha256").update(key, "utf8").digest("hex")}.json`,
  );
}

function readCheckpointBytes(baseDir: string, key: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(checkpointPath(baseDir, key), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const value = (parsed as Record<string, unknown>).byteLength;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  } catch {}
  return undefined;
}

function writeCheckpointBytes(baseDir: string, key: string, byteLength: number): void {
  const file = checkpointPath(baseDir, key);
  try {
    fs.mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {}
  try {
    const tmp = path.join(
      path.dirname(file),
      `.tmp-${createHash("sha256").update(`${key}:${Date.now()}:${Math.random()}`, "utf8").digest("hex").slice(0, 16)}.tmp`,
    );
    fs.writeFileSync(tmp, JSON.stringify({ byteLength }), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    // Ordinary fail-open storage: a lost write keeps the old checkpoint, so
    // later measurement may reuse pre-compaction records. The read path still
    // suppresses on corrupt/unreadable content.
    process.stderr.write(`qwen hook: failed to write checkpoint: ${(error as Error).message}\n`);
  }
}

function estimateFromUsage(usage: unknown): number | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;
  // Per-response API usage only: prompt + candidates. Never session billing
  // totals and never cache/thought double-counts.
  const prompt = record.promptTokenCount;
  const candidates = record.candidatesTokenCount;
  if (typeof prompt !== "number" || typeof candidates !== "number") return undefined;
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(candidates)) return undefined;
  if (prompt < 0 || candidates < 0) return undefined;
  const sum = prompt + candidates;
  if (!Number.isSafeInteger(sum) || sum <= 0) return undefined;
  return sum;
}

/**
 * Measure the latest child usage from its transcript. Only records at or after
 * fromByte are scanned; fromByte undefined (corrupt/unreadable checkpoint)
 * suppresses measurement entirely. The latest assistant record carrying
 * agentRunId + agentRound with matching sessionId + agentId wins; invalid
 * usage on that record resolves to unknown with no fallback to older records.
 * Strict torn-write guards: the file must end in a trailing newline, any
 * nonempty malformed line after the checkpoint resolves to unknown, and any
 * usage-bearing record with mismatched identity resolves to unknown.
 */
export function measureChild(
  childFile: string,
  sessionId: string,
  agentId: string,
  fromByte: number | undefined,
): number | undefined {
  if (fromByte === undefined) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(childFile, "utf8");
  } catch {
    return undefined;
  }
  if (raw.length > 0 && !raw.endsWith("\n")) return undefined;
  const lines = raw.split("\n");
  let offset = 0;
  let latest: unknown;
  for (const line of lines) {
    const start = offset;
    offset += Buffer.byteLength(line, "utf8") + 1;
    if (start < fromByte) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    const entry = asRecord(record);
    if (!entry) return undefined;
    if (entry.usageMetadata !== undefined && entry.usageMetadata !== null) {
      if (entry.sessionId !== sessionId || entry.agentId !== agentId) return undefined;
    }
    if (entry.type !== "assistant") continue;
    if (entry.sessionId !== sessionId || entry.agentId !== agentId) continue;
    if (typeof entry.agentRunId !== "string" || typeof entry.agentRound !== "number") continue;
    latest = entry;
  }
  if (latest === undefined) return undefined;
  return estimateFromUsage((latest as HookRecord).usageMetadata);
}

function diagStageFor(estimate: number, soft: number): HandoverDiagnostics["stage"] {
  const stage = softStage(estimate, soft);
  if (stage === "ok") return undefined;
  return stage === "warn3" ? "final" : stage;
}

function diagnosticsFor(
  estimate: number | undefined,
  nudged: boolean,
  soft: number,
): HandoverDiagnostics {
  // soft 0 is the invalid-config sentinel: diagnostics carry no stage and no
  // estimate, and readback renders the whole header unknown.
  if (!(soft > 0)) return { reason: "not-nudged", soft: 0 };
  return {
    reason: nudged ? "nudged" : "not-nudged",
    ...(estimate === undefined ? {} : { stage: diagStageFor(estimate, soft), estimatedTokens: estimate }),
    soft,
  };
}

function closedRecord(store: QwenStore, key: string) {
  try {
    return store.getHandover(key);
  } catch {
    return undefined;
  }
}

function denyLocked(key: string, toolName: string): HookRecord {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `This subagent session is locked after a context handover and cannot do more work. ` +
        `Denied ${toolName}. Default: ${readInvocation(key, true)}, ` +
        `then ${successorPrompt(key)}`,
    },
  };
}

function isOwnTool(toolName: string): boolean {
  return toolName === TOOL_NAMES.handover || toolName === TOOL_NAMES.read;
}

function stagedNotice(
  store: QwenStore,
  input: HookRecord,
  soft: number,
): HookRecord {
  const sessionId = nonEmptyString(input.session_id);
  const agentId = nonEmptyString(input.agent_id);
  if (!sessionId || !agentId) return {};
  const key = childKey(sessionId, agentId);
  let closed = false;
  try {
    closed = store.getHandover(key) !== undefined;
  } catch {
    return {};
  }
  if (closed) return {};
  const childFile = childJsonlPath(input);
  if (!childFile) return {};
  const checkpoint = readCheckpointBytes(store.baseDir, key);
  if (checkpoint === undefined) return {};
  const estimate = measureChild(childFile, sessionId, agentId, checkpoint);
  if (estimate === undefined) return {};
  const stage = softStage(estimate, soft);
  if (stage === "ok") return {};
  try {
    store.setObservation(key, { soft, estimatedTokens: estimate, nudged: true });
  } catch {}
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: buildNotice(stage),
    },
  };
}

export function handleHook(
  input: unknown,
  store: QwenStore,
  env: NodeJS.ProcessEnv = process.env,
): HookRecord {
  const soft = resolveSoft(env);
  const diagSoft = soft ?? 0;
  const hook = asRecord(input);
  if (!hook) return {};
  const event = hook.hook_event_name;
  if (typeof event !== "string") return {};
  const sessionId = nonEmptyString(hook.session_id);
  const agentId = nonEmptyString(hook.agent_id);
  const key = sessionId && agentId ? childKey(sessionId, agentId) : undefined;

  switch (event) {
    case "SessionStart": {
      if (agentId) return {};
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ROOT_INTRO } };
    }
    case "SubagentStart": {
      if (!key || !agentId) return {};
      const closed = closedRecord(store, key);
      if (closed) {
        return {
          hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: lockedReply(closed) },
        };
      }
      try {
        store.resetObservation(key);
      } catch {}
      return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: CHILD_INTRO } };
    }
    case "PreCompact":
    case "PostCompact": {
      // Conservatively invalidate pre-compaction usage: checkpoint the child
      // file length and measure only later records. Native compaction itself
      // is untouched.
      if (key && sessionId && agentId) {
        try {
          store.resetObservation(key);
        } catch {}
        const childFile = childJsonlPath(hook);
        if (childFile) {
          try {
            writeCheckpointBytes(store.baseDir, key, fs.statSync(childFile).size);
          } catch {}
        }
      }
      return {};
    }
    case "PreToolUse": {
      const toolName = typeof hook.tool_name === "string" ? hook.tool_name : "";
      const ownTool = isOwnTool(toolName);
      if (!key) {
        // Roots bind own tools with a session-only caller; ordinary root
        // tools stay untouched. The server rechecks policy, so a minted root
        // handover can never store.
        if (!ownTool) return {};
      } else {
        const closed = closedRecord(store, key);
        if (closed) return denyLocked(key, toolName || "tool call");
        if (!ownTool) return {};
      }
      if (!sessionId) throw new ConfigError("qwen hook: PreToolUse input is missing session_id");
      let estimate: number | undefined;
      let nudged = false;
      if (key && sessionId && agentId) {
        const childFile = childJsonlPath(hook);
        if (childFile) {
          const checkpoint = readCheckpointBytes(store.baseDir, key);
          if (checkpoint !== undefined) {
            estimate = measureChild(childFile, sessionId, agentId, checkpoint);
          }
        }
        try {
          const observed = store.getObservation(key);
          if (observed?.nudged === true) nudged = true;
        } catch {}
        try {
          store.setObservation(key, {
            soft: diagSoft,
            ...(estimate === undefined ? {} : { estimatedTokens: estimate }),
            ...(nudged ? { nudged: true } : {}),
          });
        } catch {}
      }
      const diagnostics = diagnosticsFor(estimate, nudged, diagSoft);
      const pendingTool = toolName === TOOL_NAMES.read ? READ_TOOL : HANDOVER_TOOL;
      const caller = {
        sessionId,
        ...(key ? { childId: key } : {}),
      };
      const token = store.createPending({
        tool: pendingTool,
        caller,
        args: hook.tool_input === undefined ? null : hook.tool_input,
        diagnostics,
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { capability: token },
        },
      };
    }
    case "PostToolUse": {
      if (soft === undefined) return {};
      if (!key) return {};
      const toolName = typeof hook.tool_name === "string" ? hook.tool_name : "";
      if (isOwnTool(toolName)) return {};
      return stagedNotice(store, hook, soft);
    }
    case "SubagentStop": {
      // Bounded final-text correction only after a stored handover; never a
      // measurement denial.
      if (!key) return {};
      let record;
      try {
        record = store.getHandover(key);
      } catch {
        return {};
      }
      if (!record) return {};
      const expected = shortReply(record);
      const last =
        typeof hook.last_assistant_message === "string" ? hook.last_assistant_message : undefined;
      if (last !== expected && hook.stop_hook_active !== true) {
        return { decision: "block", reason: expected };
      }
      return {};
    }
    default: {
      return {};
    }
  }
}

function main(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (error) {
    process.stderr.write(`qwen hook: failed to read stdin: ${(error as Error).message}\n`);
    process.exit(2);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`qwen hook: stdin is not valid JSON: ${(error as Error).message}\n`);
    process.exit(2);
    return;
  }
  let store: QwenStore;
  try {
    store = new QwenStore(baseDirFromEnv(process.env));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
    return;
  }
  let output: HookRecord;
  try {
    output = handleHook(parsed, store, process.env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

const invokedAsMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsMain) main();
