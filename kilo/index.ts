// auto-context-handover: Kilo Code root-only advisory plugin (MVP, no build step).
// Root sessions only: measured soft-limit advisories, a model-written
// handover kept in dedicated file storage, and manual continuation via
// read_handover. No subagent integration, no automatic rollover, no hard
// gate, no lock, no task creation, no compaction changes, no quota/TTL/
// eviction, no model selection. Notices are transient per-request text;
// the host persists the introduction added to a user message.
//
// Measurement basis (verified against the pinned host source, not assumed):
// - The "experimental.chat.messages.transform" hook fires in two places: the
//   ordinary model loop after the host's compacted-view projection
//   (filterCompacted), queue scoping, and trim-before-last-summary, and before
//   editor-context injection and system/tool-schema assembly
//   (packages/opencode/src/session/prompt.ts: ~1570 scope/trim, :1813
//   transform trigger, later injectEditorContext); and the compaction
//   summarizer over the selected compaction head
//   (packages/opencode/src/session/compaction.ts:443-449), which this plugin
//   skips via an observation-only experimental.session.compacting hook
//   (compaction.ts:444, the only trigger site). The estimate therefore covers
//   the persisted visible history only: the provider-reported usage anchor may
//   itself bundle model-call overhead, and the trailing chars/4 term omits
//   media, file attachments, and anything the host adds, strips, or prunes
//   after the hook (editor context, system prompt, tool schemas,
//   payload-limit pruning, model conversion).
// - Assistant usage is the host-normalized five-field record
//   (packages/opencode/src/session/session.ts:420-462, same shape as the SDK
//   AssistantMessage.tokens): input is already non-cached input, output
//   already excludes reasoning; the five fields are summed exactly once.
//   Session-level cumulative totals are never a usage source.
// - Post-compaction anchors: summary/compaction assistants (summary ===
//   true, mode/agent === "compaction") never anchor - their usage is the
//   summarizer's input, not the current window. When any completed
//   successful summary (summary === true, truthy finish, no error) is in
//   the active view, only ordinary assistants chronologically AFTER the
//   newest completed summary (host time.created, strictly greater) may
//   anchor; array position is ignored because filterCompacted reorders to
//   [compaction-user, summary, ...retained old tail..., new messages]
//   (message-v2.ts:663-715) and trim-before-last-summary retains the
//   summary plus tail (prompt.ts:672-684). Missing/non-finite timestamps
//   or ties fail open to unknown - no anchor is reused. Ineligible
//   messages keep their chars (tokens are merely undefined); there is no
//   heuristic-sum fallback, so the estimate stays unknown until fresh
//   ordinary usage lands.
// - Kilo tool results are state.output (completed) / state.error (error)
//   strings, not a content array; file/image parts carry no counted text.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, link, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  Hooks,
  Plugin,
  PluginInput,
  PluginModule,
  ToolDefinition,
} from "@kilocode/plugin";
import type { Event, Message, Part } from "@kilocode/sdk";
import {
  measureSession,
  parseThreshold,
  resolveModelWindow,
  resolveSoftTokens,
  type ModelWindow,
  type NarrowMessage,
  type ThresholdSpec,
} from "../source/measure.ts";
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
const STORAGE_LEAF = join(".kilo", "auto-context-handover");
const STORAGE_FILE = "handover.json";

// The shared six-section text carries one paragraph claiming an
// authoritative parent/agent/model/chain plugin record. The Kilo entry keeps
// the sections unchanged apart from that paragraph: the only recorded
// provenance is the source session/agent id, and the effective model and any
// override are unknown (hooks never capture model identity as a verifiable
// window contract for the stored entry).
const SHARED_PROVENANCE_PARAGRAPH =
  "Do not describe your own agent type, model (including override), or chain; the plugin records authoritative provenance and the parent uses the plugin record even if this handover says otherwise.";
const KILO_PROVENANCE_PARAGRAPH =
  "The stored entry's recorded source session id and agent id are the authoritative provenance; " +
  "the effective model is unknown, no model override is recorded, and there is no child chain. " +
  "Do not restate your own model identity; write the handover from the task content.";
const KILO_HANDOVER_SECTIONS = (() => {
  if (!HANDOVER_SECTIONS.includes(SHARED_PROVENANCE_PARAGRAPH)) {
    throw new Error("auto-context-handover: shared handover text drifted, refusing to register with stale provenance wording");
  }
  return HANDOVER_SECTIONS.replace(SHARED_PROVENANCE_PARAGRAPH, KILO_PROVENANCE_PARAGRAPH);
})();

// Minimal structural view of the host client surface this plugin touches.
// These are intentionally narrower than the real SDK client (fewer required
// fields, unknown-typed payloads) so the plugin stays decoupled at runtime;
// the `Plugin`/`Hooks` annotations on the factory result verify assignability
// against the real host contracts at typecheck time.
interface KiloResultLike {
  readonly data?: unknown;
  readonly error?: unknown;
}

interface KiloSessionApiLike {
  get: (args: { readonly path: { readonly id: string } }) => Promise<KiloResultLike>;
}

interface KiloProviderApiLike {
  list: (args?: Record<string, never>) => Promise<KiloResultLike>;
}

export interface KiloHandoverToolContext {
  readonly sessionID: string;
  readonly agent: string;
}

type DiagValue = number | "unknown";

interface CallDiag {
  readonly reason: string;
  readonly stage: string;
  readonly estimate: DiagValue;
  readonly soft: DiagValue;
}

const TOOL_DESCRIPTION =
  `Call this tool only after an auto-context-handover advisory notice appears, or when the user explicitly asks for a handover. ` +
  `Do not call it just to finish a task; give a normal final response instead. ` +
  `Once the notice appears (or the user asks), call exactly once per unit of work when done, then end your turn. ` +
  `Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never summarized or reworded) ` +
  `plus a short status/outcome/next-step summary in "summary".\n\n` +
  `${KILO_HANDOVER_SECTIONS}\n\n` +
  `The first successful call wins: a later call for the same session is rejected and the original is preserved. ` +
  `Do not paste secrets. Continuation is manual: start a fresh equipped root session and call read_handover with the source session id. ` +
  `Nothing rolls over automatically.`;

const READ_DESCRIPTION =
  `Read a stored context handover by source session id. ` +
  `Takes a "sessionID" argument naming any retained source session; paths are never accepted. ` +
  `Returns the verbatim stored text plus recorded source session/agent metadata, pre-call diagnostics, and manual-continuation guidance. ` +
  `Reports plainly when nothing is stored or when the stored entry is unreadable. ` +
  `It never creates sessions and never triggers rollover.`;

const INTRO_MARKER = "auto-context-handover is active for this root session.";

const INTRO_TEXT =
  `${INTRO_MARKER} ` +
  `Soft-limit advisories may follow; each advisory applies to the current step only: ` +
  `it replaces any required final report or current-step wrap-up instruction for that step, not the whole task. ` +
  `When an advisory appears, finish the current step, then call the context_handover tool with the full handover text; ` +
  `the tool writes only plugin storage, so read-only task instructions still allow the call. ` +
  `Continuation is manual: start a fresh equipped root session and call read_handover with the source session id from the handover confirmation. ` +
  `Nothing rolls over automatically.`;

// Stable per-stage notice suffix: identical on every request that observes
// the same stage. Diagnostics are never embedded here; the latest
// estimate/soft/stage/reason is stored with the handover and replayed by
// read_handover instead.
const NOTICE_SUFFIX =
  ` This advisory applies to the current step only (see the session intro message for the full workflow). ` +
  `The context estimate is a heuristic: anchored provider-reported usage (which may itself include model-call overhead) ` +
  `plus trailing text chars/4 over the compacted visible history. ` +
  `It omits media, file attachments, and anything the host adds, strips, or prunes after this hook ` +
  `(editor context, the system prompt, tool schemas), and is not an exact token count. ` +
  `When done with this step, call the context_handover tool with the full handover text ` +
  `(plugin-storage write only, allowed under read-only instructions); continuation is manual in a fresh session via read_handover.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Finite host time.created, or undefined when missing/malformed. */
const createdOf = (info: Message): number | undefined => {
  const time = (info as unknown as { readonly time?: unknown }).time;
  if (!isRecord(time)) return undefined;
  const created = (time as Record<string, unknown>).created;
  return typeof created === "number" && Number.isFinite(created) ? created : undefined;
};

/** Summary or compaction-worker assistants never anchor (summarizer input, not the window). */
const isSummaryOrCompactionAssistant = (info: Message): boolean => {
  if ((info as Message)?.role !== "assistant") return false;
  const rec = info as unknown as Record<string, unknown>;
  if (rec.summary === true) return true;
  if (typeof rec.mode === "string" && rec.mode === "compaction") return true;
  if (typeof rec.agent === "string" && rec.agent === "compaction") return true;
  return false;
};

/** Completed successful summary: summary === true with truthy finish and no error. */
const isCompletedSummary = (info: Message): boolean => {
  if ((info as Message)?.role !== "assistant") return false;
  const rec = info as unknown as Record<string, unknown>;
  if (rec.summary !== true) return false;
  if (!rec.finish) return false;
  if (rec.error) return false;
  return true;
};

/**
 * Post-compaction anchor policy. Returns narrows with tokens undefined on
 * ineligible messages; chars are preserved so trailing text still counts
 * once a fresh eligible anchor lands. No messages or text are removed.
 */
function applyCompactionAnchorPolicy(
  messages: ReadonlyArray<{ readonly info: Message }>,
  narrows: ReadonlyArray<NarrowMessage>,
): NarrowMessage[] {
  let newestSummaryCreated: number | undefined;
  let summaryUntrustworthy = false;
  let hasCompletedSummary = false;
  for (const message of messages) {
    if (!message || !isCompletedSummary(message.info)) continue;
    hasCompletedSummary = true;
    const created = createdOf(message.info);
    if (created === undefined) {
      summaryUntrustworthy = true;
    } else if (newestSummaryCreated === undefined || created > newestSummaryCreated) {
      newestSummaryCreated = created;
    }
  }
  return narrows.map((narrow, index) => {
    if (narrow.kind !== "assistant") return narrow;
    const info = messages[index]?.info;
    if (!info || isSummaryOrCompactionAssistant(info)) {
      return narrow.tokens === undefined ? narrow : { ...narrow, tokens: undefined };
    }
    if (!hasCompletedSummary) return narrow;
    // A completed summary is in view: only ordinary assistants strictly
    // after it (host chronology, not array position) may anchor. Unknown
    // summary time, missing/NaN assistant time, or ties fail open.
    if (summaryUntrustworthy || newestSummaryCreated === undefined) {
      return narrow.tokens === undefined ? narrow : { ...narrow, tokens: undefined };
    }
    const created = createdOf(info);
    if (created === undefined || created <= newestSummaryCreated) {
      return narrow.tokens === undefined ? narrow : { ...narrow, tokens: undefined };
    }
    return narrow;
  });
}

const textLength = (value: unknown): number => (typeof value === "string" ? value.length : 0);

const jsonLength = (value: unknown): number => {
  try {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    return typeof rendered === "string" ? rendered.length : 0;
  } catch {
    return 0;
  }
};

/** Env/option soft parsing: positive integers (number or digit string) or "70%" strings. */
function parseSoftValue(raw: unknown): { readonly spec?: ThresholdSpec; readonly error?: string } {
  if (raw === undefined) return { spec: { kind: "tokens", tokens: DEFAULT_SOFT } };
  if (typeof raw === "number") {
    try {
      return { spec: parseThreshold(raw) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const candidate = /^\d+$/.test(trimmed) ? Number(trimmed) : raw;
    try {
      return { spec: parseThreshold(candidate) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
  return { error: `${ENV_SOFT} must be a "70%" string or a positive absolute integer of tokens, got ${String(raw)}` };
}

/**
 * Map one host message to cheap char counts. Mirrors source/measure.narrow
 * but reads Kilo tool results: completed carries state.output and error
 * carries state.error (both plain strings, never a content array). File and
 * image parts are omitted: they carry no counted text.
 */
function kiloNarrow(info: Message, parts: readonly Part[]): NarrowMessage {
  if (info.role !== "assistant") {
    let ownChars = 0;
    for (const part of parts) {
      if (part.type === "text") ownChars += textLength(part.text);
    }
    return { kind: info.role, ownChars, resultChars: 0 };
  }
  let ownChars = 0;
  let resultChars = 0;
  for (const part of parts) {
    if (part.type === "text" || part.type === "reasoning") {
      ownChars += textLength(part.text);
    } else if (part.type === "tool") {
      const state = part.state as { readonly status?: unknown; readonly input?: unknown; readonly output?: unknown; readonly error?: unknown };
      ownChars += jsonLength(state?.input);
      if (state?.status === "completed") resultChars += textLength(state.output);
      else if (state?.status === "error") resultChars += textLength(state.error);
    }
  }
  const tokens = (info as { readonly tokens?: NarrowMessage["tokens"] }).tokens;
  return { kind: "assistant", tokens, ownChars, resultChars };
}

const sessionDir = (storageDir: string, sourceSessionId: string): string =>
  join(storageDir, createHash("sha256").update(sourceSessionId, "utf8").digest("hex"));

function logSetupError(detail: string): void {
  const full =
    `auto-context-handover: ${detail}. ` +
    `Handover advisories are disabled until it is fixed (default ${DEFAULT_SOFT}); the handover tools still work.`;
  try {
    console.error(full);
  } catch {
    // Best-effort logging only.
  }
}

function createServer(): Plugin {
  // Per-server-call state (one Hooks set per server() invocation). All maps
  // are keyed by host session id; nothing is bound to a single session.
  const server: Plugin = async (input: PluginInput, options) => {
    const client = input?.client as unknown as
      | { readonly session?: KiloSessionApiLike; readonly provider?: KiloProviderApiLike }
      | undefined;
    const opts = isRecord(options) ? options : {};
    const now = typeof opts.now === "function" ? (opts.now as () => number) : Date.now;
    const storageDir =
      typeof opts.dir === "string" && opts.dir.length > 0 ? opts.dir : join(homedir(), STORAGE_LEAF);

    let softSpec: ThresholdSpec | undefined;
    if (opts.soft !== undefined) {
      const parsed = parseSoftValue(opts.soft);
      if (parsed.error !== undefined) {
        softSpec = undefined;
        logSetupError(`invalid explicit soft limit ${JSON.stringify(opts.soft)}: ${parsed.error}`);
      } else {
        softSpec = parsed.spec;
      }
    } else {
      const envSource = isRecord(opts.env)
        ? opts.env as Record<string, string | undefined>
        : (process.env as Record<string, string | undefined>);
      const parsed = parseSoftValue(envSource[ENV_SOFT]);
      if (parsed.error !== undefined) {
        softSpec = undefined;
        logSetupError(`invalid ${ENV_SOFT}: ${parsed.error}`);
      } else {
        softSpec = parsed.spec;
      }
    }

    // Latest advisory diagnostics per root session, replaced on each
    // transform observation. Unknown until the first observation (and after a
    // host reload, which drops this map); the writer stores whatever is
    // latest rather than refusing.
    const diagBySession = new Map<string, CallDiag>();
    const rootCache = new Map<string, boolean>();
    const introSent = new Set<string>();
    // Sessions whose compaction summary is about to run through
    // messages.transform. Set by the observation-only compacting hook,
    // consumed once by the next transform for that session.
    const skipCompactionTransform = new Set<string>();
    let catalog: Promise<ModelWindow[] | undefined> | undefined;

    const readSessionRoot = async (sessionID: string): Promise<boolean | undefined> => {
      try {
        const api = client?.session;
        if (!api || typeof api.get !== "function") return undefined;
        const result = await api.get({ path: { id: sessionID } });
        const data = isRecord(result) ? result.data : undefined;
        // Require the returned id to match the requested one; parentID absent
        // means a root session. Anything else is unavailable/malformed.
        if (!isRecord(data) || data.id !== sessionID) return undefined;
        if (data.parentID === undefined || data.parentID === null) return true;
        return false;
      } catch {
        return undefined;
      }
    };

    const readRootCached = async (sessionID: string): Promise<boolean | undefined> => {
      const cached = rootCache.get(sessionID);
      if (cached !== undefined) return cached;
      const root = await readSessionRoot(sessionID);
      if (root !== undefined) rootCache.set(sessionID, root);
      return root;
    };

    const readCatalog = (): Promise<ModelWindow[] | undefined> => {
      if (!catalog) {
        catalog = (async () => {
          try {
            const api = client?.provider;
            if (!api || typeof api.list !== "function") return undefined;
            const result = await api.list();
            const data = isRecord(result) ? result.data : undefined;
            if (!isRecord(data) || !Array.isArray(data.all)) return undefined;
            // The Kilo provider catalog carries limit.context only (no input
            // limit); resolveModelWindow falls back to the context limit.
            const windows: ModelWindow[] = [];
            for (const provider of data.all) {
              if (!isRecord(provider) || typeof provider.id !== "string") continue;
              const models = isRecord(provider.models) ? provider.models : {};
              for (const key of Object.keys(models)) {
                const model = models[key];
                if (!isRecord(model)) continue;
                const id = typeof model.id === "string" && model.id.length > 0 ? model.id : key;
                const limit = isRecord(model.limit) ? model.limit : {};
                const context = typeof limit.context === "number" ? limit.context : NaN;
                windows.push({ providerID: provider.id, id, limit: { context } });
              }
            }
            return windows;
          } catch {
            return undefined;
          }
        })();
      }
      return catalog;
    };

    const forgetSession = (sessionID: string): void => {
      diagBySession.delete(sessionID);
      rootCache.delete(sessionID);
      introSent.delete(sessionID);
      skipCompactionTransform.delete(sessionID);
    };

    const writerExecute = async (args: unknown, context: unknown): Promise<string> => {
      const params = isRecord(args) ? args : {};
      const handover = typeof params.handover === "string" ? params.handover : "";
      const summary = typeof params.summary === "string" ? params.summary : "";
      if (handover.trim().length === 0) {
        throw new Error(`auto-context-handover: "handover" must be the full handover text, verbatim and non-empty`);
      }
      if (summary.trim().length === 0) {
        throw new Error(`auto-context-handover: "summary" must be a short status/outcome/next-step summary, non-empty`);
      }
      const ctx = isRecord(context) ? context : {};
      const sessionID = typeof ctx.sessionID === "string" ? ctx.sessionID : "";
      const agent = typeof ctx.agent === "string" ? ctx.agent : "";
      if (sessionID.length === 0) {
        throw new Error(`auto-context-handover: refusing to store: the host supplied no session id for this call`);
      }
      if (agent.length === 0) {
        throw new Error(`auto-context-handover: refusing to store: the host supplied no agent identity for this call`);
      }
      // Fail closed: the host session record must be reachable, id-matched,
      // and parentless. Children and unverifiable sessions never store.
      let root: boolean | undefined;
      try {
        root = await readSessionRoot(sessionID);
      } catch {
        root = undefined;
      }
      if (root !== true) {
        throw new Error(
          root === false
            ? `auto-context-handover: refusing to store: session ${JSON.stringify(sessionID)} is not a root session; child sessions never store handovers`
            : `auto-context-handover: refusing to store: unable to verify session ${JSON.stringify(sessionID)} as a root session (host session record unavailable or mismatched)`,
        );
      }
      const diag = diagBySession.get(sessionID) ?? { reason: "unknown", stage: "unknown", estimate: "unknown", soft: "unknown" };
      const dir = sessionDir(storageDir, sessionID);
      const payload = JSON.stringify({
        version: 1,
        handover,
        summary,
        sourceSessionId: sessionID,
        agentId: agent,
        storedAt: now(),
        diag,
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
            `auto-context-handover: a handover is already stored for session ${JSON.stringify(sessionID)}; refusing to overwrite, the original is preserved`,
          );
        }
        throw new Error(
          `auto-context-handover: failed to publish handover, nothing was handed over: ${(error as Error).message}`,
        );
      }
      await unlink(tmp).catch(() => undefined);
      return (
        `Handover stored for session ${sessionID}. End your turn now. ` +
        `To continue manually, start a fresh equipped Kilo root session and call read_handover with sessionID ${JSON.stringify(sessionID)}, ` +
        `then continue from 'Prioritized next steps'. No automatic rollover was triggered.`
      );
    };

    const readerExecute = async (args: unknown): Promise<string> => {
      const params = isRecord(args) ? args : {};
      const sessionID = typeof params.sessionID === "string" ? params.sessionID : "";
      if (sessionID.trim().length === 0) {
        throw new Error(
          `auto-context-handover: "sessionID" must be a retained source session id (non-empty string); paths are never accepted`,
        );
      }
      // Any equipped caller may read any retained id (including children);
      // the reader makes no caller-authorization promise.
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
        `To continue manually, start a fresh equipped Kilo root session and call read_handover with sessionID ${JSON.stringify(sessionID)}, ` +
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
    };

    // Plain tool objects: the host `tool()` helper is an identity function,
    // so these literals already satisfy ToolDefinition without a runtime Kilo
    // import. Args use the repo's existing zod; the host pins an older zod
    // copy whose internals are not type-comparable, so the literal crosses
    // that seam via an unknown assertion (this bypasses the args schema type
    // check; the execute implementations above stay checked, and a runtime
    // host-zod conversion test proves the shipped args accept/reject).
    // Known loss: the host builds its JSON Schema with its own zod copy, so
    // arg descriptions do not survive conversion (properties/required do).
    const writer = {
      description: TOOL_DESCRIPTION,
      args: {
        handover: z.string().describe("Full handover text, stored verbatim."),
        summary: z.string().describe("Short status/outcome/next-step summary."),
      },
      execute: writerExecute,
    } as unknown as ToolDefinition;

    const reader = {
      description: READ_DESCRIPTION,
      args: {
        sessionID: z.string().describe("Retained source session id to read."),
      },
      execute: readerExecute,
    } as unknown as ToolDefinition;

    const hooks: Hooks = {
      tool: {
        [TOOL_NAME]: writer,
        [READ_TOOL_NAME]: reader,
      },

      "chat.message": async (input, output) => {
        try {
          const sessionID = typeof input?.sessionID === "string" ? input.sessionID : "";
          if (sessionID.length === 0) return;
          if (await readRootCached(sessionID) !== true) return;
          if (introSent.has(sessionID)) return;
          // The host assigns the actual message; input.messageID is optional
          // and must never be used. Without the assigned message (or when it
          // names another session) the intro is skipped.
          const message = isRecord(output?.message) ? output.message : undefined;
          if (!message) return;
          const messageID = typeof message.id === "string" ? message.id : "";
          if (messageID.length === 0) return;
          if (typeof message.sessionID === "string" && message.sessionID !== sessionID) return;
          const parts = Array.isArray(output?.parts) ? output.parts : undefined;
          if (!parts) return;
          // Dedups only the current output parts (same hook call, or a
          // reloaded instance re-seeing this message): never append when the
          // marker is already present. A server reload with a new user
          // message re-sends the intro; no history is fetched to prevent it.
          for (const part of parts) {
            if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.includes(INTRO_MARKER)) {
              introSent.add(sessionID);
              return;
            }
          }
          parts.push({
            id: `prt_${randomUUID()}`,
            sessionID,
            messageID,
            type: "text",
            text: INTRO_TEXT,
            synthetic: true,
          });
          introSent.add(sessionID);
        } catch {
          // Hooks fail open: an intro that cannot be appended is skipped.
        }
      },

      // Observation-only: flags the session whose compaction summary is
      // about to run through messages.transform. Never mutates output.
      "experimental.session.compacting": async (input) => {
        try {
          const sessionID = isRecord(input) ? input.sessionID : undefined;
          if (typeof sessionID === "string" && sessionID.length > 0) skipCompactionTransform.add(sessionID);
        } catch {
          // Hooks fail open.
        }
      },

      "experimental.chat.messages.transform": async (_input, output) => {
        try {
          const messages = Array.isArray((output as { messages?: unknown } | undefined)?.messages)
            ? (output as { messages: Array<{ info: Message; parts: Part[] }> }).messages
            : undefined;
          if (!messages || messages.length === 0) return;
          // The hook carries no session id: derive the common info.sessionID
          // across all nonempty messages and refuse mixed sessions.
          const ids = new Set<string>();
          for (const message of messages) {
            const id = isRecord(message?.info) ? (message.info as Record<string, unknown>).sessionID : undefined;
            if (typeof id === "string" && id.length > 0) ids.add(id);
          }
          if (ids.size !== 1) return;
          const sessionID = [...ids][0] as string;
          // Compaction-summary passes (compaction.ts:449) are observation-only
          // for this plugin: the paired experimental.session.compacting hook
          // (compaction.ts:444, the only trigger site) flags the session, and
          // the flag is consumed here before any root/catalog/measurement
          // work, so no notice is appended and no diagnostics are recorded.
          // Same-session model loops are serial, so the flag always belongs
          // to this pass; a stale flag (compaction aborted before transform)
          // suppresses at most one later ordinary notice (fail-open).
          if (skipCompactionTransform.has(sessionID)) {
            skipCompactionTransform.delete(sessionID);
            return;
          }
          if (await readRootCached(sessionID) !== true) return;

          // Current window from the latest user message's model plus the
          // host provider catalog (context limit; the catalog has no input
          // limit). Unavailable catalog: integer soft stays uncapped,
          // percent soft stays silent.
          let latestUser: { info: Message; parts: Part[] } | undefined;
          for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message && (message.info as Message)?.role === "user") {
              latestUser = message as { info: Message; parts: Part[] };
              break;
            }
          }
          let windowTokens: number | undefined;
          let providerID: string | undefined;
          let modelID: string | undefined;
          if (latestUser && isRecord(latestUser.info)) {
            const model = (latestUser.info as Record<string, unknown>).model;
            if (isRecord(model) && typeof model.providerID === "string" && typeof model.modelID === "string") {
              providerID = model.providerID;
              modelID = model.modelID;
              const catalogWindows = await readCatalog();
              windowTokens = providerID !== undefined && modelID !== undefined
                ? resolveModelWindow(catalogWindows, providerID, modelID)
                : undefined;
            }
          }
          const soft = softSpec ? resolveSoftTokens(softSpec, windowTokens) : undefined;

          // Anchor on the latest *eligible* assistant message with nonzero
          // normalized usage (the host stores zeros when usage is absent,
          // and the empty current assistant at the tail is skipped the same
          // way); trailing settled tool results and later-message chars
          // count as chars/4. Summary/compaction assistants never anchor,
          // and after a completed summary only ordinary assistants strictly
          // after it (host time.created) stay eligible - see
          // applyCompactionAnchorPolicy. The anchor's own output is never
          // added twice: resultChars lives on the anchor message and
          // measureSession adds it exactly once.
          const narrows: NarrowMessage[] = applyCompactionAnchorPolicy(
            messages,
            messages.map((message) =>
              kiloNarrow(message.info, Array.isArray(message.parts) ? message.parts : []),
            ),
          );
          const measurement = measureSession(narrows);
          const estimate = measurement ? measurement.estimate : undefined;
          const stage = estimate === undefined || soft === undefined ? "unknown" : softStage(estimate, soft);
          // reason=nudged is recorded only after a notice is actually
          // appended below; a warn stage with no appendable user/model/agent
          // stays not-nudged instead of overclaiming.
          let appended = false;
          if (stage !== "ok" && stage !== "unknown" && latestUser && isRecord(latestUser.info)) {
            const userInfo = latestUser.info as Record<string, unknown>;
            const agent = typeof userInfo.agent === "string" ? userInfo.agent : undefined;
            if (agent !== undefined && providerID !== undefined && modelID !== undefined) {
              // Transient request-tail notice: existing messages and parts
              // are never mutated and no system prefix is rewritten. The
              // synthetic host message copies agent/model from the latest
              // user message so it stays well-formed for model conversion.
              // Ids carry the host schema prefixes (msg_/prt_).
              const noticeID = `msg_${randomUUID()}`;
              messages.push({
                info: {
                  id: noticeID,
                  sessionID,
                  role: "user",
                  time: { created: now() },
                  agent,
                  model: { providerID, modelID },
                },
                parts: [
                  {
                    id: `prt_${randomUUID()}`,
                    sessionID,
                    messageID: noticeID,
                    type: "text",
                    text: `${openCodeStageText(stage)}${NOTICE_SUFFIX}`,
                    synthetic: true,
                  },
                ],
              });
              appended = true;
            }
          }
          diagBySession.set(sessionID, {
            reason: stage === "unknown" ? "unknown" : appended ? "nudged" : "not-nudged",
            stage,
            estimate: estimate ?? "unknown",
            soft: soft ?? "unknown",
          });
        } catch {
          // Hooks fail open: measurement or notice trouble never blocks the model call.
        }
      },

      event: async (input) => {
        try {
          const event = (input as { event?: Event } | undefined)?.event;
          if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "session.deleted") return;
          const properties = ((event as unknown) as Record<string, unknown>).properties;
          const id = isRecord(properties)
            ? isRecord(properties.info)
              ? properties.info.id
              : properties.sessionID
            : undefined;
          if (typeof id === "string" && id.length > 0) forgetSession(id);
        } catch {
          // Hooks fail open.
        }
      },

      dispose: async () => {
        diagBySession.clear();
        rootCache.clear();
        introSent.clear();
        skipCompactionTransform.clear();
        catalog = undefined;
      },
    };
    return hooks;
  };
  return server;
}

// Only the default descriptor is exported: the legacy host loader scans
// module exports for function plugins, so no named function exports exist.
// Tests and the loader reach the server through this descriptor.
const descriptor: PluginModule = {
  id: PLUGIN_NAME,
  server: createServer(),
};

export default descriptor;
