// auto-context-handover: AiderDesk root agent-task adapter (no build step).
// Root agent runs only: measured soft-limit advisories and a model-written
// handover persisted to private HOME plugin storage. Storage only: no
// automatic successor, no lock/tool gate, no native
// handoff/compact calls, no config changes. Manual continuation only: the
// user creates/opens a new task through the normal AiderDesk UI and prompts
// it with the reader reference from read-handover.
//
// Persistence: ~/.aiderdesk/auto-context-handover/<sha256(projectId + '\0' + taskId)>/handover.json
// holds the verbatim handover (first writer wins, never overwritten). The
// project-scoped hash is required because task ids alone are not trusted to
// be unique across projects. Survives extension reload; in-memory
// diagnostics do not, so tool calls after a reload honestly report unknown
// diagnostics. Nothing is written inside the project working directory.
//
// Installation shape: this folder is a folder-based AiderDesk extension.
// The id "aiderdesk" comes from the folder name; the host exposes the tools
// as "aiderdesk---context-handover" and "aiderdesk---read-handover". Install
// a real folder with an absolute forwarding index.ts to this file; the host
// skips symlink directories and copying this folder loses shared imports.

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// The host aliases zod, so this bare specifier resolves to the bundled copy.
import { z } from "zod";
import type {
  AgentProfile,
  AgentStartedEvent,
  AgentStepStartedEvent,
  ContextMessage,
  Extension,
  ExtensionContext,
  ExtensionMetadata,
  TaskClosedEvent,
  ToolDefinition,
} from "@aiderdesk/extensions";
import { parseThreshold, type ThresholdSpec } from "../source/shared/threshold.ts";
import { resolveSoftTokens } from "../source/measure.ts";
import {
  HANDOVER_SECTIONS,
  SEED_FRAMING,
  formatDiagLine,
  openCodeStageText,
  softStage,
} from "../source/shared/handover-text.ts";

const TOOL_NAME = "context-handover";
const READ_TOOL_NAME = "read-handover";
// Folder-derived host extension id. The host exposes extension tools as
// `<extensionId>---<toolName>` (TOOL_GROUP_NAME_SEPARATOR); approvals and
// recovery keys use the full form while the model calls the short name.
export const EXTENSION_ID = "aiderdesk";
export const TOOL_SEPARATOR = "---";
export const FULL_TOOL_NAME = `${EXTENSION_ID}${TOOL_SEPARATOR}${TOOL_NAME}`;
export const FULL_READ_TOOL_NAME = `${EXTENSION_ID}${TOOL_SEPARATOR}${READ_TOOL_NAME}`;

const ENV_SOFT = "AUTO_CONTEXT_HANDOVER_SOFT";
const DEFAULT_SOFT = 200000;

const SUBDIR = "auto-context-handover";
const STORAGE_DIRNAME = ".aiderdesk";
const HANDOVER_FILE = "handover.json";

type DiagValue = number | "unknown";

interface CallDiag {
  readonly stage: string;
  readonly estimate: DiagValue;
  readonly soft: DiagValue;
}

interface AgentIdentity {
  readonly provider: string;
  readonly model: string;
}

interface StoredHandover {
  readonly handover: string;
  readonly summary: string;
  readonly sourceTaskId: string;
  readonly provider: string;
  readonly model: string;
  readonly storedAt: number;
  readonly diag: {
    readonly reason: string;
    readonly stage: string;
    readonly estimate: DiagValue;
    readonly soft: DiagValue;
  };
}

// The shared six-section text carries one paragraph claiming an
// authoritative parent/agent/model/chain plugin record. The AiderDesk entry
// keeps the sections unchanged apart from that paragraph: the plugin-recorded
// source task id and effective model are authoritative host data.
const SHARED_PROVENANCE_PARAGRAPH =
  "Do not describe your own agent type, model (including override), or chain; the plugin records authoritative provenance and the parent uses the plugin record even if this handover says otherwise.";
const AIDERDESK_PROVENANCE_PARAGRAPH =
  "The stored entry's source task id and effective model are the authoritative provenance; " +
  "unknown values are unknown, and no model override or child chain is recorded. " +
  "Do not restate your own agent or model identity; write the handover from the task content.";
const AIDERDESK_HANDOVER_SECTIONS = (() => {
  if (!HANDOVER_SECTIONS.includes(SHARED_PROVENANCE_PARAGRAPH)) {
    throw new Error("auto-context-handover: shared handover text drifted, refusing to register with stale provenance wording");
  }
  return HANDOVER_SECTIONS.replace(SHARED_PROVENANCE_PARAGRAPH, AIDERDESK_PROVENANCE_PARAGRAPH);
})();

// Copyable manual continuation reference. The user creates/opens the new
// task through the normal AiderDesk UI; the new task's prompt references
// this stored handover by task id instead of pasting the full text.
const manualContinuationHint = (sourceTaskId: string): string =>
  `Manual continuation only (no automatic successor or lock): create/open a new task through the normal AiderDesk UI ` +
  `and prompt it with: call read-handover with {"taskId": "${sourceTaskId}"}, do not paste the handover text, ` +
  `and continue from 'Prioritized next steps'. ${SEED_FRAMING}`;

const TOOL_DESCRIPTION =
  `Call this tool only after an auto-context-handover advisory notice appears, or when the user explicitly asks for a handover. ` +
  `Do not call it just to finish a task; give a normal final response instead. ` +
  `Once the notice appears (or the user asks), call exactly once per unit of work when done, then end your turn. ` +
  `Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never summarized or reworded) ` +
  `plus a short status/outcome/next-step summary in "summary".\n\n` +
  `${AIDERDESK_HANDOVER_SECTIONS}\n\n` +
  `Storage only: the text is kept in private HOME plugin storage (~/.aiderdesk/auto-context-handover) for manual continuation. ` +
  `Once stored, end your turn without starting new work; there is no automatic successor and no lock. ` +
  `If a handover is already stored for this task the call is refused and the original is kept, never overwritten. ` +
  `Do not paste secrets.`;

const READ_DESCRIPTION =
  `Read the handover stored for a task. ` +
  `Takes an optional taskId scoped to loaded project tasks via the host (never reads arbitrary paths) and defaults to the current task. ` +
  `Returns the verbatim stored text plus a diagnostics header and a copyable manual continuation hint, or a plain notice when nothing is stored yet. ` +
  `Storage only: there is no automatic successor and no lock.`;

const INTRO_TEXT =
  `auto-context-handover is active for this root agent task. ` +
  `Soft-limit advisories may follow; each advisory applies to the current step only: ` +
  `it replaces any required final report or current-step wrap-up instruction for that step, not the whole task. ` +
  `When an advisory appears, finish the current step, then call the context-handover tool with the full handover text; ` +
  `the tool writes only private HOME plugin storage, so read-only task instructions still allow the call. ` +
  `After the handover is stored, end your turn; there is no automatic successor and no lock. ` +
  `To continue, the user creates/opens a new task through the normal AiderDesk UI and prompts it with the read-handover reference. ` +
  `Nothing continues until the handover is stored.`;

// Stable per-stage notice suffix. No live numbers: the text is identical on
// every step that observes the same stage.
const NOTICE_SUFFIX =
  ` This advisory applies to the current step only: it replaces any required final report or current-step wrap-up for this step, ` +
  `not the whole task (see the auto-context-handover intro message for the full workflow). ` +
  `When done with this step, call the context-handover tool with the full handover text ` +
  `(private HOME plugin storage write only, allowed under read-only instructions); after storing, end your turn. ` +
  `There is no automatic successor and no lock.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asDiagValue = (value: unknown): DiagValue =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : "unknown";

/**
 * Resolve the soft threshold. Integer values cap at 70% of a known window;
 * explicit percentages apply uncapped; an unknown window leaves numerics
 * uncapped and percentages unresolved (fail open). An invalid explicit value
 * resolves to undefined: step hooks then stay silent instead of substituting
 * another threshold, and onLoad reports the bad value. Only undefined
 * selects the default; an explicit empty string is invalid.
 */
function softSpecFromEnv(raw: string | undefined): { readonly spec?: ThresholdSpec; readonly error?: string } {
  if (raw === undefined) return { spec: { kind: "tokens", tokens: DEFAULT_SOFT } };
  // Env vars arrive as strings, so a digit-only string is the integer-token
  // form; everything else goes to the shared parser untouched.
  const normalized = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  try {
    return { spec: parseThreshold(normalized) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

// Private HOME storage. Extensions run in the host main process with
// unrestricted Node filesystem access (pinned loader uses plain jiti with no
// fs sandbox; the bundled verifier reads/writes its own folder via node:fs),
// so handovers live outside the project working directory. Scope every
// record under a hash of the host-resolved project identity plus the task id
// so identical task ids in different projects never collide. The raw ids are
// never used as path segments.
function storageRoot(): string {
  return join(homedir(), STORAGE_DIRNAME, SUBDIR);
}

function scopeHash(projectId: string, taskId: string): string {
  return createHash("sha256").update(projectId, "utf8").update("\0", "utf8").update(taskId, "utf8").digest("hex");
}

function handoverFile(projectId: string, taskId: string): string {
  return join(storageRoot(), scopeHash(projectId, taskId), HANDOVER_FILE);
}

// Host-resolved project identity for storage scoping: the project context
// baseDir when available, else the extension project dir, else the task
// working directory as a last resort. Empty means unresolvable.
function projectIdentity(
  context: ExtensionContext,
  task: { getTaskDir?: () => string } | null,
): string {
  try {
    const project = context.getProjectContext() as { baseDir?: unknown } | null;
    if (project && typeof project.baseDir === "string" && project.baseDir) return project.baseDir;
  } catch {
    // Fall through to the next source.
  }
  try {
    const dir = (context as { getProjectDir?: () => unknown }).getProjectDir?.();
    if (typeof dir === "string" && dir) return dir;
  } catch {
    // Fall through to the next source.
  }
  try {
    const taskDir = task?.getTaskDir?.();
    if (typeof taskDir === "string" && taskDir) return taskDir;
  } catch {
    // Unresolvable.
  }
  return "";
}

/**
 * Atomic first-writer publication for the immutable handover record: the
 * payload is fully written to a private tempfile, then atomically linked to
 * the target. A concurrent winner surfaces as EEXIST, which maps to
 * "exists" without ever clobbering the winner. The tempfile is always
 * unlinked.
 */
async function publishImmutableFirstWins(path: string, data: string): Promise<"created" | "exists"> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, data, { mode: 0o600 });
  try {
    try {
      await link(tmp, path);
      return "created";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw error;
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function readJsonFile(path: string): Promise<{ readonly found: boolean; readonly data?: unknown; readonly invalid: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { found: false, invalid: false };
    throw error;
  }
  try {
    return { found: true, data: JSON.parse(raw) as unknown, invalid: false };
  } catch {
    return { found: true, invalid: true };
  }
}

function asStoredHandover(value: unknown): StoredHandover | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.handover !== "string" || value.handover.length === 0) return undefined;
  if (typeof value.summary !== "string" || value.summary.length === 0) return undefined;
  const diag = isRecord(value.diag) ? value.diag : {};
  const reason = typeof diag.reason === "string" && diag.reason.length > 0 ? diag.reason : "unknown";
  const stage = typeof diag.stage === "string" && diag.stage.length > 0 ? diag.stage : "unknown";
  return {
    handover: value.handover,
    summary: value.summary,
    sourceTaskId: typeof value.sourceTaskId === "string" ? value.sourceTaskId : "unknown",
    provider: typeof value.provider === "string" ? value.provider : "unknown",
    model: typeof value.model === "string" ? value.model : "unknown",
    storedAt: typeof value.storedAt === "number" ? value.storedAt : 0,
    diag: { reason, stage, estimate: asDiagValue(diag.estimate), soft: asDiagValue(diag.soft) },
  };
}

const handoverSchema = z.object({
  handover: z.string(),
  summary: z.string(),
});

const readSchema = z.object({
  taskId: z.string().optional(),
});

type HandoverInput = z.infer<typeof handoverSchema>;
type ReadInput = z.infer<typeof readSchema>;

const isRootAgent = (mode: string, profile: AgentProfile | undefined): boolean =>
  mode === "agent" && profile !== undefined && !profile.isSubagent;

const userMessage = (content: string): ContextMessage =>
  ({ id: randomUUID(), role: "user", content, timestamp: Date.now() }) as ContextMessage;

export default class AutoContextHandoverExtension implements Extension {
  static metadata: ExtensionMetadata = {
    name: "Auto Context Handover",
    version: "0.1.0",
    description: "Measured soft-limit handover storage for root agent tasks with manual continuation",
    author: "auto-context-handover",
    capabilities: ["tools"],
  };

  // Latest observed estimate per task id. Lost on extension reload, so a
  // tool call after reload honestly reports unknown diagnostics.
  private readonly diagByTask = new Map<string, CallDiag>();
  private readonly agentByTask = new Map<string, AgentIdentity>();
  private softSpec: ThresholdSpec | undefined = { kind: "tokens", tokens: DEFAULT_SOFT };

  async onLoad(context: ExtensionContext): Promise<void> {
    const { spec, error } = softSpecFromEnv(process.env[ENV_SOFT]);
    if (error !== undefined) {
      this.softSpec = undefined;
      context.log(
        `auto-context-handover: invalid ${ENV_SOFT} value ${JSON.stringify(process.env[ENV_SOFT])}: ${error}. ` +
          `Handover advisories stay disabled until the value is fixed (default ${DEFAULT_SOFT}).`,
        "error",
      );
    } else {
      this.softSpec = spec;
    }
    context.addDisposable(() => {
      this.diagByTask.clear();
      this.agentByTask.clear();
    });
  }

  async onUnload(): Promise<void> {
    this.diagByTask.clear();
    this.agentByTask.clear();
  }

  getTools(context: ExtensionContext, mode: string, agentProfile: AgentProfile): ToolDefinition[] {
    void context;
    if (!isRootAgent(mode, agentProfile)) return [];
    return [this.buildHandoverTool(), this.buildReadTool()];
  }

  private buildHandoverTool(): ToolDefinition<typeof handoverSchema> {
    return {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: handoverSchema,
      execute: async (input: HandoverInput, _signal: AbortSignal | undefined, context: ExtensionContext) => {
        const handover = typeof input.handover === "string" ? input.handover : "";
        const summary = typeof input.summary === "string" ? input.summary : "";
        if (handover.trim().length === 0) {
          throw new Error(`auto-context-handover: "handover" must be the full handover text, verbatim and non-empty`);
        }
        if (summary.trim().length === 0) {
          throw new Error(`auto-context-handover: "summary" must be a short status/outcome/next-step summary, non-empty`);
        }
        const task = context.getTaskContext();
        if (!task) {
          throw new Error(`auto-context-handover: no task context for the handover call, refusing to act`);
        }
        const taskId = task.data.id;
        const projectId = projectIdentity(context, task);
        if (!projectId) {
          throw new Error(`auto-context-handover: no project identity for task ${taskId}, refusing to act`);
        }
        const observed = this.diagByTask.get(taskId);
        const identity = this.agentByTask.get(taskId);
        const diag = {
          reason:
            !observed || observed.stage === "unknown" ? "unknown" : observed.stage !== "ok" ? "nudged" : "not-nudged",
          stage: observed ? observed.stage : "unknown",
          estimate: observed ? observed.estimate : "unknown",
          soft: observed ? observed.soft : "unknown",
        };
        const payload: StoredHandover = {
          handover,
          summary,
          sourceTaskId: taskId,
          provider: identity ? identity.provider : "unknown",
          model: identity ? identity.model : "unknown",
          storedAt: Date.now(),
          diag,
        };
        let published: "created" | "exists";
        try {
          published = await publishImmutableFirstWins(handoverFile(projectId, taskId), JSON.stringify(payload));
        } catch (error) {
          throw new Error(
            `auto-context-handover: failed to store handover, nothing was handed over: ${(error as Error).message}`,
          );
        }
        if (published === "exists") {
          return (
            `A handover is already stored for task ${taskId}; the original is kept and nothing was overwritten. ` +
            `There is no automatic successor and no lock. ${manualContinuationHint(taskId)}`
          );
        }
        return (
          `Handover stored for task ${taskId}. ` +
          `End your turn now without starting new work; there is no automatic successor and no lock. ` +
          `${manualContinuationHint(taskId)} No further handover call is needed.`
        );
      },
    };
  }

  private buildReadTool(): ToolDefinition<typeof readSchema> {
    return {
      name: READ_TOOL_NAME,
      description: READ_DESCRIPTION,
      inputSchema: readSchema,
      execute: async (input: ReadInput, _signal: AbortSignal | undefined, context: ExtensionContext) => {
        const taskId = typeof input.taskId === "string" && input.taskId.trim().length > 0 ? input.taskId.trim() : undefined;
        let projectId: string;
        let resolvedId: string;
        if (taskId !== undefined) {
          let project;
          try {
            project = context.getProjectContext();
          } catch (error) {
            throw new Error(
              `auto-context-handover: no project context to resolve task ${taskId}, refusing to act: ${(error as Error).message}`,
            );
          }
          const target = project.getTask(taskId);
          if (!target) {
            throw new Error(
              `auto-context-handover: task ${taskId} is not loaded in the current project, refusing to read arbitrary state`,
            );
          }
          const baseDir = (project as { baseDir?: unknown }).baseDir;
          projectId = typeof baseDir === "string" && baseDir ? baseDir : projectIdentity(context, target);
          resolvedId = target.data.id;
        } else {
          const task = context.getTaskContext();
          if (!task) {
            throw new Error(`auto-context-handover: no task context for the read call, refusing to act`);
          }
          projectId = projectIdentity(context, task);
          resolvedId = task.data.id;
        }
        if (!projectId) {
          throw new Error(`auto-context-handover: no project identity for task ${resolvedId}, refusing to act`);
        }
        const read = await readJsonFile(handoverFile(projectId, resolvedId)).catch((error: unknown) => {
          throw new Error(
            `auto-context-handover: cannot read the stored handover for task ${resolvedId}: ${(error as Error).message}`,
          );
        });
        if (!read.found) {
          return `No handover stored for task ${resolvedId} yet. There is no automatic successor; store a handover first, then continue manually.`;
        }
        const stored = read.invalid ? undefined : asStoredHandover(read.data);
        if (!stored) {
          return (
            `The latest stored handover entry for task ${resolvedId} is invalid; refusing to fall back to anything older. ` +
            `The immutable entry cannot be replaced by another tool call; inspect the stored handover file for recovery.`
          );
        }
        const header = `Handover from task ${stored.sourceTaskId} (model ${stored.provider}/${stored.model}):`;
        return `${header}\n${formatDiagLine(stored.diag)}\n${manualContinuationHint(stored.sourceTaskId)}\n\n${stored.handover}`;
      },
    };
  }

  // Trusted per-run introduction. The host sends the returned context
  // messages to the agent; this handler only authors the notice and never
  // rewrites the system prompt.
  async onAgentStarted(
    event: AgentStartedEvent,
    _context: ExtensionContext,
  ): Promise<Partial<AgentStartedEvent> | undefined> {
    if (!isRootAgent(event.mode, event.agentProfile)) return undefined;
    const taskId = _context.getTaskContext()?.data.id;
    if (taskId !== undefined && event.agentProfile) {
      const provider = typeof event.agentProfile.provider === "string" ? event.agentProfile.provider : "unknown";
      const model = typeof event.agentProfile.model === "string" ? event.agentProfile.model : "unknown";
      this.agentByTask.set(taskId, { provider, model });
    }
    return { contextMessages: [...event.contextMessages, userMessage(INTRO_TEXT)] };
  }

  // Transient stage notice at the END of the step messages. The input array
  // is never mutated and nothing is persisted: the notice applies to this
  // step only.
  async onAgentStepStarted(
    event: AgentStepStartedEvent,
    context: ExtensionContext,
  ): Promise<Partial<AgentStepStartedEvent> | undefined> {
    try {
      if (!isRootAgent(event.mode, event.agentProfile)) return undefined;
      const task = context.getTaskContext();
      if (!task) return undefined;
      const taskId = task.data.id;
      let estimate: DiagValue = "unknown";
      try {
        const tokens = await task.getEstimatedTokens();
        if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
          estimate = Math.floor(tokens);
        }
      } catch {
        // Zero or errored estimates fail open to unknown.
      }
      let window: number | undefined;
      try {
        const models = await context.getModelConfigs();
        const found = Array.isArray(models)
          ? models.find((model) => model.providerId === event.agentProfile.provider && model.id === event.agentProfile.model)
          : undefined;
        const maxInput = found?.maxInputTokens;
        if (typeof maxInput === "number" && Number.isFinite(maxInput) && maxInput > 0) {
          window = Math.floor(maxInput);
        }
      } catch {
        // Unavailable model configs fail open to unknown.
      }
      const soft = this.softSpec ? resolveSoftTokens(this.softSpec, window) : undefined;
      const stage = estimate !== "unknown" && soft !== undefined ? softStage(estimate, soft) : "unknown";
      this.diagByTask.set(taskId, { stage, estimate, soft: soft ?? "unknown" });
      if (stage === "ok" || stage === "unknown") return undefined;
      const notice = `${openCodeStageText(stage)}${NOTICE_SUFFIX}`;
      return { messages: [...event.messages, userMessage(notice)] };
    } catch {
      // Fail open: measurement or host trouble never touches the step.
      return undefined;
    }
  }

  async onTaskClosed(event: TaskClosedEvent, _context: ExtensionContext): Promise<void> {
    void _context;
    const taskId = event.task.id;
    this.diagByTask.delete(taskId);
    this.agentByTask.delete(taskId);
  }
}
