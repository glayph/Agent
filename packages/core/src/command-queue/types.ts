/**
 * Step 07 — Command Queue & Concurrency types.
 * Lane-aware FIFO + per-session_key serialization + queue modes.
 */

export const QUEUE_MODES = ["steer", "followup", "collect", "interrupt"] as const;
export type QueueMode = (typeof QUEUE_MODES)[number];

export const LANES = ["main", "subagent", "heartbeat"] as const;
export type LaneId = (typeof LANES)[number];

export type DropPolicy = "reject_new" | "drop_oldest";

export interface LaneConfig {
  /** Max concurrent active runs across different session_keys in this lane. */
  concurrency: number;
}

export interface CommandQueueConfig {
  /** Global default mode when nothing else resolves. Built-in default: steer. */
  defaultMode: QueueMode;
  /** Per-surface mode overrides (surface id → mode). */
  surfaceModes?: Record<string, QueueMode>;
  /** Per-session_key mode overrides. */
  sessionModes?: Record<string, QueueMode>;
  lanes: Record<LaneId, LaneConfig>;
  /** Max pending commands per session_key (not counting the active run). */
  maxQueuePerSession: number;
  /** Max pending commands globally. */
  maxQueueGlobal: number;
  /** What to do when a per-session or global queue is full. */
  dropPolicy: DropPolicy;
  /** Debounce window (ms) for collect mode before coalescing into one turn. */
  collectDebounceMs: number;
  /**
   * When mode is steer but no mid-turn inject hook is registered,
   * fall back to this mode (default followup).
   */
  steerFallback: QueueMode;
}

export const DEFAULT_QUEUE_CONFIG: CommandQueueConfig = {
  defaultMode: "steer",
  surfaceModes: {},
  sessionModes: {},
  lanes: {
    main: { concurrency: 32 },
    subagent: { concurrency: 8 },
    heartbeat: { concurrency: 2 },
  },
  maxQueuePerSession: 32,
  maxQueueGlobal: 256,
  dropPolicy: "reject_new",
  collectDebounceMs: 400,
  steerFallback: "followup",
};

export type CommandStatus =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  | "dropped"
  | "coalesced";

export interface QueuedCommand {
  id: string;
  session_key: string;
  lane: LaneId;
  mode: QueueMode;
  message: string;
  payload?: Record<string, unknown>;
  surface?: string;
  enqueuedAt: number;
  status: CommandStatus;
  runId?: string;
  /** If coalesced into another command, points at the survivor id. */
  coalescedInto?: string;
}

export interface ActiveRun {
  runId: string;
  session_key: string;
  lane: LaneId;
  commandId: string;
  startedAt: number;
  abort: AbortController;
  /** Optional mid-turn inject for steer mode. */
  inject?: (messages: string[]) => void;
}

export interface EnqueueOptions {
  session_key: string;
  message: string;
  lane?: LaneId;
  surface?: string;
  /** Inline mode override (highest priority after explicit session map). */
  mode?: QueueMode;
  payload?: Record<string, unknown>;
  /**
   * Executor invoked when this command becomes active.
   * Must respect signal.aborted for interrupt mode.
   */
  execute?: (ctx: RunContext) => Promise<void>;
}

export interface RunContext {
  runId: string;
  command: QueuedCommand;
  signal: AbortSignal;
  /**
   * Register a steer inject hook for the active run.
   * If not registered, steer falls back to steerFallback mode.
   */
  onSteerInject?: (inject: (messages: string[]) => void) => void;
}

export interface EnqueueResult {
  accepted: boolean;
  command?: QueuedCommand;
  /** Why rejected/dropped when accepted=false. */
  reason?: string;
  /** Mode that was applied. */
  mode?: QueueMode;
  /** If interrupt aborted a previous run. */
  abortedRunId?: string;
}

export type QueueEventType =
  | "enqueued"
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "dropped"
  | "coalesced"
  | "steered";

export interface QueueEvent {
  type: QueueEventType;
  session_key: string;
  commandId?: string;
  runId?: string;
  mode?: QueueMode;
  detail?: string;
  at: number;
}

export type QueueListener = (event: QueueEvent) => void;
