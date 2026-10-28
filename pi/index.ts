// auto-context-handover: Pi root-session extension (MVP, no build step).
// Root sessions only: measured soft-limit advisories, a model-written
// handover kept in extension storage, and manual /handover continuation.
// No subagent integration, no automatic rollover, no hard gate, no lock,
// no compaction changes. Native Pi compaction is untouched.
//
// Persistence note: pi.appendEntry() writes a session custom entry, which
// does NOT participate in LLM context. It is durable only when the session
// itself is backed by a session file; ephemeral sessions (no session file)
// hold it in memory only. Tool and command text say so honestly.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

const DEFAULT_SOFT = 150000;

type DiagValue = number | "unknown";

interface CallDiag {
  readonly stage: string;
  readonly estimate: DiagValue;
  readonly soft: DiagValue;
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
  `Once stored, end your turn; the user runs /handover to continue in a fresh session seeded from this text. ` +
  `Calling this tool again later after resumed work replaces the stored handover. ` +
  `No automatic rollover is triggered by this call. Do not paste secrets.`;

const READ_DESCRIPTION =
  `Read the handover stored in the current session branch. ` +
  `Takes no arguments and cannot read other sessions or files. ` +
  `Returns the verbatim stored text plus a diagnostics header, or a plain notice when nothing is stored yet.`;

const INTRO_TEXT =
  `auto-context-handover is active for this root session. ` +
  `Soft-limit advisories may follow; each advisory applies to the current step only: ` +
  `it replaces any required final report or current-step wrap-up instruction for that step, not the whole task. ` +
  `When an advisory appears, finish the current step, then call the context_handover tool with the full handover text; ` +
  `the tool writes only extension storage, so read-only task instructions still allow the call. ` +
  `Continuation is manual by default: the user runs /handover to open a fresh session seeded from the stored handover. ` +
  `Nothing rolls over automatically.`;

// Stable per-stage notice suffix. No live numbers: the text is identical on
// every request that observes the same stage.
const NOTICE_SUFFIX =
  ` This advisory applies to the current step only: it replaces any required final report or current-step wrap-up for this step, ` +
  `not the whole task (see the auto-context-handover intro message for the full workflow). ` +
  `When done with this step, call the context_handover tool with the full handover text ` +
  `(extension-storage write only, allowed under read-only instructions); the user then runs /handover to continue manually.`;

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

  pi.registerFlag(FLAG_NAME, {
    description:
      "Soft context threshold for handover advisories: a positive token integer (capped at 70% of the context window) or a percent like 70% (uncapped). Default 150000.",
    type: "string",
    default: String(DEFAULT_SOFT),
  });

  // Trusted per-turn introduction. The host persists the returned custom
  // message into the session; this handler only authors it and never
  // rewrites the initial system prefix.
  pi.on("before_agent_start", async () => {
    return {
      message: { customType: INTRO_TYPE, content: INTRO_TEXT, display: false },
    };
  });

  // Explicit flag validation. An invalid value is reported here, once per
  // session start, so the silent context hook below never substitutes
  // another threshold. Pi surfaces the notification without crashing.
  pi.on("session_start", async (_event, ctx) => {
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
      const notice = `${openCodeStageText(stage)}${NOTICE_SUFFIX}`;
      return { messages: [...event.messages, { role: "user", content: notice, timestamp: Date.now() }] };
    } catch {
      // Fail open: measurement or host trouble never touches the request.
      return;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
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
      };
      try {
        pi.appendEntry(ENTRY_TYPE, payload);
      } catch (error) {
        throw new Error(
          `auto-context-handover: failed to store handover, nothing was handed over: ${(error as Error).message}`,
        );
      }
      const ephemeral = ctx.sessionManager.getSessionFile() === undefined;
      const text =
        `Handover stored for session ${sessionId}. End your turn now; the user runs /handover to continue in a fresh session. ` +
        `No automatic rollover was triggered.` +
        (ephemeral
          ? ` Note: this session has no session file, so the handover is held in memory only and will not survive a restart.`
          : ``);
      return { content: [{ type: "text", text }], details: { sessionId, stored: true } };
    },
  });

  pi.registerTool({
    name: READ_TOOL_NAME,
    label: "Read Handover",
    description: READ_DESCRIPTION,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const lookup = latestHandover(ctx.sessionManager.getBranch() as unknown as ReadonlyArray<Record<string, unknown>>);
      if (!lookup.found) {
        return {
          content: [
            {
              type: "text",
              text: lookup.invalidLatest
                ? `The latest stored handover entry in the current session branch is invalid; refusing to fall back to an older entry. Store a fresh handover with the context_handover tool.`
                : `No handover stored in the current session branch yet.`,
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
    description: "Continue the stored session handover in a fresh session. Requires a stored handover; takes no arguments.",
    handler: async (args, ctx) => {
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
            });
          },
          withSession: async (fresh) => {
            // Only the fresh replacement context is session-bound here.
            try {
              await fresh.sendUserMessage(kickoff);
            } catch (error) {
              fresh.ui.notify(
                `auto-context-handover: the replacement session is open but the continuation prompt failed: ${(error as Error).message}`,
                "error",
              );
            }
          },
        });
        if (result.cancelled) {
          ctx.ui.notify("auto-context-handover: handover continuation cancelled; the source session is unchanged", "info");
        }
        // Success needs no report here: the replacement session is live and
        // the kickoff message speaks for itself. Never claim success on error.
      } catch (error) {
        // The old context may be torn down already, so this report cannot
        // confirm the source state; a best-effort notify is all that is left.
        try {
          ctx.ui.notify(
            `auto-context-handover: handover continuation failed: ${(error as Error).message}. ` +
              `The old context may be torn down, so the source state and any partial replacement cannot be confirmed here; ` +
              `check the session list and retry /handover from the session that holds the stored handover.`,
            "error",
          );
        } catch {
          // The source context may be stale after a partial replacement.
        }
      }
    },
  });
}
