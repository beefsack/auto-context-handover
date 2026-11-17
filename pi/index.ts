// Pi extension: automatic root continuation and parent-directed child handback.
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, chmod, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { parseThreshold, type ThresholdSpec } from "../source/shared/threshold.ts";
import { resolveSoftTokens } from "../source/measure.ts";
import {
  HANDOVER_SECTIONS,
  SEED_FRAMING,
  formatDiagLine,
  openCodeStageText,
  softStage,
} from "../source/shared/handover-text.ts";
import { seedTooLarge } from "../source/shared/seed-size.ts";

const TOOL_NAME = "context_handover";
const READ_TOOL_NAME = "read_handover";
const COMMAND_NAME = "handover";
const FLAG_NAME = "handover-soft";

// Extension-storage entry types. The handover payload type is the only one
// the tool and command ever read back; seed metadata and the per-turn intro
// use distinct types so recovery can never mistake them for a handover.
const ENTRY_TYPE = "auto-context-handover";
const META_TYPE = "auto-context-handover:seed";
const INTRO_TYPE = "auto-context-handover:intro";
const RESTORE_TYPE = "auto-context-handover:restore";

// UI mode and parentSession are not child identity: SDK sessions can have
// either UI mode, and root successors also have parentSession. pi-subagents
// supplies the active_agent tag in both prompt modes, including memory-only
// children. Other child runtimes must supply that tag or the background flag.
function isChild(ctx: ExtensionContext, prompt = ctx.getSystemPrompt()): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1" || /<active_agent\s+name="[^"]*"\s*\/>/.test(prompt);
}

const storePath = (sessionID: string): string =>
  join(getAgentDir(), "auto-context-handover", `${createHash("sha256").update(sessionID).digest("hex")}.json`);

async function readShared(sessionID: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(storePath(sessionID), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || data.sessionId !== sessionID || typeof data.handover !== "string" ||
      typeof data.summary !== "string" || typeof data.closed !== "boolean") throw new Error("invalid shared handover record");
  return data;
}

async function writeShared(sessionID: string, data: Record<string, unknown>): Promise<void> {
  const directory = join(getAgentDir(), "auto-context-handover");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = storePath(sessionID);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function childReply(summary: string, sessionID: string): string {
  const reader = `read_handover({"sessionID":${JSON.stringify(sessionID)}})`;
  return `Context handover (incomplete): ${summary}\nPredecessor session: ${sessionID}.\n` +
    `Parent: read the full handover with ${reader}. Spawn a replacement of the same agent type with your original steering/model choices; ` +
    `tell it to call ${reader} and continue from "Prioritized next steps". Do not paste the full handover into its prompt. ` +
    `The successor replaces this predecessor as the same logical subagent, not an additional agent under subagent-count limits. ` +
    `Check in with the user if progress stalls or remaining work grows.`;
}

const childDirective = (data: Record<string, unknown>): string =>
  `Handover stored; do no further work or tool calls. End your turn now with exactly the following text as your final message and then stop.\n\n` +
  childReply(String(data.summary), String(data.sessionId));

const DEFAULT_SOFT = 200000;

type DiagValue = number | "unknown";

interface CallDiag {
  readonly stage: string;
  readonly estimate: DiagValue;
  readonly soft: DiagValue;
}

// In-memory only: a reload never replays a handover stored in a past session.
// The request is scoped to the storing run/session/branch and consumed once.
interface PendingRoll {
  readonly run: number;
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly handoverEntryId: string | undefined;
}

const recoveryHint = (sessionId: string): string =>
  `The handover stays stored in session ${sessionId}; run /handover from that session to continue manually.`;

function reportHostError(ctx: ExtensionContext, message: string, cause?: unknown): void {
  try {
    ctx.ui.notify(message, "error");
  } catch (notifyError) {
    throw new Error(`${message} (notification failed: ${(notifyError as Error).message})`, {
      cause: cause ?? notifyError,
    });
  }
}

interface StoredHandover {
  readonly handover: string;
  readonly summary: string;
  readonly sessionId: string;
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
// authoritative parent/agent/model/chain plugin record. The Pi entry keeps
// the sections unchanged apart from that paragraph: the plugin-recorded
// source session id and effective model are authoritative host data.
const SHARED_PROVENANCE_PARAGRAPH =
  "Do not describe your own agent type, model (including override), or chain; the plugin records authoritative provenance and the parent uses the plugin record even if this handover says otherwise.";
const PI_PROVENANCE_PARAGRAPH =
  "The stored entry's source session id and effective model are the authoritative provenance; " +
  "unknown values are unknown, and no model override or child chain is recorded. " +
  "Do not restate your own agent or model identity; write the handover from the task content.";
const PI_HANDOVER_SECTIONS = (() => {
  if (!HANDOVER_SECTIONS.includes(SHARED_PROVENANCE_PARAGRAPH)) {
    throw new Error("auto-context-handover: shared handover text drifted, refusing to register with stale provenance wording");
  }
  return HANDOVER_SECTIONS.replace(SHARED_PROVENANCE_PARAGRAPH, PI_PROVENANCE_PARAGRAPH);
})();

const TOOL_DESCRIPTION =
  `Call this tool only after an auto-context-handover advisory notice appears, or when the user explicitly asks for a handover. ` +
  `Do not call it just to finish a task; give a normal final response instead. ` +
  `Once the notice appears (or the user asks), call exactly once per unit of work when done, then end your turn. ` +
  `Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never summarized or reworded) ` +
  `plus a short status/outcome/next-step summary in "summary".\n\n` +
  `${PI_HANDOVER_SECTIONS}\n\n` +
  `For child sessions, storage closes this session to further tools: emit the exact final continuation reply from the tool result so the parent can read and replace you manually. Never create your own successor. ` +
  `For top-level sessions, once stored, end your turn: a fresh session is opened automatically after this turn settles, seeded from this text, ` +
  `and a continuation prompt is sent there. If that does not happen, the user can run /handover instead. ` +
  `Calling this tool again later after resumed work replaces the stored handover. Do not paste secrets.`;

const READ_DESCRIPTION =
  `Read a retained handover by sessionID, including a predecessor child or another session. ` +
  `Omit sessionID to read the current session branch (legacy compatibility). No filesystem paths are accepted. ` +
  `Returns the verbatim stored text plus a diagnostics header, or a plain notice when nothing is stored yet.`;

const CHILD_INTRO =
  `auto-context-handover is active for this child session. When a soft-limit advisory appears, finish the current step, ` +
  `then call context_handover with the full handover and short summary. This replaces any required final report for this session; ` +
  `the private extension-storage write is allowed under read-only instructions. After storage, do no more work: ` +
  `return the exact final continuation reply supplied by the tool so the parent can read your handover and spawn a replacement with steering. ` +
  `Children never roll over automatically; do not run /handover or create sessions.`;

const INTRO_TEXT =
  `auto-context-handover is active for this root session. ` +
  `Soft-limit advisories may follow; each advisory applies to the current step only: ` +
  `it replaces any required final report or current-step wrap-up instruction for that step, not the whole task. ` +
  `When an advisory appears, finish the current step, then call the context_handover tool with the full handover text; ` +
  `the tool writes only extension storage, so read-only task instructions still allow the call. ` +
  `After you store a handover and end your turn, continuation is automatic: the session rolls over into a fresh ` +
  `session seeded from the stored handover. /handover remains available as a manual fallback if automatic rollover fails.`;

// Stable per-stage notice suffix. No live numbers: the text is identical on
// every request that observes the same stage.
const NOTICE_SUFFIX =
  ` This advisory applies to the current step only: it replaces any required final report or current-step wrap-up for this step, ` +
  `not the whole task (see the auto-context-handover intro message for the full workflow). ` +
  `When done with this step, call the context_handover tool with the full handover text ` +
  `(extension-storage write only, allowed under read-only instructions); rollover follows automatically once the turn settles, ` +
  `with /handover as the fallback.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asDiagValue = (value: unknown): DiagValue =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : "unknown";

/** Latest handover payload on the ACTIVE branch. Never consults other branches. */
type HandoverLookup =
  | { readonly found: true; readonly stored: StoredHandover }
  | { readonly found: false; readonly invalidLatest: boolean };

function latestHandover(branch: ReadonlyArray<Record<string, unknown>>): HandoverLookup {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!entry || entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data;
    if (!isRecord(data) || typeof data.handover !== "string" || typeof data.summary !== "string") {
      // The newest matching entry is malformed: report it instead of
      // silently replaying an older handover.
      return { found: false, invalidLatest: true };
    }
    const model = isRecord(data.model) ? data.model : {};
    const diag = isRecord(data.diag) ? data.diag : {};
    return {
      found: true,
      stored: {
        handover: data.handover,
        summary: data.summary,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : "unknown",
        provider: typeof model.provider === "string" ? model.provider : "unknown",
        model: typeof model.id === "string" ? model.id : "unknown",
        storedAt: typeof data.storedAt === "number" ? data.storedAt : 0,
        diag: {
          reason: typeof diag.reason === "string" && diag.reason.length > 0 ? diag.reason : "unknown",
          stage: typeof diag.stage === "string" && diag.stage.length > 0 ? diag.stage : "unknown",
          estimate: asDiagValue(diag.estimate),
          soft: asDiagValue(diag.soft),
        },
      },
    };
  }
  return { found: false, invalidLatest: false };
}

/** Host usage estimate. Unknown or malformed usage fails open to unknown. */
function readEstimate(ctx: ExtensionContext): { readonly estimate: DiagValue; readonly window: number | undefined } {
  let usage: unknown;
  try {
    usage = ctx.getContextUsage();
  } catch {
    return { estimate: "unknown", window: undefined };
  }
  if (!isRecord(usage)) return { estimate: "unknown", window: undefined };
  const window =
    typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
      ? Math.floor(usage.contextWindow)
      : undefined;
  const tokens = usage.tokens;
  const estimate =
    typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? Math.floor(tokens) : "unknown";
  return { estimate, window };
}

/**
 * Resolve the soft threshold. Integer values cap at 70% of a known window;
 * explicit percentages apply uncapped; an unknown window leaves numerics
 * uncapped and percentages unresolved (fail open). An invalid flag value
 * resolves to undefined: the context hook then stays silent instead of
 * substituting another threshold, and session_start reports the bad value.
 */
function flagSpec(rawFlag: unknown): { readonly spec?: ThresholdSpec; readonly error?: string } {
  // CLI flags arrive as strings, so a digit-only string is the integer-token
  // form; everything else goes to the shared parser untouched.
  const normalized =
    typeof rawFlag === "string" && /^\d+$/.test(rawFlag.trim()) ? Number(rawFlag.trim()) : rawFlag;
  try {
    return { spec: parseThreshold(normalized === undefined ? DEFAULT_SOFT : normalized) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function resolveSoft(rawFlag: unknown, window: number | undefined): number | undefined {
  const { spec } = flagSpec(rawFlag);
  if (!spec) return undefined;
  return resolveSoftTokens(spec, window);
}

export default function (pi: ExtensionAPI): void {
  // Latest observed estimate per session id. Lost on extension reload, so a
  // tool call after reload honestly reports unknown diagnostics.
  const diagBySession = new Map<string, CallDiag>();
  let run = 0;
  let pending: PendingRoll | undefined;
  const restoreAttempts = new Set<string>();
  const warnedStorage = new Set<string>();

  async function readOwnState(ctx: ExtensionContext): Promise<Record<string, unknown> | undefined> {
    const sessionID = ctx.sessionManager.getSessionId();
    try {
      return await readShared(sessionID);
    } catch (error) {
      // A retained branch closure remains authoritative if its shared copy
      // cannot be read. Otherwise storage damage must not brick an open root.
      try {
        const closed = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" &&
          entry.customType === ENTRY_TYPE && isRecord(entry.data) && entry.data.sessionId === sessionID && entry.data.closed === true);
        if (closed?.type === "custom" && isRecord(closed.data)) return closed.data;
      } catch {
        // A broken branch must not turn unrelated root tools into a hard gate.
      }
      if (isChild(ctx)) throw error;
      if (!warnedStorage.has(sessionID)) {
        warnedStorage.add(sessionID);
        try {
          ctx.ui.notify(`auto-context-handover: cannot read shared completion state; root tools remain available and /handover can recover the branch handover. ${(error as Error).message}`, "warning");
        } catch {
          // Recovery must not depend on a working UI notification.
        }
      }
      return undefined;
    }
  }

  pi.on("tool_call", async (_event, ctx) => {
    try {
      const stored = await readOwnState(ctx);
      if (stored?.closed === true) return { block: true, reason: childDirective(stored) };
    } catch (error) {
      return { block: true, reason: `auto-context-handover: cannot verify session completion state: ${(error as Error).message}` };
    }
  });

  pi.on("agent_start", () => {
    run += 1;
  });

  pi.registerFlag(FLAG_NAME, {
    description:
      "Soft context threshold for handover advisories: a positive token integer (capped at 70% of the context window) or a percent like 70% (uncapped). Default 200000.",
    type: "string",
    default: String(DEFAULT_SOFT),
  });

  // Trusted per-turn introduction. The host persists the returned custom
  // message into the session; this handler only authors it and never
  // rewrites the initial system prefix.
  pi.on("before_agent_start", async (event, ctx) => {
    const stored = await readOwnState(ctx);
    const content = stored?.closed === true ? childDirective(stored) :
      isChild(ctx, event.systemPrompt) ? CHILD_INTRO : INTRO_TEXT;
    return { message: { customType: INTRO_TYPE, content, display: false } };
  });

  // Explicit flag validation. An invalid value is reported here, once per
  // session start, so the silent context hook below never substitutes
  // another threshold. Pi surfaces the notification without crashing.
  pi.on("session_start", async (event, ctx) => {
    const sessionID = ctx.sessionManager.getSessionId();
    if (event.reason === "new" && !restoreAttempts.has(sessionID)) {
      const seed = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === META_TYPE);
      const data = seed?.type === "custom" && isRecord(seed.data) ? seed.data : undefined;
      const selection = data && isRecord(data.selection) ? data.selection : undefined;
      if (selection) {
        restoreAttempts.add(sessionID);
        try {
          const model = ctx.modelRegistry.find(String(selection.provider), String(selection.model));
          if (!model || !await pi.setModel(model)) throw new Error("predecessor model unavailable or not authenticated");
          const thinking = selection.thinking;
          if (thinking !== "off" && thinking !== "minimal" && thinking !== "low" && thinking !== "medium" && thinking !== "high" && thinking !== "xhigh") {
            throw new Error("invalid predecessor thinking level");
          }
          pi.setThinkingLevel(thinking);
          if (pi.getThinkingLevel() !== thinking || ctx.model?.provider !== selection.provider || ctx.model?.id !== selection.model) {
            throw new Error("predecessor model/thinking restoration did not stick");
          }
          pi.appendEntry(RESTORE_TYPE, { sourceSession: data?.sourceSession, selection });
        } catch (error) {
          reportHostError(ctx, `auto-context-handover: successor model/thinking restoration failed; continuation withheld. ${(error as Error).message}`, error);
        }
      }
    }
    const raw = pi.getFlag(FLAG_NAME);
    const { error } = flagSpec(raw);
    if (error === undefined) return;
    try {
      ctx.ui.notify(
        `auto-context-handover: invalid --${FLAG_NAME} value ${JSON.stringify(typeof raw === "string" ? raw : String(raw))}: ${error}. ` +
          `Handover advisories stay disabled until the flag is fixed (default ${DEFAULT_SOFT}).`,
        "error",
      );
    } catch {
      // Notification is best-effort.
    }
  });

  // Transient stage notice at the END of the request messages. The input
  // array is never mutated and nothing is persisted: the notice applies to
  // this request only.
  pi.on("context", async (event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const { estimate, window } = readEstimate(ctx);
      const soft = resolveSoft(pi.getFlag(FLAG_NAME), window);
      const stage = estimate !== "unknown" && soft !== undefined ? softStage(estimate, soft) : "unknown";
      diagBySession.set(sessionId, { stage, estimate, soft: soft ?? "unknown" });
      if (stage === "ok" || stage === "unknown") return;
      const stored = await readOwnState(ctx);
      const notice = stored?.closed === true ? childDirective(stored) :
        `${openCodeStageText(stage)}${isChild(ctx) ? ` ${CHILD_INTRO}` : NOTICE_SUFFIX}`;
      return { messages: [...event.messages, { role: "user", content: notice, timestamp: Date.now() }] };
    } catch {
      // Fail open: measurement or host trouble never touches the request.
      return;
    }
  });

  // A pending rollover belongs to one run on one branch. Switching,
  // forking or navigating away drops it; the stored text is untouched.
  pi.on("session_before_switch", () => {
    pending = undefined;
  });
  pi.on("session_before_fork", () => {
    pending = undefined;
  });
  pi.on("session_before_tree", () => {
    pending = undefined;
  });

  pi.on("agent_settled", (event, ctx) => {
    const request = pending;
    pending = undefined;
    if (!request || event.aborted) return;
    try {
      if (
        request.run !== run ||
        ctx.sessionManager.getSessionId() !== request.sessionId ||
        ctx.sessionManager.getSessionFile() !== request.sessionFile ||
        request.handoverEntryId === undefined ||
        !ctx.sessionManager.getBranch().some((entry) => entry.id === request.handoverEntryId)
      ) {
        return;
      }
    } catch {
      // Cannot confirm the original branch: never replay on an unknown target.
      return;
    }
    try {
      pi.sendUserMessage(`/${COMMAND_NAME}`, { expandPromptTemplates: true });
    } catch (error) {
      reportHostError(
        ctx,
        `auto-context-handover: automatic rollover dispatch failed; ${recoveryHint(request.sessionId)} ${(error as Error).message}`,
        error,
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    pending = undefined;
    try {
      diagBySession.delete(ctx.sessionManager.getSessionId());
    } catch {
      // Best-effort cleanup only.
    }
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Context Handover",
    description: TOOL_DESCRIPTION,
    parameters: Type.Object({
      handover: Type.String(),
      summary: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const handover = typeof params.handover === "string" ? params.handover : "";
      const summary = typeof params.summary === "string" ? params.summary : "";
      if (handover.trim().length === 0) {
        throw new Error(`auto-context-handover: "handover" must be the full handover text, verbatim and non-empty`);
      }
      if (summary.trim().length === 0) {
        throw new Error(`auto-context-handover: "summary" must be a short status/outcome/next-step summary, non-empty`);
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const existing = await readOwnState(ctx);
      if (existing?.closed === true) throw new Error(childDirective(existing));
      const child = isChild(ctx);
      const observed = diagBySession.get(sessionId);
      const diag = {
        reason:
          !observed || observed.stage === "unknown" ? "unknown" : observed.stage !== "ok" ? "nudged" : "not-nudged",
        stage: observed ? observed.stage : "unknown",
        estimate: observed ? observed.estimate : "unknown",
        soft: observed ? observed.soft : "unknown",
      };
      const model = ctx.model;
      const payload = {
        handover,
        summary,
        sessionId,
        model: {
          provider: typeof model?.provider === "string" ? model.provider : "unknown",
          id: typeof model?.id === "string" ? model.id : "unknown",
        },
        storedAt: Date.now(),
        diag,
        closed: child,
      };
      pending = undefined;
      try {
        pi.appendEntry(ENTRY_TYPE, payload);
        await writeShared(sessionId, payload);
      } catch (error) {
        throw new Error(
          `auto-context-handover: failed to store handover in shared storage; no continuation requested (a branch entry may remain): ${(error as Error).message}`,
        );
      }
      // Only a successful storage creates a rollover request. A reload or an
      // older handover entry never starts one on its own.
      if (child) {
        pending = undefined;
        return { content: [{ type: "text", text: childDirective(payload) }], details: { sessionId, stored: true } };
      }
      pending = {
        run,
        sessionId,
        sessionFile: ctx.sessionManager.getSessionFile(),
        handoverEntryId: ctx.sessionManager.getLeafId() ?? undefined,
      };
      const text =
        `Handover stored for session ${sessionId}. End your turn now; a fresh seeded session opens automatically once this turn settles. ` +
        `If it does not, run /handover from this session. A private shared copy survives memory-only sessions.`;
      return { content: [{ type: "text", text }], details: { sessionId, stored: true }, terminate: true };
    },
  });

  pi.registerTool({
    name: READ_TOOL_NAME,
    label: "Read Handover",
    description: READ_DESCRIPTION,
    parameters: Type.Object({ sessionID: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const own = await readOwnState(ctx);
      if (own?.closed === true) throw new Error(childDirective(own));
      const shared = params.sessionID === undefined ? undefined : await readShared(params.sessionID);
      const lookup = params.sessionID === undefined
        ? latestHandover(ctx.sessionManager.getBranch() as unknown as ReadonlyArray<Record<string, unknown>>)
        : latestHandover(shared ? [{ type: "custom", customType: ENTRY_TYPE, data: shared }] : []);
      if (!lookup.found) {
        return {
          content: [
            {
              type: "text",
              text: lookup.invalidLatest
                ? `The latest stored handover entry in the current session branch is invalid; refusing to fall back to an older entry. Store a fresh handover with the context_handover tool.`
                : `No handover stored ${params.sessionID === undefined ? "in the current session branch" : `for session ${params.sessionID}`} yet.`,
            },
          ],
          details: { stored: false, invalidLatest: lookup.invalidLatest },
        };
      }
      const stored = lookup.stored;
      const header = `Handover from session ${stored.sessionId} (model ${stored.provider}/${stored.model}):`;
      return {
        content: [{ type: "text", text: `${header}\n${formatDiagLine(stored.diag)}\n\n${stored.handover}` }],
        details: { stored: true, sessionId: stored.sessionId },
      };
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Manual fallback: continue the stored session handover in a fresh session. Requires a stored handover; takes no arguments.",
    handler: async (args, ctx) => {
      // Commands are an explicit user recovery path, not model tool calls.
      // Child heuristics must not disable manual recovery of a mislabeled root.
      if (args.trim().length > 0) {
        ctx.ui.notify("auto-context-handover: /handover takes no arguments", "error");
        return;
      }
      // Settle first, then read: commands can run while streaming, so a
      // pre-wait read can reject a handover that lands during the turn or
      // seed from a stale snapshot.
      try {
        await ctx.waitForIdle();
      } catch (error) {
        ctx.ui.notify(
          `auto-context-handover: cannot settle the session before reading the handover, refusing to replace anything: ${(error as Error).message}`,
          "error",
        );
        return;
      }
      let branch: ReadonlyArray<Record<string, unknown>>;
      try {
        branch = ctx.sessionManager.getBranch() as unknown as ReadonlyArray<Record<string, unknown>>;
      } catch (error) {
        ctx.ui.notify(
          `auto-context-handover: cannot read the session branch, refusing to act: ${(error as Error).message}`,
          "error",
        );
        return;
      }
      const lookup = latestHandover(branch);
      if (!lookup.found) {
        // Error path only: never solicit a model call when there is nothing valid to continue.
        ctx.ui.notify(
          lookup.invalidLatest
            ? "auto-context-handover: the latest stored handover entry is invalid; refusing to fall back to an older entry. Store a fresh handover with the context_handover tool first"
            : "auto-context-handover: no handover stored in this session branch yet; call the context_handover tool first",
          "error",
        );
        return;
      }
      const stored = lookup.stored;
      if (stored.handover.trim().length === 0) {
        ctx.ui.notify(
          "auto-context-handover: the latest stored handover entry is empty; store a fresh handover with the context_handover tool first",
          "error",
        );
        return;
      }
      // Plain data only from here on: nothing captured below may touch the
      // source session after replacement (stale objects throw).
      const handover = stored.handover;
      const summary = stored.summary;
      const sourceId = ctx.sessionManager.getSessionId();
      const parentSession = ctx.sessionManager.getSessionFile();
      if (!ctx.model) {
        ctx.ui.notify("auto-context-handover: cannot snapshot predecessor model; refusing replacement", "error");
        return;
      }
      const selection = { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel() };
      const window = readEstimate(ctx).window;
      const seedText =
        `Continuing work handed over from session ${sourceId}. ` +
        `${SEED_FRAMING} ` +
        `Source session: ${sourceId}${parentSession ? ` (${parentSession})` : ""}.\n\n` +
        `--- handover from session ${sourceId} ---\n${handover}\n--- end of handover ---`;
      const title = summary.trim().slice(0, 80) || "handed-over session";
      const kickoff = `Continue from 'Prioritized next steps' for "${title}".`;
      const soft = resolveSoft(pi.getFlag(FLAG_NAME), window);
      if (soft !== undefined && seedTooLarge(Math.ceil(seedText.length / 4), soft)) {
        ctx.ui.notify(
          "auto-context-handover: the successor seed alone is over 50% of the soft threshold; the new session starts close to the limit",
          "warning",
        );
      }
      // Preflight guidance: replacement is destructive to the live view, so
      // state plainly that the model-written source remains recoverable.
      ctx.ui.notify(
        `auto-context-handover: replacing this session with a seeded successor. ${recoveryHint(sourceId)}`,
        "info",
      );
      try {
        const result = await ctx.newSession({
          ...(parentSession === undefined ? {} : { parentSession }),
          setup: async (sm) => {
            // Seed the full verbatim handover ONCE, plus backlink metadata.
            sm.appendMessage({ role: "user", content: seedText, timestamp: Date.now() });
            sm.appendCustomEntry(META_TYPE, {
              sourceSession: sourceId,
              sourceFile: parentSession ?? null,
              storedAt: Date.now(),
              summary,
              selection,
            });
          },
          withSession: async (fresh) => {
            // Only the fresh replacement context is session-bound here.
            try {
              const restored = fresh.sessionManager.getBranch().some((entry) => entry.type === "custom" &&
                entry.customType === RESTORE_TYPE && isRecord(entry.data) && entry.data.sourceSession === sourceId &&
                isRecord(entry.data.selection) && entry.data.selection.provider === selection.provider &&
                entry.data.selection.model === selection.model && entry.data.selection.thinking === selection.thinking);
              if (!restored || fresh.model?.provider !== selection.provider || fresh.model?.id !== selection.model ||
                  fresh.thinkingLevel !== selection.thinking) {
                throw new Error("predecessor model/thinking not verified; refusing continuation on a default model");
              }
              await fresh.sendUserMessage(kickoff);
            } catch (error) {
              reportHostError(
                fresh,
                `auto-context-handover: the replacement session is open but the continuation prompt failed; ${recoveryHint(sourceId)} ${(error as Error).message}`,
                error,
              );
            }
          },
        });
        if (result.cancelled) {
          ctx.ui.notify(
            `auto-context-handover: handover continuation cancelled; the source session is unchanged. ${recoveryHint(sourceId)}`,
            "info",
          );
        }
        // Success needs no report here: the replacement session is live and
        // the kickoff message speaks for itself. Never claim success on error.
      } catch (error) {
        // The old context may be torn down already. If it cannot carry the
        // error, throw so the host extension-error surface still reports it.
        reportHostError(
          ctx,
          `auto-context-handover: handover continuation failed: ${(error as Error).message}. ` +
            `${recoveryHint(sourceId)} The old context may be torn down, so the source state and any partial replacement cannot be confirmed here; check the session list.`,
          error,
        );
      }
    },
  });
}
