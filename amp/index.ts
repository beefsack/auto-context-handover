// auto-context-handover: Amp focused-root-only advisory plugin (no build step).
// Focused parentless threads only: measured soft-limit advisories, a
// model-written handover in HOME storage, manual read_handover recovery, and
// one automatic fresh-root continuation per stored handover. No subagent
// integration, no quota/TTL/eviction, no source lock, no hard gate, no
// compaction changes, no model selection. Parent null can also mean a deleted
// parent, so root checks are best-effort, not a universal subagent guarantee.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, link, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Agent,
  AgentEndEvent,
  AgentStartEvent,
  PluginAPI,
  PluginThread,
  ThreadID,
  ThreadMessage,
  ToolResultEvent,
} from "@ampcode/plugin";
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
const STORAGE_LEAF = join(".amp", "auto-context-handover");
const HANDOVER_FILE = "handover.json";
const CLAIM_FILE = "continuation-claim.json";
const RESULT_FILE = "continuation-result.json";
const PAGE_LIMIT = 20;
const MAX_PAGES = 250;

// Shared text carries one paragraph claiming an authoritative plugin record.
// The Amp entry keeps the sections unchanged apart from that paragraph: the
// recorded source thread id is authoritative and the effective model is
// unknown (hooks never see model identity as a window contract).
const SHARED_PROVENANCE_PARAGRAPH =
  "Do not describe your own agent type, model (including override), or chain; the plugin records authoritative provenance and the parent uses the plugin record even if this handover says otherwise.";
const AMP_PROVENANCE_PARAGRAPH =
  "The stored entry's recorded source thread id is the authoritative provenance; " +
  "the effective model is unknown, no model override is recorded, and there is no child chain. " +
  "Do not restate your own model identity; write the handover from the task content.";
const AMP_HANDOVER_SECTIONS = (() => {
  if (!HANDOVER_SECTIONS.includes(SHARED_PROVENANCE_PARAGRAPH)) {
    throw new Error("auto-context-handover: shared handover text drifted, refusing to register with stale provenance wording");
  }
  return HANDOVER_SECTIONS.replace(SHARED_PROVENANCE_PARAGRAPH, AMP_PROVENANCE_PARAGRAPH);
})();

export interface AmpHandoverOptions {
  readonly dir?: string;
  readonly soft?: number | undefined;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => number;
}

type DiagValue = number | "unknown";

interface CallDiag {
  readonly reason: string;
  readonly stage: string;
  readonly estimate: DiagValue;
  readonly soft: DiagValue;
}

interface PendingHandover {
  readonly handover: string;
  readonly summary: string;
  readonly diag: CallDiag;
  readonly storedAt: number;
}

const TOOL_DESCRIPTION =
  `Call this tool only after an auto-context-handover advisory notice appears, or when the user explicitly asks for a handover. ` +
  `Do not call it just to finish a task; give a normal final response instead. ` +
  `Once the notice appears (or the user asks), call exactly once per unit of work when done, then end your turn. ` +
  `Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never summarized or reworded) ` +
  `plus a short status/outcome/next-step summary in "summary".\n\n` +
  `${AMP_HANDOVER_SECTIONS}\n\n` +
  `The first successful call wins: a later call for the same thread is rejected and the original is preserved. ` +
  `After storing, end your turn; when the turn ends with status done while this thread stays focused and parentless, ` +
  `the plugin attempts one automatic fresh-root continuation, otherwise continue manually via read_handover. ` +
  `Do not paste secrets.`;

const READ_DESCRIPTION =
  `Read a stored context handover by source thread id. ` +
  `Takes a "threadID" naming any retained source thread; paths are never accepted. ` +
  `Returns the verbatim stored text plus recorded source thread metadata, pre-call diagnostics, and continuation guidance. ` +
  `Reports plainly when nothing is stored or when the stored entry is unreadable. ` +
  `It never creates threads and never retriggers automatic continuation.`;

const INTRO_TEXT =
  `auto-context-handover is active for this focused root thread. ` +
  `Soft-limit advisories may follow; each advisory applies to the current step only: ` +
  `it replaces any required final report or current-step wrap-up instruction for that step, not the whole task. ` +
  `When an advisory appears, finish the current step, then call the context_handover tool with the full handover text; ` +
  `the tool writes only plugin storage, so read-only task instructions still allow the call. ` +
  `After storing, end your turn; one automatic fresh-root continuation is attempted when the turn ends done and focused, ` +
  `otherwise continue manually via read_handover with the source thread id.`;

const NOTICE_SUFFIX =
  ` This advisory applies to the current step only: it replaces any required final report or current-step wrap-up for this step, ` +
  `not the whole task (see the thread intro message for the full workflow). ` +
  `The context estimate is a heuristic (exposed transcript chars/4, image data excluded), not an exact token count or accumulated usage. ` +
  `When done with this step, call the context_handover tool with the full handover text; ` +
  `after storing, end your turn for automatic fresh-root continuation, or continue manually via read_handover.`;

// Shared compression advice for seeds that start close to the limit.
const COMPRESS_ADVICE =
  ` At the next handover, compress carried-over completed notes while preserving critical instructions, unresolved risks and verification distinctions.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Integer-only env parsing. No percent support: no known window contract. */
export function parseAmpSoftEnv(raw: string | undefined): { readonly soft?: number; readonly error?: string } {
  if (raw === undefined) return { soft: DEFAULT_SOFT };
  if (raw.trim().length === 0) {
    return { error: `${ENV_SOFT} must be a positive integer of tokens, got ${JSON.stringify(raw)}; percentages are not supported` };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      error: `${ENV_SOFT} must be a positive integer of tokens, got ${JSON.stringify(raw)}; percentages are not supported`,
    };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { error: `${ENV_SOFT} must be a positive integer of tokens, got ${JSON.stringify(raw)}` };
  }
  return { soft: value };
}

function logInvalid(log: (message: string) => void, detail: string): void {
  try {
    log(`auto-context-handover: ${detail}. Handover advisories are disabled until it is fixed (default ${DEFAULT_SOFT}); the handover tools still work.`);
  } catch {
    // Best-effort logging only.
  }
}

const threadDir = (base: string, threadID: string): string =>
  join(base, createHash("sha256").update(threadID, "utf8").digest("hex"));

function isOwnTool(name: string): boolean {
  return name === TOOL_NAME || name === READ_TOOL_NAME || name.endsWith(`__${TOOL_NAME}`) || name.endsWith(`__${READ_TOOL_NAME}`);
}

function textChars(value: unknown): number | "unknown" {
  if (typeof value !== "string") return "unknown";
  return value.length;
}

// Chars exposed to inference for one message. Image payloads are excluded and
// replaced with a short label so large base64 blobs never skew the estimate.
function messageChars(message: ThreadMessage): number | "unknown" {
  try {
    if (!isRecord(message) || !Array.isArray((message as { content?: unknown }).content)) return "unknown";
    const content = (message as { content: unknown[] }).content;
    let chars = 0;
    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== "string") return "unknown";
      switch (block.type) {
        case "text": {
          const n = textChars(block.text);
          if (n === "unknown") return "unknown";
          chars += n;
          break;
        }
        case "thinking": {
          const n = textChars(block.thinking);
          if (n === "unknown") return "unknown";
          chars += n;
          break;
        }
        case "tool_use": {
          try {
            const rendered = JSON.stringify((block as { input?: unknown }).input ?? null);
            if (typeof rendered !== "string") return "unknown";
            chars += rendered.length;
          } catch {
            return "unknown";
          }
          break;
        }
        case "tool_result": {
          const n = toolResultOutputChars((block as { output?: unknown }).output);
          if (n === "unknown") return "unknown";
          chars += n;
          break;
        }
        default:
          return "unknown";
      }
    }
    return chars;
  } catch {
    return "unknown";
  }
}

function toolResultOutputChars(output: unknown): number | "unknown" {
  if (output === undefined) return 0;
  if (typeof output === "string") return output.length;
  if (Array.isArray(output)) {
    let chars = 0;
    for (const block of output) {
      if (!isRecord(block) || typeof block.type !== "string") return "unknown";
      if (block.type === "text") {
        const n = textChars(block.text);
        if (n === "unknown") return "unknown";
        chars += n;
      } else if (block.type === "image") {
        const mime = typeof block.mimeType === "string" ? block.mimeType : "image";
        if (typeof block.data === "string") {
          chars += `[image ${mime} omitted]`.length;
        } else if (typeof block.url === "string") {
          chars += `[image ${mime} ${block.url}]`.length;
        } else {
          return "unknown";
        }
      } else {
        return "unknown";
      }
    }
    return chars;
  }
  try {
    const rendered = JSON.stringify(output);
    if (typeof rendered !== "string") return "unknown";
    return rendered.length;
  } catch {
    return "unknown";
  }
}

interface TranscriptRead {
  readonly estimate: number | "unknown";
  readonly seenIDs: Set<string>;
  // toolUseIDs proven present as terminal tool_result blocks (done/error/
  // cancelled) only. Visible tool_use blocks prove input exists, not the
  // result, and pending/running placeholders prove nothing about the current
  // result, so neither counts here.
  readonly seenTerminalToolUseIDs: Set<string>;
}

function idKey(id: unknown): string | undefined {
  if (typeof id === "string" || typeof id === "number") return String(id);
  return undefined;
}

// Active inference-view paging from the start. Never full:true. Bounded;
// duplicate, repeated, missing/invalid-id, malformed, or erroring pages
// resolve to unknown, as does exhausting the page cap without reaching the
// end (a partial walk must never pose as a full estimate).
async function readTranscript(
  thread: Pick<PluginThread, "messages">,
  extraChars: number | "unknown" = 0,
): Promise<TranscriptRead> {
  const seenIDs = new Set<string>();
  const seenTerminalToolUseIDs = new Set<string>();
  const unknown = (): TranscriptRead => ({ estimate: "unknown", seenIDs, seenTerminalToolUseIDs });
  try {
    if (extraChars === "unknown") return unknown();
    let chars = extraChars;
    let offset = 0;
    let previousFirst: string | undefined;
    let ended = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      let batch: ThreadMessage[];
      try {
        batch = await thread.messages({ from: "start", offset, limit: PAGE_LIMIT });
      } catch {
        return unknown();
      }
      if (!Array.isArray(batch)) return unknown();
      if (batch.length === 0) {
        ended = true;
        break;
      }
      const firstKey = idKey((batch[0] as { id?: unknown })?.id);
      if (firstKey === undefined || firstKey === previousFirst) return unknown();
      previousFirst = firstKey;
      for (const message of batch) {
        const key = idKey((message as { id?: unknown })?.id);
        if (key === undefined) return unknown();
        if (seenIDs.has(key)) return unknown();
        seenIDs.add(key);
        const n = messageChars(message as ThreadMessage);
        if (n === "unknown") return unknown();
        chars += n;
        const content = (message as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block) || block.type !== "tool_result" || typeof block.toolUseID !== "string") continue;
            if (block.status !== "done" && block.status !== "error" && block.status !== "cancelled") continue;
            seenTerminalToolUseIDs.add(block.toolUseID);
          }
        }
      }
      offset += batch.length;
      if (batch.length < PAGE_LIMIT) {
        ended = true;
        break;
      }
    }
    if (!ended) return unknown();
    return { estimate: Math.ceil(chars / 4), seenIDs, seenTerminalToolUseIDs };
  } catch {
    return { estimate: "unknown", seenIDs, seenTerminalToolUseIDs: new Set<string>() };
  }
}

async function writeImmutableJSON(dir: string, file: string, payload: string): Promise<"stored" | "exists"> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, file);
  const tmp = join(dir, `tmp-${process.pid}-${randomUUID()}.json`);
  await writeFile(tmp, payload, { mode: 0o600 });
  try {
    await link(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return "exists";
    throw error;
  }
  await unlink(tmp).catch(() => undefined);
  return "stored";
}

async function writeResultJSON(dir: string, value: Record<string, unknown>): Promise<void> {
  // Best-effort diagnostics only, written non-atomically. A missing or
  // corrupt result file reads back as unknown continuation status; the
  // immutable claim (not this file) is what prevents automatic repeats.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, RESULT_FILE), JSON.stringify(value), { mode: 0o600 });
}

export function createAmpHandoverPlugin(amp: PluginAPI, options: AmpHandoverOptions = {}): void {
  const now = options.now ?? Date.now;
  let soft: number | undefined;
  if (options.soft !== undefined) {
    if (Number.isInteger(options.soft) && (options.soft as number) > 0) {
      soft = options.soft;
    } else {
      soft = undefined;
      logInvalid((message) => amp.logger.log(message), `invalid explicit soft limit ${JSON.stringify(options.soft)}: must be a positive integer of tokens`);
    }
  } else {
    const envSource = options.env ?? process.env;
    const parsed = parseAmpSoftEnv(envSource[ENV_SOFT]);
    if (parsed.error !== undefined) {
      soft = undefined;
      logInvalid((message) => amp.logger.log(message), `invalid ${parsed.error}`);
    } else {
      soft = parsed.soft;
    }
  }
  const storageBase = options.dir ?? join(homedir(), STORAGE_LEAF);
  const diagByThread = new Map<string, CallDiag>();
  const pendingByThread = new Map<string, PendingHandover>();

  const isFocusedRoot = async (thread: Pick<PluginThread, "id" | "parentThreadID">): Promise<boolean> => {
    try {
      const parent = await thread.parentThreadID();
      if (parent !== null) return false;
    } catch {
      return false;
    }
    try {
      return amp.activeThread.current?.id === thread.id;
    } catch {
      return false;
    }
  };

  amp.registerTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        handover: { type: "string", description: "Full handover text, stored verbatim." },
        summary: { type: "string", description: "Short status/outcome/next-step summary." },
      },
      required: ["handover", "summary"],
    },
    execute: async (input, ctx) => {
      const params = isRecord(input) ? input : {};
      const handover = typeof params.handover === "string" ? params.handover : "";
      const summary = typeof params.summary === "string" ? params.summary : "";
      if (handover.trim().length === 0) {
        throw new Error(`auto-context-handover: "handover" must be the full handover text, verbatim and non-empty`);
      }
      if (summary.trim().length === 0) {
        throw new Error(`auto-context-handover: "summary" must be a short status/outcome/next-step summary, non-empty`);
      }
      if (ctx.signal?.aborted) {
        throw new Error(`auto-context-handover: refusing to store: the tool call was aborted before storage`);
      }
      let parent: ThreadID | null;
      try {
        parent = await ctx.thread.parentThreadID();
      } catch {
        throw new Error(`auto-context-handover: refusing to store: the parent-thread check failed, so root status is unknown`);
      }
      if (parent !== null) {
        throw new Error(`auto-context-handover: refusing to store: only focused parentless threads may write; child and background threads are never authorized`);
      }
      try {
        if (amp.activeThread.current?.id !== ctx.thread.id) {
          throw new Error(`auto-context-handover: refusing to store: the thread is not the focused thread`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("refusing to store")) throw error;
        throw new Error(`auto-context-handover: refusing to store: the focus check failed, so authorization is unknown`);
      }
      // Preserve the observed call-time diagnostics verbatim. Reason tracks
      // whether a notice was actually appended, which stage alone cannot
      // prove (an over-soft but unsupported result appends nothing).
      const observed = diagByThread.get(ctx.thread.id);
      const diag: CallDiag = {
        reason: observed ? observed.reason : "unknown",
        stage: observed ? observed.stage : "unknown",
        estimate: observed ? observed.estimate : "unknown",
        soft: observed ? observed.soft : (soft ?? "unknown"),
      };
      const dir = threadDir(storageBase, ctx.thread.id);
      const storedAt = now();
      const payload = JSON.stringify({ version: 1, handover, summary, sourceThreadID: ctx.thread.id, storedAt, diag });
      if (typeof payload !== "string") {
        throw new Error(`auto-context-handover: failed to serialize handover, nothing was handed over`);
      }
      try {
        const outcome = await writeImmutableJSON(dir, HANDOVER_FILE, payload);
        if (outcome === "exists") {
          throw new Error(
            `auto-context-handover: a handover is already stored for thread ${JSON.stringify(ctx.thread.id)}; refusing to overwrite, the original is preserved`,
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("already stored")) throw error;
        throw new Error(`auto-context-handover: failed to store handover, nothing was handed over: ${(error as Error).message}`);
      }
      pendingByThread.set(ctx.thread.id, { handover, summary, diag, storedAt });
      let text =
        `Handover stored for thread ${ctx.thread.id}. End your turn now. ` +
        `${formatDiagLine(diag)} ` +
        `When the turn ends done while this thread stays focused and parentless, one automatic fresh-root continuation is attempted; ` +
        `otherwise start a fresh thread and call read_handover with threadID ${JSON.stringify(ctx.thread.id)}, then continue from 'Prioritized next steps'.`;
      if (soft !== undefined && seedTooLarge(Math.ceil(handover.length / 4), soft)) {
        text += ` Warning: the stored handover text alone is over 50% of the soft threshold; a successor seeded with it starts close to the limit.${COMPRESS_ADVICE}`;
      }
      return text;
    },
  });

  amp.registerTool({
    name: READ_TOOL_NAME,
    description: READ_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        threadID: { type: "string", description: "Retained source thread id to read." },
      },
      required: ["threadID"],
    },
    execute: async (input) => {
      const params = isRecord(input) ? input : {};
      const threadID = typeof params.threadID === "string" ? params.threadID : "";
      if (threadID.trim().length === 0) {
        throw new Error(`auto-context-handover: "threadID" must be a retained source thread id (non-empty string); paths are never accepted`);
      }
      const dir = threadDir(storageBase, threadID);
      let raw: string;
      try {
        raw = await readFile(join(dir, HANDOVER_FILE), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return `No handover stored for thread ${JSON.stringify(threadID)} yet.`;
        }
        throw new Error(`auto-context-handover: the stored handover for thread ${JSON.stringify(threadID)} is unreadable: ${(error as Error).message}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(
          `auto-context-handover: the stored handover for thread ${JSON.stringify(threadID)} is corrupt; refusing to replay it. ` +
            `The first stored handover is immutable, so writing again cannot replace it. ` +
            `Manual recovery requires inspecting storage at ${JSON.stringify(dir)}; no overwrite was attempted.`,
        );
      }
      if (!isRecord(parsed) || typeof parsed.handover !== "string" || typeof parsed.summary !== "string" || parsed.handover.trim().length === 0) {
        throw new Error(
          `auto-context-handover: the stored handover for thread ${JSON.stringify(threadID)} is invalid; refusing to replay it. ` +
            `The first stored handover is immutable, so writing again cannot replace it.`,
        );
      }
      const handoverText = parsed.handover as string;
      const storedAt = typeof parsed.storedAt === "number" && Number.isFinite(parsed.storedAt)
        ? new Date(parsed.storedAt as number).toISOString()
        : "unknown";
      const diag = isRecord(parsed.diag) ? parsed.diag : undefined;
      let text =
        `Handover from thread ${threadID} (stored ${storedAt}):\n` +
        `${formatDiagLine({ reason: diag?.reason, stage: diag?.stage, estimate: diag?.estimate, soft: diag?.soft })}\n\n` +
        `${handoverText}\n\n` +
        `${SEED_FRAMING} ` +
        `To continue manually, start a fresh thread and call read_handover with threadID ${JSON.stringify(threadID)}, then continue from 'Prioritized next steps'.`;
      // Continuation outcome is best-effort diagnostics, never retried: the
      // result file is written non-atomically, so a missing or corrupt
      // result reads as unknown, never as success. The immutable claim
      // prevents automatic repeats; only the guidance below applies, never
      // a blind retry after a claim.
      try {
        const resultRaw = await readFile(join(dir, RESULT_FILE), "utf8");
        let result: unknown;
        try {
          result = JSON.parse(resultRaw);
        } catch {
          result = undefined;
        }
        if (!isRecord(result) || typeof result.status !== "string") {
          text +=
            ` Automatic continuation status: unknown (the recorded outcome is unreadable; the immutable handover above stands alone. ` +
            `Inspect existing threads for a successor seeded from thread ${JSON.stringify(threadID)} before doing anything manually; ` +
            `automatic retry will not occur).`;
        } else {
          const successor = typeof result.successorThreadID === "string" ? result.successorThreadID : undefined;
          text += ` Automatic continuation status: ${result.status}${successor ? ` (successor ${successor})` : ""}.`;
          if (typeof result.error === "string" && result.error.length > 0) text += ` Detail: ${result.error}`;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          let claimed: boolean | "unknown" = false;
          try {
            await readFile(join(dir, CLAIM_FILE), "utf8");
            claimed = true;
          } catch (claimError) {
            claimed = (claimError as NodeJS.ErrnoException)?.code === "ENOENT" ? false : "unknown";
          }
          text += claimed !== false
            ? ` Automatic continuation status: unknown (a continuation claim exists or could not be read, but no outcome was recorded; ` +
              `inspect existing threads for a successor seeded from thread ${JSON.stringify(threadID)} before doing anything manually; ` +
              `do not create a successor blindly, and automatic retry will not occur).`
            : ` No automatic continuation was attempted for this thread (no continuation claim found).`;
        } else {
          text +=
            ` Automatic continuation status: unknown (the recorded outcome is unreadable: ${(error as Error).message}. ` +
            `Inspect existing threads for a successor seeded from thread ${JSON.stringify(threadID)} before doing anything manually; ` +
            `automatic retry will not occur).`;
        }
      }
      text += ` Before manually creating or seeding a successor, inspect the continuation status and any existing successor above; ` +
        `created or append-failed does not establish whether the seed was admitted. Never retry an uncertain append blindly.`;
      const softRaw = diag?.soft;
      if (typeof softRaw === "number" && seedTooLarge(Math.ceil(handoverText.length / 4), softRaw)) {
        text += ` Warning: the stored handover text alone is over 50% of the soft threshold; a fresh thread seeded with it starts close to the limit.${COMPRESS_ADVICE}`;
      }
      return text;
    },
  });

  amp.on("agent.start", async (event: AgentStartEvent, ctx) => {
    try {
      if (!(await isFocusedRoot(ctx.thread))) return {};
    } catch {
      return {};
    }
    try {
      const promptChars = typeof event.message === "string" ? event.message.length : "unknown";
      const transcript = await readTranscript(ctx.thread, 0);
      let estimate: number | "unknown" = transcript.estimate;
      if (estimate !== "unknown") {
        const seenPrompt = idKey(event.id) !== undefined && transcript.seenIDs.has(String(idKey(event.id)));
        if (!seenPrompt) {
          if (promptChars === "unknown") estimate = "unknown";
          else estimate = Math.ceil((estimate * 4 + promptChars) / 4);
        }
      }
      const stage = estimate === "unknown" || soft === undefined ? "unknown" : softStage(estimate, soft);
      // A staged start notice is an appended notice, so reason "nudged"
      // tracks the append, not the stage alone.
      const diag: CallDiag = {
        reason: stage === "unknown" ? "unknown" : stage === "ok" ? "not-nudged" : "nudged",
        stage,
        estimate,
        soft: soft ?? "unknown",
      };
      diagByThread.set(ctx.thread.id, diag);
      if (stage === "ok" || stage === "unknown") {
        return { message: { content: INTRO_TEXT, display: false } };
      }
      return { message: { content: `${INTRO_TEXT}\n\n${openCodeStageText(stage)}${NOTICE_SUFFIX}`, display: false } };
    } catch {
      return {};
    }
  });

  amp.on("tool.result", async (event: ToolResultEvent, ctx) => {
    try {
      if (!(await isFocusedRoot(ctx.thread))) return;
      if (isOwnTool(event.tool)) return;
      const currentChars = toolResultOutputChars(event.output);
      const transcript = await readTranscript(ctx.thread, 0);
      let estimate: number | "unknown" = transcript.estimate;
      if (estimate !== "unknown") {
        if (currentChars === "unknown") {
          estimate = "unknown";
        } else if (!transcript.seenTerminalToolUseIDs.has(event.toolUseID)) {
          estimate = Math.ceil((estimate * 4 + currentChars) / 4);
        }
      }
      const stage = estimate === "unknown" || soft === undefined ? "unknown" : softStage(estimate, soft);
      // Reason tracks whether a notice was actually appended below, never
      // the stage alone: an over-soft but unsupported result appends nothing.
      const record = (reason: string): void => {
        diagByThread.set(ctx.thread.id, { reason, stage, estimate, soft: soft ?? "unknown" });
      };
      if (stage === "ok" || stage === "unknown") {
        record(stage === "unknown" ? "unknown" : "not-nudged");
        return;
      }
      const notice = `${openCodeStageText(stage)}${NOTICE_SUFFIX}`;
      if (typeof event.output === "string") {
        record("nudged");
        return { status: event.status, output: `${event.output}\n\n${notice}`, error: event.error };
      }
      if (Array.isArray(event.output)) {
        const blocks = event.output as unknown[];
        let safe = true;
        for (const block of blocks) {
          if (!isRecord(block) || (block.type !== "text" && block.type !== "image")) {
            safe = false;
            break;
          }
          if (block.type === "text" && typeof block.text !== "string") {
            safe = false;
            break;
          }
        }
        if (!safe) {
          record("not-nudged");
          return;
        }
        record("nudged");
        return {
          status: event.status,
          output: [...(event.output as Array<Record<string, unknown>>), { type: "text", text: notice }],
          error: event.error,
        };
      }
      record("not-nudged");
      return;
    } catch {
      return;
    }
  });

  amp.on("agent.end", async (event: AgentEndEvent, ctx) => {
    const sourceID = ctx.thread.id;
    const pending = pendingByThread.get(sourceID);
    pendingByThread.delete(sourceID);
    // Pre-claim skips stay silent: no claim and no result exist, so the
    // reader honestly reports not-attempted and manual recovery applies.
    if (!pending) return;
    if (event.status !== "done") return;
    const stillRoot = await (async () => {
      try {
        const parent = await ctx.thread.parentThreadID();
        if (parent !== null) return false;
      } catch {
        return false;
      }
      try {
        return amp.activeThread.current?.id === sourceID;
      } catch {
        return false;
      }
    })();
    if (!stillRoot) return;
    const dir = threadDir(storageBase, sourceID);
    const claimPayload = JSON.stringify({ version: 1, sourceThreadID: sourceID, claimedAt: now(), eventId: String(event.id) });
    try {
      const outcome = await writeImmutableJSON(dir, CLAIM_FILE, claimPayload);
      if (outcome === "exists") return;
    } catch (error) {
      try {
        ctx.logger.log(`auto-context-handover: automatic continuation claim failed for thread ${sourceID}: ${(error as Error).message}`);
      } catch {
        // Best-effort logging only.
      }
      return;
    }
    let agent: Agent;
    try {
      agent = await ctx.thread.agent();
    } catch (error) {
      await writeResultJSON(dir, { version: 1, status: "agent-unavailable", error: (error as Error).message }).catch(() => undefined);
      try {
        ctx.logger.log(`auto-context-handover: automatic continuation failed for thread ${sourceID}: cannot obtain the source agent handle: ${(error as Error).message}. Read back with read_handover threadID ${JSON.stringify(sourceID)}.`);
      } catch {
        // Best-effort logging only.
      }
      return;
    }
    try {
      const parent = await ctx.thread.parentThreadID();
      if (parent !== null || amp.activeThread.current?.id !== sourceID) {
        await writeResultJSON(dir, { version: 1, status: "skipped-focus-changed" }).catch(() => undefined);
        return;
      }
    } catch {
      await writeResultJSON(dir, { version: 1, status: "unknown-focus" }).catch(() => undefined);
      return;
    }
    let successor: PluginThread;
    try {
      successor = await agent.createThread({ show: true });
    } catch (error) {
      // A create rejection is uncertain, not a confirmed failure: the
      // successor may still exist, so never imply no side effect happened.
      await writeResultJSON(dir, { version: 1, status: "create-uncertain", error: (error as Error).message }).catch(() => undefined);
      try {
        ctx.logger.log(
          `auto-context-handover: automatic continuation outcome is uncertain for thread ${sourceID}: thread creation may or may not have happened: ${(error as Error).message}. ` +
            `Check the thread list for a successor seeded from this thread before creating anything manually; ` +
            `continue manually via read_handover threadID ${JSON.stringify(sourceID)}.`,
        );
      } catch {
        // Best-effort logging only.
      }
      return;
    }
    const successorID = successor.id;
     // Record the created id before starting work: if tracking fails, do not
     // append. The empty successor can still exist and needs manual inspection.
    // The claim is preserved (never removed) to block automatic repeats.
    try {
      await writeResultJSON(dir, { version: 1, status: "created", successorThreadID: successorID });
    } catch (error) {
      try {
        ctx.logger.log(
          `auto-context-handover: automatic continuation paused for thread ${sourceID}: successor ${successorID} was created but its id could not be recorded: ${(error as Error).message}. ` +
            `No seed was appended. Inspect thread ${successorID} and seed it manually via read_handover threadID ${JSON.stringify(sourceID)} if needed; ` +
            `automatic retry will not occur.`,
        );
      } catch {
        // Best-effort logging only.
      }
      return;
    }
    const title = pending.summary.trim().slice(0, 80) || "handed-over thread";
    const seedText =
      `Continuing work handed over from thread ${sourceID}. ` +
      `${SEED_FRAMING} ` +
      `Source thread: ${sourceID}.\n\n` +
      `--- handover from thread ${sourceID} ---\n${pending.handover}\n--- end of handover ---\n\n` +
      `Continue from 'Prioritized next steps' for "${title}".`;
    if (soft !== undefined && seedTooLarge(Math.ceil(seedText.length / 4), soft)) {
      try {
        ctx.logger.log(`auto-context-handover: the successor seed alone is over 50% of the soft threshold; the new thread starts close to the limit.${COMPRESS_ADVICE}`);
      } catch {
        // Best-effort logging only.
      }
    }
    try {
      await successor.appendUserMessage({ type: "user-message", content: seedText });
      await writeResultJSON(dir, { version: 1, status: "seeded", successorThreadID: successorID }).catch(() => undefined);
    } catch (error) {
      await writeResultJSON(dir, { version: 1, status: "append-failed", successorThreadID: successorID, error: (error as Error).message }).catch(() => undefined);
      try {
        ctx.logger.log(`auto-context-handover: automatic continuation uncertain for thread ${sourceID}: successor ${successorID} was created but seeding may have failed: ${(error as Error).message}. Check the successor thread; continue manually via read_handover threadID ${JSON.stringify(sourceID)} if needed.`);
      } catch {
        // Best-effort logging only.
      }
    }
  });
}

export default function (amp: PluginAPI): void {
  createAmpHandoverPlugin(amp);
}
