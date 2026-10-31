// Copilot CLI adapter core: subagent-first MVP, no build step (Node >= 22.18).
// Self-contained on purpose: the installed extension directory cannot rely on
// ../source resolving, so shared wording/logic is embedded here and
// drift-checked by logic.test.ts against ../source/shared/*.
//
// Scope (contract-backed, see the @github/copilot-sdk ^1 devDependency
// types, assessed against 1.0.28, byte-identical to the bundled CLI 1.0.105 SDK contracts):
// - Identity: ToolInvocation.agentId (present = attributed child call).
//   Absent agentId can mean a root call OR a child call the runtime did not
//   attribute, so unattributed handover calls are refused without claiming
//   which case applies. Hook input.sessionId scopes differ per surface (child
//   scope for tool hooks, parent scope for subagent lifecycle hooks matching
//   invocation.sessionId), so session ids are never correlated across
//   surfaces: agentId is the only cross-surface key.
// - Host agentType is captured only from same-agent pre/post tool hooks
//   (onSubagentStart metadata is parent-scoped); otherwise "unknown".
// - Measurement: session.usage_info gives host-measured currentTokens plus
//   tokenLimit (ephemeral, never persisted). assistant.usage is per-call only
//   (input/output tokens, never a context total) and is NOT summed into an
//   estimate: no fake current-context estimate when fields are unknown.
// - Roots are advisory-free: intro only, no staged notices, no handover
//   storage. No programmatic root rollover exists from an extension (no
//   session create/resume surface), so none is claimed. Children get the full
//   loop: intro, staged tool-boundary notices, handover/read tools, and a
//   SubagentStop rewrite to the continuation receipt (never repeated blocks).
// - Built-in general-purpose subagents emit neither subagent start nor stop,
//   so this MVP covers task-tool/custom subagents only.
// - This extension runs as a separate Node.js JSON-RPC subprocess (see the
//   SDK docs/extensions.md); tool handlers run in this process and the host
//   invocation carries the caller: sessionId (parent scope) plus agentId.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @typedef {import("@github/copilot-sdk").SessionHooks} SessionHooks
 * @typedef {import("@github/copilot-sdk").ToolInvocation} ToolInvocation
 * @typedef {import("@github/copilot-sdk").SessionEvent} SessionEvent
 * @typedef {import("@github/copilot-sdk").Tool} Tool
 */
/**
 * Hook input/output types via the exported SessionHooks handler map (the
 * pre/post tool hook input types are not re-exported from the package root).
 * @typedef {NonNullable<SessionHooks["onPreToolUse"]>} PreToolUseHandler
 * @typedef {Parameters<PreToolUseHandler>[0]} PreToolUseHookInput
 * @typedef {NonNullable<Awaited<ReturnType<PreToolUseHandler>>>} PreToolUseHookOutput
 * @typedef {NonNullable<SessionHooks["onPostToolUse"]>} PostToolUseHandler
 * @typedef {Parameters<PostToolUseHandler>[0]} PostToolUseHookInput
 * @typedef {NonNullable<Awaited<ReturnType<PostToolUseHandler>>>} PostToolUseHookOutput
 * @typedef {NonNullable<SessionHooks["onSubagentStart"]>} SubagentStartHandler
 * @typedef {Parameters<SubagentStartHandler>[0]} SubagentStartHookInput
 * @typedef {NonNullable<SessionHooks["onSubagentStop"]>} SubagentStopHandler
 * @typedef {Parameters<SubagentStopHandler>[0]} SubagentStopHookInput
 */

/**
 * @typedef {object} HandoverDiagnostics
 * @property {"nudged" | "not-nudged" | "unknown"} reason
 * @property {"warn1" | "warn2" | "final"} [stage]
 * @property {number} [estimatedTokens]
 * @property {number} [soft]
 */

/**
 * @typedef {object} HandoverRecord
 * @property {string} childId
 * @property {string} parentSessionId
 * @property {string} agentType
 * @property {string} handover
 * @property {string} summary
 * @property {true} closed
 * @property {HandoverDiagnostics} diagnostics
 */

/**
 * Ephemeral per-child measurement snapshot. Never persisted: it lives in
 * ChildMemory for the extension process lifetime only.
 * @typedef {object} Observation
 * @property {number} [estimatedTokens]
 * @property {number} [tokenLimit]
 * @property {number} [soft]
 * @property {boolean} [nudged]
 */

/**
 * @typedef {object} DiagnosticView
 * @property {unknown} [reason]
 * @property {unknown} [stage]
 * @property {unknown} [estimate]
 * @property {unknown} [soft]
 */

export const TOOL_NAMES = {
  handover: "context_handover",
  read: "read_handover",
};

export const SOFT_ENV_VAR = "AUTO_CONTEXT_HANDOVER_SOFT";
export const DATA_ENV_VAR = "AUTO_CONTEXT_HANDOVER_DATA";
export const DATA_DIR_NAME = "auto-context-handover";
export const DEFAULT_SOFT = 200000;

export const CHILD_SUMMARY_PREFIX = "Context handover (incomplete):";

// Event types consumed by the unfiltered session dispatcher: extension.mjs
// registers a single session.on handler and handleSessionEvent filters there,
// not host-side. Asserted by the wiring test.
/** @type {readonly string[]} */
export const SESSION_SUBSCRIPTIONS = [
  "session.usage_info",
  "subagent.completed",
  "subagent.failed",
  "session.context_cleared",
  "session.compaction_start",
  "session.compaction_complete",
];

// Shared six-section handover instruction text. Must stay byte-identical to
// HANDOVER_SECTIONS in ../source/shared/handover-text.ts apart from the
// provenance paragraph, which is adapter-specific (drift-checked in tests).
const SHARED_PROVENANCE_PARAGRAPH =
  "Do not describe your own agent type, model (including override), or chain; the plugin records authoritative provenance and the parent uses the plugin record even if this handover says otherwise.";
const COPILOT_PROVENANCE_PARAGRAPH =
  "The plugin-recorded child id, parent session id and agent type are the authoritative provenance; " +
  "unknown values are unknown, and no model override or chain is recorded. " +
  "Do not restate your own agent or model identity; write the handover from the task content.";

export const HANDOVER_SECTIONS =
  `Write the handover with these sections:
1. Original instructions, role, and constraints (verbatim where it matters): role; active user scope and critical rules/prohibitions verbatim, or verified reload instructions (file/skill); permissions/tool restrictions, config scope, delegation/question/commit limits.
2. Completed work and decisions: changed files; explicit user decisions vs implicitly accepted proposals vs agent-adopted choices; separate direct verification (command/result) from others' reports (source), live observations, and unverified work.
3. In-progress work and exact current state: exact stopping point, unresolved risks, continuation/compaction status; flag history gaps.
4. Key snippets (short, copyable): only essential snippets.
5. Negative knowledge: explicit dead ends, failed approaches, what NOT to try again.
6. Prioritized next steps for the successor session: steps the successor can execute directly; reaching the context limit is not a roadblock and never a reason to ask the user; escalate only a user-owned decision that is independent of the context limit. Keep open questions explicitly; do not drop them.

State instruction deviations, triggered stop conditions, failed or erroring calls, and unverified claims plainly; never mark work PASS or complete while a deviation or triggered stop is unresolved; the summary must not claim more than the body.

${COPILOT_PROVENANCE_PARAGRAPH}

Prefer durable docs over repeated background; omit personal trivia; never trim unresolved risks or verification distinctions; mark unknowns rather than inventing history/controls. Keep concise and avoid repetitive prose.`;

// Shared stage leads. Must stay byte-identical to openCodeStageText() output
// for the same stage (drift-checked in tests).
const WARN1 =
  `Auto-context-handover notice. Context is filling. ` +
  `Finish the current unit of work, then call the context_handover tool with the full handover text. ` +
  `Do not start new work after this unit.`;
const WARN2 =
  `Auto-context-handover warning. Wrap up now: complete only the step in progress, ` +
  `then call the context_handover tool with the full handover text. Starting new work risks losing state to compaction.`;
const WARN3 =
  `Auto-context-handover final warning. Stop after this step and call the context_handover tool ` +
  `with the full handover text. Do not defer the handover past this response.`;

/**
 * @param {string} stage
 */
export function stageLead(stage) {
  if (stage === "warn1") return WARN1;
  if (stage === "warn2") return WARN2;
  return WARN3;
}

// Shared child rollover guidance, byte-identical to CHILD_ROLLOVER_GUIDANCE
// (drift-checked in tests).
const CHILD_ROLLOVER_GUIDANCE =
  `This is a rollover, not completion; the parent normally continues in a successor (not guaranteed). ` +
  `The handover replaces any required final report for this session. ` +
  `Before storage, read-only task instructions still allow calling the handover tool because it writes only plugin storage. ` +
  `The short summary must start with ${JSON.stringify(CHILD_SUMMARY_PREFIX)}. ` +
  `Put remaining work in prioritized executable next steps; never turn context size or remaining volume into user questions.`;

export const ROOT_INTRO =
  `Auto-context-handover is installed as a plugin workflow for subagent context handovers; root native compaction is unchanged. ` +
  `Context advisories are child-scoped: they appear inside subagent turns at tool boundaries, ` +
  `never in this root session. ` +
  `When a subagent returns a ${JSON.stringify(CHILD_SUMMARY_PREFIX)} reply, read the handover via the read_handover tool with the predecessor child id ` +
  `before replying to the user or making any decision about the task; a stored handover counts as the child's reply. ` +
  `The parent default is to continue handed-over work in a successor of the same agent type with the same requested model override taken from the original spawn parameters ` +
  `(the plugin never records a model, so never claim a captured model), which continues and replaces ` +
  `the predecessor as the same logical subagent, not an additional subagent under subagent-count limits, ` +
  `seeded by instructing it to call read_handover with the predecessor child id and continue from 'Prioritized next steps'; ` +
  `the seed is reference only, never paste handover text into a spawn prompt. Never resume a handed-over child session. ` +
  `The handover replaces any required final report for that child session. ` +
  `The parent may redirect, and checking in with the user is allowed if progress stalls or remaining work grows. ` +
  `The reader adds a conditional advisory when the stored handover alone exceeds 50% of the known soft limit, ` +
  `asking the successor to compress carried-over finished notes at its next handover.`;

export const CHILD_INTRO =
  `Auto-context-handover is installed as a plugin workflow. ` +
  `Call context_handover only after a context notice or an explicit user handover request. ` +
  `The current unit of work is the current step, not the whole task. ` +
  `The handover replaces any required final report for this session and takes precedence over task final-report instructions. ` +
  `Handover storage writes plugin storage only, so read-only task instructions still allow the call. ` +
  `The tool description carries the six-section template:\n${HANDOVER_SECTIONS}\n` +
  `After the call, end your turn with exactly the receipt text it returns as your final native message and then stop.`;

export const HANDOVER_DESCRIPTION =
  `Call this tool only after the plugin nudges you about the context limit, or when the user explicitly asks for a handover. ` +
  `Do not call it just to finish a task; give a normal final response instead. ` +
  `Only host-attributed subagent calls are accepted: an unattributed call (absent agentId, which can mean a root call or a child call the runtime did not attribute) is refused and stores nothing. ` +
  `Once nudged (or the user asks), call exactly once per unit of work when done, then stop. ` +
  `Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never summarized or reworded) ` +
  `plus a short status/outcome/next-step summary in "summary".\n\n` +
  `${HANDOVER_SECTIONS}\n\n` +
  `What happens next depends on this session's policy, not on this call: the stored text is read back by the parent, ` +
  `which normally continues in a same-agent-type successor. Do not paste secrets.`;

export const READ_DESCRIPTION =
  `Read a stored subagent handover by child id. ` +
  `Takes the predecessor child id and returns the verbatim stored text plus a diagnostics header and the recorded host provenance header ` +
  `(child id, parent session id, observed agent type, model override always recorded unknown: use the original spawn params), ` +
  `or a plain notice when nothing is stored for that id. The recorded provenance is authoritative over conflicting handover prose. ` +
  `Any live caller with tool access may read any stored child handover.`;

export class ConfigError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Mirror of shared parseThreshold: a "70%" string or a positive integer.
 * @param {unknown} value
 */
export function parseThreshold(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigError(`threshold must be a "70%" string or a positive absolute integer of tokens, got ${String(value)}`);
    }
    return { kind: "tokens", tokens: value };
  }
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
    if (!match) {
      throw new ConfigError(`threshold must be a "70%" string or a positive absolute integer of tokens, got ${JSON.stringify(value)}`);
    }
    const ratio = Number(match[1]) / 100;
    if (!(ratio > 0) || ratio > 1) {
      throw new ConfigError(`threshold percent must be within (0%, 100%], got ${JSON.stringify(value)}`);
    }
    return { kind: "percent", ratio };
  }
  throw new ConfigError(`threshold must be a "70%" string or a positive absolute integer of tokens, got ${String(value)}`);
}

/**
 * Mirror of shared resolveSoftTokens: integer soft caps at 70% of a known
 * window; explicit percentages apply uncapped; an unknown window leaves
 * integers uncapped and percentages unresolved (fail open -> undefined).
 * @param {{ kind: string, tokens?: number, ratio?: number }} spec
 * @param {number} [windowTokens]
 */
export function resolveSoftTokens(spec, windowTokens) {
  if (spec.kind === "percent") {
    if (windowTokens === undefined) return undefined;
    return Math.floor(/** @type {number} */ (spec.ratio) * windowTokens);
  }
  if (windowTokens === undefined) return /** @type {number} */ (spec.tokens);
  return Math.min(/** @type {number} */ (spec.tokens), Math.floor(0.7 * windowTokens));
}

/** Mirror of shared softStage: warn at soft, then soft*1.1, soft*1.2. */
/**
 * @param {number} estimate
 * @param {number} soft
 */
export function softStage(estimate, soft) {
  if (estimate >= soft * 1.2) return "warn3";
  if (estimate >= soft * 1.1) return "warn2";
  if (estimate >= soft) return "warn1";
  return "ok";
}

/** Mirror of shared seedTooLarge: seeds over 50% of soft are too large. */
/**
 * @param {number} seedEstimate
 * @param {number} softTokens
 */
export function seedTooLarge(seedEstimate, softTokens) {
  return seedEstimate > softTokens * 0.5;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function readSoftRaw(env) {
  const raw = env?.[SOFT_ENV_VAR];
  if (raw === undefined) return DEFAULT_SOFT;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return raw;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveSoftSpec(env) {
  return parseThreshold(readSoftRaw(env));
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [windowTokens]
 */
export function resolveSoftForWindow(env, windowTokens) {
  return resolveSoftTokens(resolveSoftSpec(env), windowTokens);
}

/** Mirror of shared withChildSummaryPrefix. */
/** @param {unknown} summary */
export function withChildSummaryPrefix(summary) {
  const clean = String(summary ?? "").trim();
  if (clean.startsWith(CHILD_SUMMARY_PREFIX)) return clean;
  return `${CHILD_SUMMARY_PREFIX} ${clean || "handover stored."}`;
}

/** Mirror of shared formatDiagLine (diagnostics header for readbacks).
 * @param {DiagnosticView} [diag]
 */
export function formatDiagLine(/** @type {DiagnosticView} [diag] */ diag) {
  const text = (/** @type {unknown} */ value) => (typeof value === "string" && value.length > 0 ? value : "unknown");
  const num = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(Math.floor(value)) : "unknown");
  return `Diagnostics: reason=${text(diag?.reason)}, stage=${text(diag?.stage)}, estimated-context-tokens=${num(diag?.estimate)}, soft-limit=${num(diag?.soft)}`;
}

/** Mirror of shared formatAgentTypeReadback/formatModelOverrideReadback
 * behavior (drift-checked in tests): known values render as
 * `(recorded: value)`; anything else renders the unknown variant pointing
 * back at the spawn params. Copilot records never capture a model override,
 * so that field is always the unknown variant: no lineage is invented.
 * @param {Pick<HandoverRecord, "childId" | "parentSessionId" | "agentType">} record
 */
export function formatProvenanceLine(record) {
  const agentType =
    isNonEmptyString(record.agentType) && record.agentType !== "unknown"
      ? `(recorded: ${record.agentType})`
      : `(recorded: unknown, use predecessor spawn params)`;
  const modelOverride = `(recorded: unknown, use predecessor spawn params)`;
  return (
    `Provenance: childId=${JSON.stringify(record.childId)}, ` +
    `parentSessionId=${JSON.stringify(record.parentSessionId)}, ` +
    `agentType=${agentType}, modelOverride=${modelOverride}. ` +
    `The recorded values are authoritative; conflicting handover prose does not override them.`
  );
}

/** @param {string} childId */
export function readInvocation(childId) {
  return `${TOOL_NAMES.read}({"childId":${JSON.stringify(childId)}})`;
}

/**
 * @param {string} childId
 */
/** @param {string} childId */
export function successorPrompt(childId) {
  return (
    `Call ${readInvocation(childId)} and continue from 'Prioritized next steps'; ` +
    `do not paste the handover into the spawn prompt.`
  );
}

/**
 * @param {HandoverRecord} record
 */
export function shortReply(record) {
  return (
    `${withChildSummaryPrefix(record.summary)}\n\nTask is NOT complete; this is a context rollover. ` +
    `Read the stored handover via ${readInvocation(record.childId)} before replying to the user or making any decision about the task. ` +
    `Default: ${readInvocation(record.childId)}, ` +
    `then spawn a successor of the same agent type with the same requested model override taken from the original spawn parameters, ` +
    `(the plugin never records a model, so never claim a captured model), ` +
    `which continues and replaces the predecessor as the same logical subagent, not an additional subagent under subagent-count limits, ` +
    `with a prompt instructing it to ${readInvocation(record.childId)} and continue from 'Prioritized next steps'; do not paste the handover into the spawn prompt. ` +
    `The reader adds a conditional advisory when the stored handover alone exceeds 50% of the known soft limit, ` +
    `asking the successor to compress carried-over finished notes at its next handover. ` +
    `The original task is reference only; completed steps are done and must not be repeated. ` +
    `Predecessor facts are trusted unless marked unverified; preserve verification distinctions and do not recast predecessor direct evidence as successor direct verification. ` +
    `Targeted rereads of already-covered material are allowed only to resolve open questions; never repeat completed steps. ` +
    `Continue from 'Prioritized next steps'. ` +
    `The parent may redirect; ask the user only about handover-listed user-owned decisions unrelated to context size, except checking in with the user is allowed if progress stalls or remaining work grows.`
  );
}

/**
 * @param {HandoverRecord} record
 */
export function lockedReply(record) {
  return (
    `${CHILD_SUMMARY_PREFIX} This subagent session is locked after a context handover and cannot answer questions or do more work. ` +
    `Default: ${readInvocation(record.childId)}, ` +
    `spawn a successor of the same agent type with the same requested model override taken from the original spawn parameters ` +
    `(or a fresh subagent to investigate and continue), ` +
    `seeded with the original task pointer and an instruction to ${readInvocation(record.childId)} and continue from 'Prioritized next steps'; ` +
    `the seed is reference only, never paste the handover into the spawn prompt. ` +
    `The original task is reference only; completed steps are done and must not be repeated. ` +
    `Predecessor facts are trusted unless marked unverified; preserve verification distinctions and do not recast predecessor direct evidence as successor direct verification. ` +
    `Targeted rereads of already-covered material are allowed only to resolve open questions; never repeat completed steps. ` +
    `Continue from 'Prioritized next steps'. ` +
    `The parent may redirect; ask the user only about handover-listed user-owned decisions unrelated to context size.`
  );
}

/**
 * @param {string} stage
 */
export function buildNotice(stage) {
  return (
    `As installed at session start: ${stageLead(stage)} ${CHILD_ROLLOVER_GUIDANCE} ` +
    `Call ${TOOL_NAMES.handover} with the full handover text for the current step; ` +
    `the parent reads the handover back intact and continues from 'Prioritized next steps'.`
  );
}

// --- Store: private per-plugin files, 0700 dirs / 0600 files, immutable
// first-writer handovers only. Observations are NOT persisted here; they live
// in ChildMemory for the extension process lifetime (see below).

export class DuplicateHandoverError extends Error {
  /**
   * @param {string} childId
   */
  constructor(childId) {
    super(`copilot store: handover already stored for child ${JSON.stringify(childId)}`);
    this.name = "DuplicateHandoverError";
    this.code = "DUPLICATE_HANDOVER";
  }
}

/**
 * Private store directory: an explicit AUTO_CONTEXT_HANDOVER_DATA override
 * when set (must be absolute), otherwise a dedicated plugin subdirectory of
 * the Copilot data directory (COPILOT_HOME when set and absolute, documented
 * as the base directory for Copilot data, else ~/.copilot). Never relies on
 * plugin-loader-injected environment variables.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveDataDir(env = process.env) {
  const override = env?.[DATA_ENV_VAR];
  if (typeof override === "string" && override.length > 0) {
    if (!path.isAbsolute(override)) {
      throw new Error(`copilot store: ${DATA_ENV_VAR} must be an absolute directory path`);
    }
    return override;
  }
  const configuredHome = env?.COPILOT_HOME;
  if (typeof configuredHome === "string" && configuredHome.length > 0) {
    if (!path.isAbsolute(configuredHome)) {
      throw new Error("copilot store: COPILOT_HOME must be an absolute directory path");
    }
    return path.join(configuredHome, DATA_DIR_NAME);
  }
  return path.join(os.homedir(), ".copilot", DATA_DIR_NAME);
}

/** @param {unknown} value */
/** @returns {value is string} */
const isNonEmptyString = (/** @type {unknown} */ value) => typeof value === "string" && value.length > 0;
/** @param {unknown} value */
/** @returns {value is string} */
const isNonBlankString = (/** @type {unknown} */ value) => typeof value === "string" && value.trim().length > 0;
/** @param {unknown} value */
/** @returns {value is number} */
const isFiniteNumber = (/** @type {unknown} */ value) => typeof value === "number" && Number.isFinite(value);
/**
 * @param {unknown} value
 */
/** @param {unknown} value @returns {string | undefined} */
const agentIdOf = (value) => {
  if (typeof value !== "object" || value === null) return undefined;
  const id = /** @type {unknown} */ (/** @type {Record<string, unknown>} */ (value)["agentId"]);
  return isNonEmptyString(id) ? id : undefined;
};

/**
 * @param {string} id
 */
/** @param {string} id */
function idToFile(id) {
  return createHash("sha256").update(id, "utf8").digest("hex") + ".json";
}

/**
 * @param {string} dir
 */
/** @param {string} dir */
function ensureDir(dir) {
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  fs.chmodSync(dir, 0o700);
}

/**
 * @param {string} file
 */
/** @param {string} file */
function removeQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}

/**
 * @param {unknown} value
 */
function assertHandoverRecord(value) {
  if (typeof value !== "object" || value === null) throw new Error("copilot store: handover record must be an object");
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of ["childId", "parentSessionId", "agentType", "handover", "summary"]) {
    if (!isNonEmptyString(record[key])) throw new Error(`copilot store: handover record ${key} must be a non-empty string`);
  }
  if (record["closed"] !== true) throw new Error("copilot store: handover record closed must be true");
  const diag = record["diagnostics"];
  if (typeof diag !== "object" || diag === null) throw new Error("copilot store: handover record diagnostics must be an object");
  const diagnostics = /** @type {Record<string, unknown>} */ (diag);
  if (diagnostics["reason"] !== "nudged" && diagnostics["reason"] !== "not-nudged" && diagnostics["reason"] !== "unknown") {
    throw new Error('copilot store: handover record diagnostics.reason must be "nudged", "not-nudged", or "unknown"');
  }
  if (
    diagnostics["stage"] !== undefined &&
    diagnostics["stage"] !== "warn1" &&
    diagnostics["stage"] !== "warn2" &&
    diagnostics["stage"] !== "final"
  ) {
    throw new Error("copilot store: handover record diagnostics.stage must be warn1, warn2, or final");
  }
  if (diagnostics["estimatedTokens"] !== undefined && !isFiniteNumber(diagnostics["estimatedTokens"])) {
    throw new Error("copilot store: handover record diagnostics.estimatedTokens must be a number");
  }
  if (diagnostics["soft"] !== undefined && !isFiniteNumber(diagnostics["soft"])) {
    throw new Error("copilot store: handover record diagnostics.soft must be a number");
  }
}

/**
 * @param {unknown} value
 */
function assertObservation(value) {
  if (typeof value !== "object" || value === null) throw new Error("copilot store: observation must be an object");
  const observation = /** @type {Record<string, unknown>} */ (value);
  if (observation["soft"] !== undefined && !isFiniteNumber(observation["soft"])) {
    throw new Error("copilot store: observation soft must be a number");
  }
  if (observation["estimatedTokens"] !== undefined && !isFiniteNumber(observation["estimatedTokens"])) {
    throw new Error("copilot store: observation estimatedTokens must be a number");
  }
  if (observation["tokenLimit"] !== undefined && !isFiniteNumber(observation["tokenLimit"])) {
    throw new Error("copilot store: observation tokenLimit must be a number");
  }
  if (observation["nudged"] !== undefined && typeof observation["nudged"] !== "boolean") {
    throw new Error("copilot store: observation nudged must be a boolean");
  }
}

export class CopilotStore {
  /** @param {string} baseDir */
  constructor(baseDir) {
    if (!isNonEmptyString(baseDir)) throw new Error("copilot store: baseDir must be a non-empty string");
    this.baseDir = baseDir;
  }

  handoversDir() {
    return path.join(this.baseDir, "handovers");
  }

  /**
   * @param {HandoverRecord} record
   */
  saveHandover(record) {
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
      if (/** @type {{ code?: unknown }} */ (error)?.code === "EEXIST") throw new DuplicateHandoverError(record.childId);
      throw error;
    }
    removeQuiet(tmpPath);
  }

  /**
   * @param {string} childId
   * @returns {HandoverRecord | undefined}
   */
  getHandover(childId) {
    if (!isNonEmptyString(childId)) throw new Error("copilot store: childId must be a non-empty string");
    const finalPath = path.join(this.handoversDir(), idToFile(childId));
    let raw;
    try {
      raw = fs.readFileSync(finalPath, "utf8");
    } catch (error) {
      if (/** @type {{ code?: unknown }} */ (error)?.code === "ENOENT") return undefined;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`copilot store: handover record for ${JSON.stringify(childId)} is corrupt`);
    }
    try {
      assertHandoverRecord(parsed);
    } catch {
      throw new Error(`copilot store: handover record for ${JSON.stringify(childId)} is corrupt`);
    }
    return /** @type {HandoverRecord} */ (parsed);
  }
}

// --- Ephemeral per-process child state: host-measured observations and
// host-reported agent types. Cleared on child start, compaction,
// context-cleared, completion, and failure; never written to disk.

export class ChildMemory {
  constructor() {
    /** @type {Map<string, Observation>} */
    this.observations = new Map();
    /** @type {Map<string, string>} */
    this.agentTypes = new Map();
  }

  /**
   * @param {string} childId
   * @returns {Observation | undefined}
   */
  getObservation(childId) {
    const value = this.observations.get(childId);
    if (value === undefined) return undefined;
    try {
      assertObservation(value);
    } catch {
      this.observations.delete(childId);
      return undefined;
    }
    return { ...value };
  }

  /**
   * @param {string} childId
   * @param {Observation} observation
   */
  setObservation(childId, observation) {
    if (!isNonEmptyString(childId)) throw new Error("copilot memory: childId must be a non-empty string");
    assertObservation(observation);
    this.observations.set(childId, { ...observation });
  }

  /**
   * @param {string} childId
   */
  clearObservation(childId) {
    this.observations.delete(childId);
  }

  /**
   * @param {string} childId
   * @param {unknown} agentType
   */
  noteAgentType(childId, agentType) {
    if (!isNonEmptyString(childId)) return;
    if (!isNonEmptyString(agentType)) return;
    if (!this.agentTypes.has(childId)) this.agentTypes.set(childId, agentType);
  }

  /**
   * @param {string} childId
   * @returns {string | undefined}
   */
  getAgentType(childId) {
    return this.agentTypes.get(childId);
  }

  /**
   * @param {string} childId
   */
  clearAgentType(childId) {
    this.agentTypes.delete(childId);
  }

  clearAll() {
    this.observations.clear();
    this.agentTypes.clear();
  }
}

// --- Extension wiring inputs. Each handler takes the raw SDK input plus the
// store, memory, and env, and returns the SDK hook output (or undefined for
// no-op). Unknown measurement fails open: handlers stay silent instead of
// guessing.

/**
 * @param {CopilotStore} store
 * @param {string} childId
 * @returns {HandoverRecord | undefined}
 */
function closedRecord(store, childId) {
  if (!isNonEmptyString(childId)) return undefined;
  try {
    return store.getHandover(childId);
  } catch {
    return undefined;
  }
}

/**
 * @param {number} estimate
 * @param {number} soft
 * @returns {"warn1" | "warn2" | "final" | undefined}
 */
function diagStageFor(estimate, soft) {
  const stage = softStage(estimate, soft);
  if (stage === "ok") return undefined;
  return stage === "warn3" ? "final" : stage;
}

/**
 * Record a host-reported agent type only from same-agent hook inputs (pre/post
 * tool use), whose agentId/agentType describe the calling child itself. The
 * subagent-start hook is parent-scoped and is not a safe source.
 * @param {PreToolUseHookInput | PostToolUseHookInput} input
 * @param {ChildMemory} memory
 */
function captureAgentType(input, memory) {
  const agentId = agentIdOf(input);
  const agentType = /** @type {{ agentType?: unknown }} */ (input)?.agentType;
  if (agentId !== undefined) memory.noteAgentType(agentId, agentType);
}

/** Root session start: standing introduction, no measurement needed. */
export function handleSessionStart() {
  return { additionalContext: ROOT_INTRO };
}

/**
 * Subagent start: standing child introduction. A fresh child run clears stale
 * measurement for that id only (agent ids are single-use); the recorded
 * agent type is retained first-wins and is not cleared here. When the
 * start hook carries an agentId for an already-closed child, the locked
 * followup replaces fresh guidance.
 * @param {SubagentStartHookInput} input
 * @param {CopilotStore} store
 * @param {ChildMemory} memory
 */
export function handleSubagentStart(input, store, memory) {
  const agentId = agentIdOf(input);
  if (agentId !== undefined) memory.clearObservation(agentId);
  const closed = agentId !== undefined ? closedRecord(store, agentId) : undefined;
  if (closed) return { additionalContext: lockedReply(closed) };
  return { additionalContext: CHILD_INTRO };
}

/**
 * Record a host-measured usage_info event. Estimate is currentTokens only;
 * tokenLimit is the window for soft resolution. Malformed, unknown, or zero
 * measurements clear any stale snapshot and fail open. Root/main events
 * (absent agentId) are ignored: this MVP is child-scoped. Measurements for
 * closed children are dropped.
 * @param {SessionEvent} event
 * @param {CopilotStore} store
 * @param {ChildMemory} memory
 * @param {NodeJS.ProcessEnv} [env]
 */
export function handleUsageInfo(event, store, memory, env = process.env) {
  const key = agentIdOf(event);
  if (key === undefined) return false;
  if (closedRecord(store, key) !== undefined) {
    memory.clearObservation(key);
    return false;
  }
  const data = /** @type {{ data?: unknown }} */ (event)?.data;
  if (typeof data !== "object" || data === null) {
    memory.clearObservation(key);
    return false;
  }
  const fields = /** @type {Record<string, unknown>} */ (data);
  const currentTokens = fields["currentTokens"];
  if (!isFiniteNumber(currentTokens) || currentTokens <= 0) {
    memory.clearObservation(key);
    return false;
  }
  const rawLimit = fields["tokenLimit"];
  const tokenLimit = isFiniteNumber(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
  let soft;
  try {
    soft = resolveSoftForWindow(env, tokenLimit);
  } catch {
    soft = undefined;
  }
  if (soft === undefined) {
    memory.clearObservation(key);
    return false;
  }
  const priorNudged = memory.getObservation(key)?.nudged === true;
  memory.setObservation(key, {
    estimatedTokens: Math.floor(currentTokens),
    ...(tokenLimit === undefined ? {} : { tokenLimit }),
    soft,
    ...(priorNudged ? { nudged: true } : {}),
  });
  return true;
}

/**
 * Pre tool use: locked children deny every tool (never-resume). The denial
 * covers direct handler paths too: closed-child tool handlers re-check the
 * lock themselves. Open children pass through untouched; own tools need no
 * capability minting because invocation identity is checked in-process by the
 * tool handlers.
 * @param {PreToolUseHookInput} input
 * @param {CopilotStore} store
 * @param {ChildMemory} memory
 * @returns {PreToolUseHookOutput | undefined}
 */
export function handlePreToolUse(input, store, memory) {
  captureAgentType(input, memory);
  const agentId = agentIdOf(input);
  if (agentId === undefined) return undefined;
  const closed = closedRecord(store, agentId);
  if (!closed) return undefined;
  const toolName = input.toolName.length > 0 ? input.toolName : "tool call";
  return {
    permissionDecision: "deny",
    permissionDecisionReason:
      `This subagent session is locked after a context handover and cannot do more work. ` +
      `Denied ${toolName}. Default: ${readInvocation(agentId)}, ` +
      `then ${successorPrompt(agentId)}`,
  };
}

/**
 * Post tool use (success path): child-only staged notice at shared
 * soft/soft*1.1/soft*1.2 boundaries from the latest host-measured estimate.
 * Unknown estimate, unresolved soft, or stage ok stays silent. The stored
 * soft is authoritative (env is fixed for the extension process lifetime).
 * @param {PostToolUseHookInput} input
 * @param {CopilotStore} store
 * @param {ChildMemory} memory
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {PostToolUseHookOutput | undefined}
 */
export function handlePostToolUse(input, store, memory, env = process.env) {
  captureAgentType(input, memory);
  const agentId = agentIdOf(input);
  if (agentId === undefined) return undefined;
  if (closedRecord(store, agentId) !== undefined) return undefined;
  const observed = memory.getObservation(agentId);
  const estimate = observed?.estimatedTokens;
  const soft = observed?.soft;
  if (!isFiniteNumber(estimate) || !isFiniteNumber(soft)) return undefined;
  const stage = softStage(/** @type {number} */ (estimate), /** @type {number} */ (soft));
  if (stage === "ok") return undefined;
  memory.setObservation(agentId, { ...observed, nudged: true });
  return { additionalContext: buildNotice(stage) };
}

/**
 * Subagent stop: when a handover is stored, rewrite the reported response to
 * the continuation receipt via the native modifiedResponse field. Never
 * blocks, so no stop loop is possible; the child always terminates.
 * @param {SubagentStopHookInput} input
 * @param {CopilotStore} store
 * @returns {import("@github/copilot-sdk").SubagentStopHookOutput | undefined}
 */
export function handleSubagentStop(input, store) {
  const agentId = agentIdOf(input);
  if (agentId === undefined) return undefined;
  const record = closedRecord(store, agentId);
  if (!record) return undefined;
  return { modifiedResponse: shortReply(record) };
}

/**
 * Require an exact argument object shape: no missing required strings, no
 * blank strings, no extra keys. Identity is never accepted from model args.
 * @param {unknown} args
 * @param {readonly string[]} allowed
 * @param {string} toolName
 * @returns {Record<string, unknown>}
 */
function exactArgs(args, allowed, toolName) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ConfigError(`copilot tool: ${toolName} requires an argument object`);
  }
  const record = /** @type {Record<string, unknown>} */ (args);
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`copilot tool: ${toolName} rejects unexpected argument ${JSON.stringify(key)}`);
    }
  }
  return record;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @param {string} toolName
 * @returns {string}
 */
function requiredText(record, key, toolName) {
  if (!isNonBlankString(record[key])) {
    throw new ConfigError(`copilot tool: ${toolName} requires ${key} as a non-blank string`);
  }
  return /** @type {string} */ (record[key]);
}

/**
 * context_handover tool handler. Only host-attributed subagent calls are
 * accepted: an unattributed call (absent agentId, which can mean a root call
 * or an unattributed child call) is refused and stores nothing. Duplicate
 * storage is an error path that returns the locked reply, never an overwrite.
 * Works with unknown usage/window: diagnostics fields stay optional.
 * @param {unknown} args
 * @param {ToolInvocation} invocation
 * @param {CopilotStore} store
 * @param {ChildMemory} memory
 * @param {NodeJS.ProcessEnv} [env]
 */
export function handleHandoverTool(args, invocation, store, memory, env = process.env) {
  const agentId = agentIdOf(invocation);
  if (agentId === undefined) {
    return (
      `This tool needs a host-attributed subagent caller, but this call carries no subagent identity ` +
      `(an absent agentId can mean a root call or a child call the runtime did not attribute), so nothing was stored. ` +
      `Finish your turn normally.`
    );
  }
  const record = exactArgs(args, ["handover", "summary"], TOOL_NAMES.handover);
  const handover = requiredText(record, "handover", TOOL_NAMES.handover);
  const summary = requiredText(record, "summary", TOOL_NAMES.handover);
  let existing;
  try {
    existing = store.getHandover(agentId);
  } catch (error) {
    throw new ConfigError(`copilot tool: cannot store handover: ${/** @type {Error} */ (error).message}`);
  }
  if (existing) {
    return lockedReply(existing);
  }
  // invocation.sessionId is the parent session scope for tool calls; hook
  // input.sessionId scopes differ per surface and are never compared here.
  const sessionId = invocation.sessionId.length > 0 ? invocation.sessionId : "unknown";
  const observed = memory.getObservation(agentId);
  let soft;
  try {
    soft = observed?.soft ?? resolveSoftForWindow(env, observed?.tokenLimit);
  } catch {
    soft = undefined;
  }
  const stored = {
    childId: agentId,
    parentSessionId: sessionId,
    agentType: memory.getAgentType(agentId) ?? "unknown",
    handover,
    summary,
    closed: /** @type {true} */ (true),
    diagnostics: {
      reason: /** @type {"nudged" | "not-nudged" | "unknown"} */ (
        observed?.nudged === true ? "nudged" : observed === undefined ? "unknown" : "not-nudged"
      ),
      ...(observed?.estimatedTokens === undefined || !isFiniteNumber(soft)
        ? {}
        : {
            stage: diagStageFor(observed.estimatedTokens, /** @type {number} */ (soft)),
            estimatedTokens: observed.estimatedTokens,
          }),
      ...(soft === undefined ? {} : { soft }),
    },
  };
  try {
    store.saveHandover(stored);
  } catch (error) {
    if (error instanceof DuplicateHandoverError) {
      const raced = closedRecord(store, agentId);
      return raced ? lockedReply(raced) : `Handover already stored for this subagent; nothing was overwritten.`;
    }
    throw new ConfigError(`copilot tool: cannot store handover: ${/** @type {Error} */ (error).message}`);
  }
  return (
    `Handover stored; end your turn now with exactly the following text as your final message and then stop.\n\n${shortReply(stored)}`
  );
}

/**
 * read_handover tool handler. Open reader: any live caller with tool access
 * may read any stored child handover by id (absent caller agentId is root
 * access and stays open), except a locked child calling
 * directly, which gets the locked reply like every other direct tool path.
 * The caller lock check is strict like the target read: unreadable or corrupt
 * caller state throws instead of failing open. The seed-size advisory is a
 * labelled reader header; the result always ends in the verbatim body.
 * @param {unknown} args
 * @param {ToolInvocation} invocation
 * @param {CopilotStore} store
 */
export function handleReadTool(args, invocation, store) {
  const record = exactArgs(args, ["childId"], TOOL_NAMES.read);
  const childId = requiredText(record, "childId", TOOL_NAMES.read);
  const callerId = agentIdOf(invocation);
  if (callerId !== undefined) {
    let callerClosed;
    try {
      callerClosed = store.getHandover(callerId);
    } catch (error) {
      throw new ConfigError(`copilot tool: cannot read handover: ${/** @type {Error} */ (error).message}`);
    }
    if (callerClosed) return lockedReply(callerClosed);
  }
  let stored;
  try {
    stored = store.getHandover(childId);
  } catch (error) {
    throw new ConfigError(`copilot tool: cannot read handover: ${/** @type {Error} */ (error).message}`);
  }
  if (!stored) return `No handover is stored for child ${JSON.stringify(childId)}.`;
  const head = `${formatDiagLine({ ...stored.diagnostics, estimate: stored.diagnostics.estimatedTokens })}\n${formatProvenanceLine(stored)}`;
  const soft = stored.diagnostics?.soft;
  let advisory;
  if (isFiniteNumber(soft)) {
    const estimate = Math.ceil(stored.handover.length / 4);
    if (seedTooLarge(estimate, /** @type {number} */ (soft))) {
      advisory =
        `Seed size warning (advisory only): stored handover is about ${estimate} tokens (chars/4 estimate), ` +
        `over 50% of the soft limit ${soft}; the successor should compress carried-over finished notes at its next handover. ` +
        `Stored text is unchanged.`;
    }
  }
  return advisory ? `${head}\n${advisory}\n\n${stored.handover}` : `${head}\n\n${stored.handover}`;
}

/**
 * Session event dispatcher for the extension process. Returns true when the
 * event was consumed. Unknown types are ignored (fail open).
 * @param {SessionEvent} event
 * @param {CopilotStore} store
 * @param {ChildMemory} memory
 * @param {NodeJS.ProcessEnv} [env]
 */
export function handleSessionEvent(event, store, memory, env = process.env) {
  const type = /** @type {{ type?: unknown }} */ (event)?.type;
  if (type === "session.usage_info") {
    return handleUsageInfo(event, store, memory, env);
  }
  if (type === "subagent.completed" || type === "subagent.failed") {
    const agentId = agentIdOf(event);
    if (agentId === undefined) return false;
    memory.clearObservation(agentId);
    memory.clearAgentType(agentId);
    return true;
  }
  if (type === "session.context_cleared" || type === "session.compaction_start" || type === "session.compaction_complete") {
    const agentId = agentIdOf(event);
    if (agentId === undefined) {
      memory.clearAll();
    } else {
      memory.clearObservation(agentId);
      memory.clearAgentType(agentId);
    }
    return true;
  }
  return false;
}

/**
 * Build the exact tool/hook registration for joinSession plus the session
 * event subscriptions. extension.mjs registers this verbatim; the wiring
 * test asserts it without launching a host.
 * @param {CopilotStore} store
 * @param {ChildMemory} memory
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ tools: Tool[], hooks: SessionHooks, subscriptions: readonly string[] }}
 */
export function buildExtensionConfig(store, memory, env = process.env) {
  const handoverParameters = {
    type: "object",
    properties: {
      handover: { type: "string", description: "Full handover text (six sections, verbatim)." },
      summary: { type: "string", description: "Short status/outcome/next-step summary." },
    },
    required: ["handover", "summary"],
    additionalProperties: false,
  };
  const readParameters = {
    type: "object",
    properties: {
      childId: { type: "string", description: "Predecessor child (agent) id." },
    },
    required: ["childId"],
    additionalProperties: false,
  };
  return {
    tools: [
      {
        name: TOOL_NAMES.handover,
        description: HANDOVER_DESCRIPTION,
        parameters: handoverParameters,
        defer: "never",
        handler: (args, invocation) => handleHandoverTool(args, invocation, store, memory, env),
      },
      {
        name: TOOL_NAMES.read,
        description: READ_DESCRIPTION,
        parameters: readParameters,
        defer: "never",
        handler: (args, invocation) => handleReadTool(args, invocation, store),
      },
    ],
    hooks: {
      onSessionStart: () => handleSessionStart(),
      onSubagentStart: (input) => handleSubagentStart(input, store, memory),
      onPreToolUse: (input) => handlePreToolUse(input, store, memory),
      onPostToolUse: (input) => handlePostToolUse(input, store, memory, env),
      onSubagentStop: (input) => handleSubagentStop(input, store),
    },
    subscriptions: SESSION_SUBSCRIPTIONS,
  };
}

export const __testing = { SHARED_PROVENANCE_PARAGRAPH, WARN1, WARN2, WARN3, CHILD_ROLLOVER_GUIDANCE };
