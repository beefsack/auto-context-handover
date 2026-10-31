// Minimal structural subset of the Claude Code mod contracts used by this adapter.
// Provenance: canonical header 2.1.277
// (raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts)
// plus the official docs /docs/en/plugins/mods/{events,api,reference}, /hooks,
// /tools-reference. This is a small documented subset, not a vendored corpus:
// it covers only the events and methods this adapter uses. Do not claim full
// installed-version compatibility from these types. Node-free.

export interface TurnUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
  readonly model: string
}

export interface TurnStepResult {
  readonly turnId: string
  readonly index: number
  readonly answer: string
  readonly usage: TurnUsage | null
  /** Client tool calls made while producing the response (tool.call hooks fire for these). Absent when none. Not serverToolUses. */
  readonly toolUses?: readonly unknown[]
  /** Why the request stopped. Shape is host-defined; read opaquely. */
  readonly stopReason?: unknown
}

export interface TurnStepEvent {
  readonly turnId: string
  readonly index: number
  readonly model: string
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | number
  readonly messageCount: number
  readonly agentId?: string
}

export interface TurnStepChunk {
  readonly kind: string
  readonly [field: string]: unknown
}

export interface AgentInfo {
  readonly id: string
  readonly description?: string
  readonly type?: string
  readonly parentId?: string
  /** Engine task status: running, completed, failed, killed, or another engine status. Absent/unknown retains liveness. */
  readonly status?: string
}

export interface ToolCallEvent {
  readonly tool: string
  readonly tool_use_id?: string
  /** Loop identity for subagent/teammate calls; absent on the main loop. */
  readonly agentId?: string
  readonly [field: string]: unknown
}

/** Refused ({ deny }), answered ({ result }), or failed ({ result, isError }) — never invent other flags. */
export type ToolCallResult =
  | { readonly deny: string }
  | { readonly result: unknown; readonly isError?: boolean; readonly context?: readonly string[] }

export interface ClassicSubagentStartEvent {
  readonly agent_id?: unknown
  readonly agent_type?: unknown
  readonly [field: string]: unknown
}

export interface ClassicSubagentStartResult {
  readonly additionalContext?: string[]
  readonly [field: string]: unknown
}

export interface ClassicBatchEvent {
  readonly agent_id?: unknown
  readonly session_id?: unknown
  readonly [field: string]: unknown
}

export interface ClassicBatchResult {
  readonly additionalContext?: string[]
  readonly [field: string]: unknown
}

export interface ClassicSubagentStopEvent {
  readonly agent_id?: unknown
  readonly stop_hook_active?: unknown
  readonly last_assistant_message?: unknown
  readonly [field: string]: unknown
}

export interface ClassicSubagentStopResult {
  readonly block?: string
  readonly preventContinuation?: unknown
  readonly additionalContext?: string[]
  readonly [field: string]: unknown
}

export interface ClassicSessionStartEvent {
  /** Absent on the main loop (even under --agent); present inside child loops. Guard on this, not agent_type. */
  readonly agent_id?: unknown
  readonly source?: unknown
  readonly agent_type?: unknown
  readonly [field: string]: unknown
}

export interface ClassicSessionStartResult {
  readonly additionalContext?: string[]
  readonly [field: string]: unknown
}

export interface AgentSpawnInput {
  /** Resolved agent type the spawn dispatches (fork dispatches no other). */
  readonly subagentType?: unknown
  /** Requested model override alias/id; undefined means agent then parent default; ignored when fork is true. */
  readonly model?: unknown
  /**
   * Spawn prompt text. Canonical mod contract documents `prompt` on the
   * spawn input (raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts):
   * the adapter reads it observe-only to capture the original task once per
   * chain and to parse the short successor marker. Never rewritten.
   */
  readonly prompt?: unknown
  readonly fork?: unknown
  readonly [field: string]: unknown
}

export type AgentSpawnResult =
  | { readonly model?: unknown; readonly agentId?: unknown; readonly deny?: undefined; readonly [field: string]: unknown }
  | { readonly deny: string; readonly model?: undefined; readonly agentId?: undefined; readonly [field: string]: unknown }

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema?: Record<string, unknown>
}

export interface Engine {
  readonly tool: {
    readonly register: (tool: ToolSpec) => Promise<{ readonly tool: string }>
  }
  readonly store: {
    readonly get: (key: string) => Promise<unknown>
    readonly set: (key: string, value: unknown) => Promise<void>
    readonly delete: (key: string) => Promise<void>
    /** All keys. The official host supports enumeration; without it advisory hooks skip their scan (no eviction), while handover persistence explicitly refuses the write (retryable). */
    readonly keys: () => Promise<string[]>
  }
  readonly agent: {
    readonly list: () => Promise<AgentInfo[]>
  }
  readonly session: {
    readonly id: () => Promise<string>
  }
}

export type TurnStepNext = (
  event: TurnStepEvent,
) => AsyncGenerator<TurnStepChunk, TurnStepResult, TurnStepResult | undefined>

export type TurnStepHook = (
  $: Engine,
  event: TurnStepEvent,
  next: TurnStepNext,
) => AsyncGenerator<TurnStepChunk, TurnStepResult, TurnStepResult | undefined>

export type PlainHook<E, R> = ($: Engine, event: E, next: (event: E) => Promise<R>) => Promise<R>

// In a catch handler, next replays its prior outcome when called is true.
export interface CatchNext<E, R> {
  (event: E): Promise<R>
  readonly called: boolean
  readonly error: {
    readonly kind: "throw" | "timeout" | "re-entry"
    readonly message?: string
  }
}

export type PlainCatchHook<E, R> = ($: Engine, event: E, next: CatchNext<E, R>) => Promise<R | undefined>

export interface HookRegistration<E, R> {
  readonly catch: (handler: PlainCatchHook<E, R>) => void
}

export interface On {
  (event: "session.start", hook: PlainHook<unknown, unknown>): HookRegistration<unknown, unknown>
  (event: "turn.step", hook: TurnStepHook): void
  (event: "classic.SessionStart", hook: PlainHook<ClassicSessionStartEvent, ClassicSessionStartResult>): HookRegistration<ClassicSessionStartEvent, ClassicSessionStartResult>
  (event: "classic.PostToolBatch", hook: PlainHook<ClassicBatchEvent, ClassicBatchResult>): HookRegistration<ClassicBatchEvent, ClassicBatchResult>
  (event: "classic.SubagentStart", hook: PlainHook<ClassicSubagentStartEvent, ClassicSubagentStartResult>): HookRegistration<ClassicSubagentStartEvent, ClassicSubagentStartResult>
  (event: "classic.SubagentStop", hook: PlainHook<ClassicSubagentStopEvent, ClassicSubagentStopResult>): HookRegistration<ClassicSubagentStopEvent, ClassicSubagentStopResult>
  (event: "agent.spawn", hook: PlainHook<AgentSpawnInput, AgentSpawnResult>): HookRegistration<AgentSpawnInput, AgentSpawnResult>
  (event: "tool.call", hook: PlainHook<ToolCallEvent, ToolCallResult>): HookRegistration<ToolCallEvent, ToolCallResult>
  (event: "session.end", hook: PlainHook<SessionEndEvent, unknown>): HookRegistration<SessionEndEvent, unknown>
  (event: "turn.complete", hook: PlainHook<TurnCompleteEvent, unknown>): HookRegistration<TurnCompleteEvent, unknown>
}

export interface RegisterOptions {
  readonly soft?: unknown
  readonly [field: string]: unknown
}

export interface SessionEndEvent {
  readonly reason?: unknown
  readonly sessionId?: unknown
  readonly resume?: unknown
  readonly [field: string]: unknown
}

export interface TurnCompleteEvent {
  readonly agentId?: unknown
  readonly turnId?: unknown
  readonly reason?: unknown
  readonly [field: string]: unknown
}

export type Register = (on: On, options?: RegisterOptions) => void | Promise<void>
