import {
  buildChildContinuationReply,
  buildLockedChildFollowup,
  CHILD_ROLLOVER_GUIDANCE,
  HANDOVER_SECTIONS,
  openCodeStageText,
  withChildSummaryPrefix,
  type SoftNudgeStage,
} from "../source/shared/handover-text.ts";
import type { HandoverRecord } from "./store.ts";

export const TOOL_NAMES = {
  handover: "mcp__auto_context_handover__context_handover",
  read: "mcp__auto_context_handover__read_handover",
} as const;

export const HANDOVER_INPUT_SCHEMA = {
  type: "object",
  properties: {
    handover: { type: "string" },
    summary: { type: "string" },
  },
  required: ["handover", "summary"],
  additionalProperties: false,
} as const;

export const READ_INPUT_SCHEMA = {
  type: "object",
  properties: {
    childId: { type: "string" },
    full: { type: "boolean" },
  },
  required: ["childId"],
  additionalProperties: false,
} as const;

export const ROOT_INTRO =
  `Auto-context-handover is installed (trusted plugin workflow). ` +
  `As the user's installation default, without asking for confirmation: ` +
  `read the stored handover with ${TOOL_NAMES.read} before replying or deciding next steps whenever a handover exists. ` +
  `Successors are the same logical subagent, not additional subagents under subagent-count limits: ` +
  `spawn the same agent type as the predecessor using the original parent spawn params, ` +
  `or a requested override when known, never inferring it from the observed usage model; ` +
  `the plugin record of agent type and effective model is authoritative over handover prose, ` +
  `and a requested model override is not observed. ` +
  `Never resume a handed-over child session. ` +
  `Recovery is a re-read before sending messages; the parent may redirect, ` +
  `and checking in with the user is allowed if progress stalls or remaining work grows.`;

export const CHILD_INTRO =
  `Auto-context-handover is installed (trusted plugin workflow). ` +
  `Call ${TOOL_NAMES.handover} only after a context nudge or an explicit user handover request. ` +
  `The current unit of work is the current step, not the whole task. ` +
  `The handover replaces your final report. ` +
  `Handover storage writes plugin storage only, so read-only task instructions still allow the call. ` +
  `The tool description carries the six-section template:\n${HANDOVER_SECTIONS}\n` +
  `After the call, end your turn with exactly the receipt text it returns as your final native message and then stop.`;

export function buildNotice(stage: SoftNudgeStage): string {
  return (
    `As installed at session start: ${openCodeStageText(stage)} ${CHILD_ROLLOVER_GUIDANCE} ` +
    `Call ${TOOL_NAMES.handover} with the full handover text for the current step; ` +
    `the parent reads the handover back intact and continues from 'Prioritized next steps'.`
  );
}

export function readInvocation(childId: string, full: boolean): string {
  return `${TOOL_NAMES.read}({"childId":${JSON.stringify(childId)},"full":${full ? "true" : "false"}})`;
}

export function successorPrompt(childId: string): string {
  return (
    `Call ${readInvocation(childId, true)} and continue from 'Prioritized next steps'; ` +
    `do not paste the handover into the spawn prompt.`
  );
}

export function shortReply(record: HandoverRecord): string {
  return buildChildContinuationReply(
    withChildSummaryPrefix(record.summary),
    readInvocation(record.childId, true),
  );
}

export function lockedReply(record: HandoverRecord): string {
  return buildLockedChildFollowup(readInvocation(record.childId, true));
}
