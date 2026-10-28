// auto-context-handover: Cline SDK root-only advisory plugin (MVP, no build step).
// Root sessions only: measured soft-limit advisories, a model-written
// handover kept in dedicated file storage, and manual continuation via
// read_handover. No subagent integration, no automatic rollover, no hard
// gate, no lock, no task creation, no quota/TTL/eviction. The host request
// objects are never mutated; hook output is transient per-request text.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, link, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentPlugin, BasicLogger } from "@cline/sdk";
import {
  HANDOVER_SECTIONS,
  SEED_FRAMING,
  formatDiagLine,
  openCodeStageText,
  softStage,
} from "../source/shared/handover-text.ts";
import { seedTooLarge } from "../source/shared/seed-size.ts";

export const PLUGIN_NAME = "auto-context-handover";
export const TOOL_NAME = "context_handover";
export const READ_TOOL_NAME = "read_handover";
export const ENV_SOFT = "AUTO_CONTEXT_HANDOVER_SOFT";
export const DEFAULT_SOFT = 150000;
const STORAGE_LEAF = join(".cline", "auto-context-handover");
const STORAGE_FILE = "handover.json";

// The shared six-section text carries one paragraph claiming an
// authoritative parent/agent/model/chain plugin record. The Cline entry keeps
// the sections unchanged apart from that paragraph: the only recorded
// provenance is the source session/agent id, and the effective model is
// unknown (hooks never see model identity or options as a window contract).
const SHARED_PROVENANCE_PARAGRAPH =
  "Do not describe your own agent type, model (including override), or chain; the plugin records authoritative provenance and the parent uses the plugin record even if this handover says otherwise.";
const CLINE_PROVENANCE_PARAGRAPH =
  "The stored entry's recorded source session id and agent id are the authoritative provenance; " +
  "the effective model is unknown, no model override is recorded, and there is no child chain. " +
  "Do not restate your own model identity; write the handover from the task content.";
const CLINE_HANDOVER_SECTIONS = (() => {
  if (!HANDOVER_SECTIONS.includes(SHARED_PROVENANCE_PARAGRAPH)) {
    throw new Error("auto-context-handover: shared handover text drifted, refusing to register with stale provenance wording");
  }
  return HANDOVER_SECTIONS.replace(SHARED_PROVENANCE_PARAGRAPH, CLINE_PROVENANCE_PARAGRAPH);
})();

// Minimal structural view of the host objects this plugin touches. These are
// intentionally narrower than the real SDK types (fewer required fields) so
// the plugin stays decoupled at runtime; the `AgentPlugin` annotation on the
// factory result verifies assignability against the real SDK types.
export interface ClineHandoverSnapshot {
  readonly agentId: string;
  readonly parentAgentId?: string | null;
  readonly conversationId?: string;
  readonly runId?: string;
  readonly iteration: number;
}

export interface ClineHandoverToolContext {
  readonly sessionId?: string;
  readonly agentId: string;
  readonly conversationId?: string;
  readonly runId?: string;
  readonly iteration: number;
  readonly snapshot?: ClineHandoverSnapshot;
  readonly cwd?: string;
}

export interface ClineHandoverTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly execute: (input: unknown, context: ClineHandoverToolContext) => Promise<string> | string;
}

export interface ClineHandoverApi {
  registerTool: (tool: ClineHandoverTool) => void;
}

export interface ClineHandoverSetupContext {
  readonly session?: { readonly sessionId?: string };
  readonly cwd?: string;
  readonly logger?: BasicLogger;
  readonly onDispose?: (cleanup: () => void | Promise<void>) => void;
}

export interface ClineModelRequest {
  readonly systemPrompt?: string;
  readonly messages: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly modelTools?: readonly unknown[];
}

export interface ClineNoticeMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly createdAt: number;
}

export interface ClineHandoverOptions {
  /** Storage root override (tests). Defaults to ~/.cline/auto-context-handover. */
  readonly dir?: string;
  /** Explicit soft limit override (tests). Undefined means read the env. */
  readonly soft?: number | undefined;
  /** Env source override (tests). Defaults to process.env. */
  readonly env?: Record<string, string | undefined>;
  /** Setup session binding override (tests). Defaults to setup ctx session id. */
  readonly sourceSessionId?: string | undefined;
  readonly now?: () => number;
}

type DiagValue = number | "unknown";

interface CallDiag {
  readonly reason: string;
  readonly stage: string;
  readonly estimate: DiagValue;
  readonly soft: DiagValue;
}

interface RootEntry {
  readonly snapshot: ClineHandoverSnapshot;
  readonly diag: CallDiag;
}

const TOOL_DESCRIPTION =
  `Call this tool only after an auto-context-handover advisory notice appears, or when the user explicitly asks for a handover. ` +
  `Do not call it just to finish a task; give a normal final response instead. ` +
  `Once the notice appears (or the user asks), call exactly once per unit of work when done, then end your turn. ` +
  `Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never summarized or reworded) ` +
  `plus a short status/outcome/next-step summary in "summary".\n\n` +
  `${CLINE_HANDOVER_SECTIONS}\n\n` +
  `The first successful call wins: a later call for the same session is rejected and the original is preserved. ` +
  `Do not paste secrets. Continuation is manual: start a fresh session and call read_handover with the source session id. ` +
  `Nothing rolls over automatically.`;

const READ_DESCRIPTION =
  `Read a stored context handover by source session id. ` +
  `Takes a "sessionID" argument naming any retained source session; paths are never accepted. ` +
  `Returns the verbatim stored text plus recorded source session/agent metadata, pre-call diagnostics, and manual-continuation guidance. ` +
  `Reports plainly when nothing is stored or when the stored entry is unreadable. ` +
  `It never creates sessions and never triggers rollover.`;

const INTRO_TEXT =
  `auto-context-handover is active for this root session. ` +
  `Soft-limit advisories may follow; each advisory applies to the current step only: ` +
  `it replaces any required final report or current-step wrap-up instruction for that step, not the whole task. ` +
  `When an advisory appears, finish the current step, then call the context_handover tool with the full handover text; ` +
  `the tool writes only plugin storage, so read-only task instructions still allow the call. ` +
  `Continuation is manual: start a fresh session and call read_handover with the source session id from the handover confirmation. ` +
  `Nothing rolls over automatically.`;

// Stable per-stage notice suffix. No live numbers: the text is identical on
// every request that observes the same stage.
const NOTICE_SUFFIX =
  ` This advisory applies to the current step only: it replaces any required final report or current-step wrap-up for this step, ` +
  `not the whole task (see the session intro message for the full workflow). ` +
  `The context estimate is a heuristic (serialized request chars/4), not an exact token count or accumulated usage. ` +
  `When done with this step, call the context_handover tool with the full handover text ` +
  `(plugin-storage write only, allowed under read-only instructions); continuation is manual in a fresh session via read_handover.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Integer-only env parsing. No percent support: the hooks expose no model-window contract. */
export function parseClineSoftEnv(raw: string | undefined): { readonly soft?: number; readonly error?: string } {
  if (raw === undefined) return { soft: DEFAULT_SOFT };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      error: `${ENV_SOFT} must be a positive integer of tokens, got ${JSON.stringify(raw)}; percentages are not supported`,
    };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return {
      error: `${ENV_SOFT} must be a positive integer of tokens, got ${JSON.stringify(raw)}`,
    };
  }
  return { soft: value };
}

function logSetupError(logger: BasicLogger | undefined, detail: string): void {
  const full =
    `auto-context-handover: ${detail}. ` +
    `Handover advisories are disabled until it is fixed (default ${DEFAULT_SOFT}); the handover tools still work.`;
  try {
    if (logger?.error !== undefined) logger.error(full);
    else if (logger?.log !== undefined) logger.log(full);
    else console.error(full);
  } catch {
    try {
      console.error(full);
    } catch {
      // Best-effort logging only.
    }
  }
}

/**
 * Heuristic full-request estimate: JSON chars/4 over systemPrompt, messages,
 * tools, and modelTools. Options and signal are excluded. Serialization
 * trouble fails open to unknown.
 */
function estimateRequestHeuristic(request: ClineModelRequest): DiagValue {
  try {
    const scoped = {
      systemPrompt: request.systemPrompt,
      messages: request.messages,
      tools: request.tools,
      modelTools: request.modelTools,
    };
    const rendered = JSON.stringify(scoped);
    if (typeof rendered !== "string") return "unknown";
    return Math.ceil(rendered.length / 4);
  } catch {
    return "unknown";
  }
}

const sessionDir = (storageDir: string, sourceSessionId: string): string =>
  join(storageDir, createHash("sha256").update(sourceSessionId, "utf8").digest("hex"));

export function createClineHandoverPlugin(options: ClineHandoverOptions = {}): AgentPlugin {
  const now = options.now ?? Date.now;
  // Latest root entry per agent id, replaced on each new run so stale runs
  // can neither authorize writes nor supply diagnostics.
  const latestByAgent = new Map<string, Map<string, RootEntry>>();
  let setupDone = false;
  let soft: number | undefined;
  let storageDir = "";
  let boundSessionId: string | undefined;

  const runKey = (runId: string | undefined): string => runId ?? "";
  const entryFor = (agentId: string, runId: string | undefined): RootEntry | undefined =>
    latestByAgent.get(agentId)?.get(runKey(runId));

  const beforeRun = (
    context: { readonly snapshot: ClineHandoverSnapshot },
  ): { readonly appendContext: string } | undefined => {
    if (!setupDone) return undefined;
    const snapshot = context.snapshot;
    if (!snapshot || snapshot.parentAgentId != null) return undefined;
    // Reset this agent's runs: only the run starting now stays addressable.
    latestByAgent.set(snapshot.agentId, new Map([
      [runKey(snapshot.runId), {
        snapshot,
        diag: { reason: "unknown", stage: "unknown", estimate: "unknown", soft: soft ?? "unknown" },
      }],
    ]));
    return { appendContext: INTRO_TEXT };
  };

  const beforeModel = (
    context: { readonly snapshot: ClineHandoverSnapshot; readonly request: ClineModelRequest },
  ): { readonly messages: readonly ClineNoticeMessage[] } | undefined => {
    if (!setupDone) return undefined;
    const snapshot = context.snapshot;
    if (!snapshot || snapshot.parentAgentId != null) return undefined;
    const estimate = estimateRequestHeuristic(context.request);
    const stage = estimate === "unknown" || soft === undefined ? "unknown" : softStage(estimate, soft);
    const diag: CallDiag = {
      reason: stage === "unknown" ? "unknown" : stage === "ok" ? "not-nudged" : "nudged",
      stage,
      estimate,
      soft: soft ?? "unknown",
    };
    let runs = latestByAgent.get(snapshot.agentId);
    if (!runs) {
      runs = new Map();
      latestByAgent.set(snapshot.agentId, runs);
    }
    runs.set(runKey(snapshot.runId), { snapshot, diag });
    if (stage === "ok" || stage === "unknown") return undefined;
    const notice: ClineNoticeMessage = {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: `${openCodeStageText(stage)}${NOTICE_SUFFIX}` }],
      createdAt: now(),
    };
    // Transient replacement: the input array is never mutated, no element is
    // modified, and the system prompt is never rewritten. The runtime may
    // clone values across the plugin boundary, so the hook promises a new
    // array, not preserved object identity. The local request type is
    // intentionally opaque, hence the assertion on the assembled array only.
    const messages = [...context.request.messages, notice] as ClineNoticeMessage[];
    return { messages };
  };

  const setup = (api: ClineHandoverApi, ctx: ClineHandoverSetupContext): void => {
    // One instance per session: a second setup would rebind storage identity
    // while hook-observed runs from the first session stay addressable, so
    // refuse before mutating anything or registering.
    if (setupDone) {
      throw new Error(
        `auto-context-handover: this plugin instance is already set up for session ${JSON.stringify(boundSessionId)}; one instance per session - create a new instance instead of setting up the same one again`,
      );
    }
    if (options.soft !== undefined) {
      if (Number.isInteger(options.soft) && options.soft > 0) {
        soft = options.soft;
      } else {
        soft = undefined;
        logSetupError(ctx.logger, `invalid explicit soft limit ${JSON.stringify(options.soft)}: must be a positive integer of tokens`);
      }
    } else {
      // A provided env object is authoritative: no process.env fallback.
      const envSource = options.env ?? process.env;
      const parsed = parseClineSoftEnv(envSource[ENV_SOFT]);
      if (parsed.error !== undefined) {
        soft = undefined;
        logSetupError(ctx.logger, `invalid ${parsed.error}`);
      } else {
        soft = parsed.soft;
      }
    }
    storageDir = options.dir ?? join(homedir(), STORAGE_LEAF);
    boundSessionId = options.sourceSessionId ?? ctx.session?.sessionId;

    const writer: ClineHandoverTool = {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          handover: { type: "string", description: "Full handover text, stored verbatim." },
          summary: { type: "string", description: "Short status/outcome/next-step summary." },
        },
        required: ["handover", "summary"],
        additionalProperties: false,
      },
      execute: async (input: unknown, context: ClineHandoverToolContext): Promise<string> => {
        const params = isRecord(input) ? input : {};
        const handover = typeof params.handover === "string" ? params.handover : "";
        const summary = typeof params.summary === "string" ? params.summary : "";
        if (handover.trim().length === 0) {
          throw new Error(`auto-context-handover: "handover" must be the full handover text, verbatim and non-empty`);
        }
        if (summary.trim().length === 0) {
          throw new Error(`auto-context-handover: "summary" must be a short status/outcome/next-step summary, non-empty`);
        }
        const bound = boundSessionId;
        if (bound === undefined) {
          throw new Error(
            `auto-context-handover: refusing to store: no stable setup session id is bound (the host provided none at plugin setup)`,
          );
        }
        const snapshot = context.snapshot;
        if (!snapshot || snapshot.parentAgentId != null) {
          throw new Error(
            `auto-context-handover: refusing to store: a root-session snapshot is required; child sessions and unattributed calls are never authorized to write`,
          );
        }
        if (context.agentId !== snapshot.agentId) {
          throw new Error(
            `auto-context-handover: refusing to store: the tool caller identity does not match the root snapshot`,
          );
        }
        const entry = entryFor(snapshot.agentId, snapshot.runId);
        if (!entry) {
          throw new Error(
            `auto-context-handover: refusing to store: no observed root run for this agent/run; calls must follow the session's own beforeRun/beforeModel hooks`,
          );
        }
        const dir = sessionDir(storageDir, bound);
        const payload = JSON.stringify({
          version: 1,
          handover,
          summary,
          sourceSessionId: bound,
          agentId: snapshot.agentId,
          storedAt: now(),
          diag: entry.diag,
        });
        if (typeof payload !== "string") {
          throw new Error(`auto-context-handover: failed to serialize handover, nothing was handed over`);
        }
        try {
          await mkdir(dir, { recursive: true, mode: 0o700 });
        } catch (error) {
          throw new Error(
            `auto-context-handover: failed to prepare storage, nothing was handed over: ${(error as Error).message}`,
          );
        }
        const target = join(dir, STORAGE_FILE);
        const tmp = join(dir, `tmp-${process.pid}-${randomUUID()}.json`);
        try {
          await writeFile(tmp, payload, { mode: 0o600 });
        } catch (error) {
          throw new Error(
            `auto-context-handover: failed to store handover, nothing was handed over: ${(error as Error).message}`,
          );
        }
        try {
          // Atomic first-winner publication: link fails with EEXIST when a
          // handover is already stored, so duplicates never overwrite.
          await link(tmp, target);
        } catch (error) {
          await unlink(tmp).catch(() => undefined);
          if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
            throw new Error(
              `auto-context-handover: a handover is already stored for session ${JSON.stringify(bound)}; refusing to overwrite, the original is preserved`,
            );
          }
          throw new Error(
            `auto-context-handover: failed to publish handover, nothing was handed over: ${(error as Error).message}`,
          );
        }
        await unlink(tmp).catch(() => undefined);
        return (
          `Handover stored for session ${bound}. End your turn now. ` +
          `${formatDiagLine(entry.diag)} ` +
          `To continue manually, start a fresh Cline session and call read_handover with sessionID ${JSON.stringify(bound)}, ` +
          `then continue from 'Prioritized next steps'. No automatic rollover was triggered.`
        );
      },
    };

    const reader: ClineHandoverTool = {
      name: READ_TOOL_NAME,
      description: READ_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          sessionID: { type: "string", description: "Retained source session id to read." },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      execute: async (input: unknown): Promise<string> => {
        const params = isRecord(input) ? input : {};
        const sessionID = typeof params.sessionID === "string" ? params.sessionID : "";
        if (sessionID.trim().length === 0) {
          throw new Error(
            `auto-context-handover: "sessionID" must be a retained source session id (non-empty string); paths are never accepted`,
          );
        }
        const dir = sessionDir(storageDir, sessionID);
        const target = join(dir, STORAGE_FILE);
        let raw: string;
        try {
          raw = await readFile(target, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            return `No handover stored for session ${JSON.stringify(sessionID)} yet.`;
          }
          throw new Error(
            `auto-context-handover: the stored handover for session ${JSON.stringify(sessionID)} is unreadable: ${(error as Error).message}`,
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(
            `auto-context-handover: the stored handover for session ${JSON.stringify(sessionID)} is corrupt; refusing to replay it. ` +
            `The first stored handover is immutable, so writing again cannot replace it. ` +
            `Manual recovery requires inspecting storage at ${JSON.stringify(dir)}; no overwrite was attempted. ` +
            `Continue in a fresh session if the source text is unavailable.`,
          );
        }
        if (
          !isRecord(parsed) ||
          typeof parsed.handover !== "string" ||
          typeof parsed.summary !== "string" ||
          parsed.handover.trim().length === 0
        ) {
          throw new Error(
            `auto-context-handover: the stored handover for session ${JSON.stringify(sessionID)} is invalid; refusing to replay it. ` +
            `The first stored handover is immutable, so writing again cannot replace it. ` +
            `Manual recovery requires inspecting storage at ${JSON.stringify(dir)}; no overwrite was attempted. ` +
            `Continue in a fresh session if the source text is unavailable.`,
          );
        }
        const handoverText: string = parsed.handover as string;
        const agentId = typeof parsed.agentId === "string" && parsed.agentId.length > 0 ? parsed.agentId : "unknown";
        const storedAt = typeof parsed.storedAt === "number" && Number.isFinite(parsed.storedAt)
          ? new Date(parsed.storedAt).toISOString()
          : "unknown";
        const diag = isRecord(parsed.diag) ? parsed.diag : undefined;
        const header = `Handover from session ${sessionID} (agent ${agentId}, stored ${storedAt}):`;
        let text =
          `${header}\n` +
          `${formatDiagLine({ reason: diag?.reason, stage: diag?.stage, estimate: diag?.estimate, soft: diag?.soft })}\n\n` +
          `${handoverText}\n\n` +
          `${SEED_FRAMING} ` +
          `To continue manually, start a fresh Cline session and call read_handover with sessionID ${JSON.stringify(sessionID)}, ` +
          `then continue from 'Prioritized next steps'. Nothing rolls over automatically.`;
        const softRaw = diag?.soft;
        const softNum = typeof softRaw === "number" ? softRaw : undefined;
        // The boundary applies to the stored handover alone, not the reader
        // reply around it, so a long header can never inflate the verdict.
        if (softNum !== undefined && seedTooLarge(Math.ceil(handoverText.length / 4), softNum)) {
          text +=
            ` Warning: the stored handover text alone is over 50% of the soft threshold; a fresh session seeded with it starts close to the limit. ` +
            `At the next handover, compress carried-over completed notes while preserving critical instructions, unresolved risks and verification distinctions.`;
        }
        return text;
      },
    };

    api.registerTool(writer);
    api.registerTool(reader);
    ctx.onDispose?.(() => {
      latestByAgent.clear();
    });
    setupDone = true;
  };

  const plugin: AgentPlugin = {
    name: PLUGIN_NAME,
    manifest: { capabilities: ["tools", "hooks"] },
    setup,
    hooks: { beforeRun, beforeModel },
  };
  return plugin;
}

const defaultPlugin: AgentPlugin = createClineHandoverPlugin();
export default defaultPlugin;
