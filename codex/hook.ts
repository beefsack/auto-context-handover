import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { softStage } from "../source/shared/handover-text.ts";
import {
  baseDirFromEnv,
  CodexStore,
  HANDOVER_TOOL,
  READ_TOOL,
  type HandoverDiagnostics,
} from "./store.ts";
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

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function resolveSoft(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SOFT_ENV_VAR];
  if (raw === undefined) return DEFAULT_SOFT;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  throw new ConfigError(
    `codex hook: ${SOFT_ENV_VAR} must be a positive integer of tokens, got ${JSON.stringify(raw)}`,
  );
}

type HookRecord = Record<string, unknown>;

function asRecord(value: unknown): HookRecord | undefined {
  return typeof value === "object" && value !== null ? (value as HookRecord) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function childIdOf(input: HookRecord): string | undefined {
  return nonEmptyString(input.agent_id);
}

function estimateFromUsage(usage: unknown): number | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;
  const inputTokens = record.input_tokens;
  const outputTokens = record.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return undefined;
  if (inputTokens < 0 || outputTokens < 0) return undefined;
  const sum = inputTokens + outputTokens;
  if (!Number.isSafeInteger(sum) || sum <= 0) return undefined;
  return sum;
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
  return {
    reason: nudged ? "nudged" : "not-nudged",
    ...(estimate === undefined ? {} : { stage: diagStageFor(estimate, soft), estimatedTokens: estimate }),
    soft,
  };
}

function closedRecord(store: CodexStore, childId: string) {
  try {
    return store.getHandover(childId);
  } catch {
    return undefined;
  }
}

function denyLocked(childId: string, toolName: string): HookRecord {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `This subagent session is locked after a context handover and cannot do more work. ` +
        `Denied ${toolName}. Default: ${readInvocation(childId, true)}, ` +
        `then ${successorPrompt(childId)}`,
    },
  };
}

function isOwnTool(toolName: string): boolean {
  return toolName === TOOL_NAMES.handover || toolName === TOOL_NAMES.read;
}

export function handleHook(
  input: unknown,
  store: CodexStore,
  env: NodeJS.ProcessEnv = process.env,
): HookRecord {
  const soft = resolveSoft(env);
  const hook = asRecord(input);
  if (!hook) return {};
  const event = hook.hook_event_name;
  if (typeof event !== "string") return {};
  const childId = childIdOf(hook);

  switch (event) {
    case "SessionStart": {
      if (childId) return {};
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ROOT_INTRO } };
    }
    case "SubagentStart": {
      if (!childId) return {};
      const closed = closedRecord(store, childId);
      if (closed) {
        return {
          hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: lockedReply(closed) },
        };
      }
      try {
        store.resetObservation(childId);
      } catch {}
      return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: CHILD_INTRO } };
    }
    case "PreCompact":
    case "PostCompact": {
      if (childId) {
        try {
          store.resetObservation(childId);
        } catch {}
      }
      return {};
    }
    case "PostModelRequest": {
      // Sync observer: PostModelRequest only; see rust-v0.165.0 hooks/src/events/model_request.rs and core/src/session/turn.rs:2704.
      if (!childId) return {};
      let priorNudged = false;
      try {
        priorNudged = store.getObservation(childId)?.nudged === true;
      } catch {
        priorNudged = false;
      }
      const completed =
        typeof hook.status === "string" && hook.status.toLowerCase() === "completed";
      const estimate = completed ? estimateFromUsage(hook.token_usage) : undefined;
      try {
        store.setObservation(childId, {
          soft,
          ...(estimate === undefined ? {} : { estimatedTokens: estimate }),
          ...(priorNudged ? { nudged: true } : {}),
        });
      } catch {}
      return {};
    }
    case "PreToolUse": {
      const toolName = typeof hook.tool_name === "string" ? hook.tool_name : "";
      const ownTool = isOwnTool(toolName);
      if (!childId) {
        // Roots bind own tools with a session-only caller (no observations,
        // no closed state); ordinary root tools stay untouched. The server
        // rechecks policy, so a minted root handover can never store.
        if (!ownTool) return {};
      } else {
        // Closed-state binding reads swallow storage errors and treat the
        // child as open; the server re-verifies strictly before any mutation,
        // so a corrupt store yields an error, never a write.
        const closed = closedRecord(store, childId);
        if (closed) return denyLocked(childId, toolName || "tool call");
        if (!ownTool) return {};
      }
      const sessionId = nonEmptyString(hook.session_id);
      if (!sessionId) throw new ConfigError("codex hook: PreToolUse input is missing session_id");
      let estimate: number | undefined;
      let nudged = false;
      if (childId) {
        try {
          const observed = store.getObservation(childId);
          estimate = observed?.estimatedTokens;
          nudged = observed?.nudged === true;
        } catch {}
      }
      const diagnostics = diagnosticsFor(estimate, nudged, soft);
      const pendingTool = toolName === TOOL_NAMES.read ? READ_TOOL : HANDOVER_TOOL;
      const caller = {
        sessionId,
        ...(childId ? { childId } : {}),
        ...(nonEmptyString(hook.agent_type) ? { agentType: hook.agent_type as string } : {}),
        ...(nonEmptyString(hook.model) ? { model: hook.model as string } : {}),
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
      if (!childId) return {};
      const toolName = typeof hook.tool_name === "string" ? hook.tool_name : "";
      if (isOwnTool(toolName)) return {};
      let closed = false;
      try {
        closed = store.getHandover(childId) !== undefined;
      } catch {
        return {};
      }
      if (closed) return {};
      let estimate: number | undefined;
      try {
        estimate = store.getObservation(childId)?.estimatedTokens;
      } catch {
        return {};
      }
      if (estimate === undefined) return {};
      const stage = softStage(estimate, soft);
      if (stage === "ok") return {};
      try {
        store.setObservation(childId, { soft, estimatedTokens: estimate, nudged: true });
      } catch {}
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: buildNotice(stage),
        },
      };
    }
    case "SubagentStop": {
      if (!childId) return {};
      let record;
      try {
        record = store.getHandover(childId);
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
    process.stderr.write(`codex hook: failed to read stdin: ${(error as Error).message}\n`);
    process.exit(2);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`codex hook: stdin is not valid JSON: ${(error as Error).message}\n`);
    process.exit(2);
    return;
  }
  let store: CodexStore;
  try {
    store = new CodexStore(baseDirFromEnv(process.env));
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
