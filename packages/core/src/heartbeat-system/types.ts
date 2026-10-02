/**
 * Step 08 — Heartbeat System types (OpenClaw-style proactive loop).
 */

export type HeartbeatResponseType =
  | "no_op"
  | "proactive_notify"
  | "silent_tool_run"
  | "memory_update";

export interface QuietHours {
  /** Local time "HH:MM" inclusive start. */
  start: string;
  /** Local time "HH:MM" exclusive end (supports overnight window). */
  end: string;
  /** IANA timezone, e.g. "Asia/Dhaka". Default: system local. */
  timezone?: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  /** Interval between cycles in seconds. Default 1800 (30 min). */
  intervalSeconds: number;
  quietHours?: QuietHours | null;
  /**
   * Path to HEARTBEAT.md relative to identity/workspace root,
   * or absolute. Default: identity/HEARTBEAT.md
   */
  checklistPath?: string;
  /** When true, skip enqueue if any main-lane session is active. */
  skipWhenMainBusy?: boolean;
  /** Max checklist items executed per cycle (0 = unlimited). */
  maxItemsPerCycle?: number;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: true,
  intervalSeconds: 1800,
  quietHours: null,
  checklistPath: "identity/HEARTBEAT.md",
  skipWhenMainBusy: true,
  maxItemsPerCycle: 0,
};

export interface ChecklistItem {
  /** 1-based line number in HEARTBEAT.md */
  line: number;
  text: string;
}

export interface HeartbeatItemResult {
  item: ChecklistItem;
  responseType: HeartbeatResponseType;
  summary: string;
  dryRun: boolean;
}

export interface HeartbeatCycleResult {
  cycleId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  suppressed: boolean;
  suppressReason?: string;
  items: HeartbeatItemResult[];
  /** Human-readable report (especially useful for dry_run). */
  report: string;
}

export interface HeartbeatHooks {
  /**
   * Optional: true if any main-lane user session is currently active.
   * Used with skipWhenMainBusy.
   */
  isMainLaneBusy?: () => boolean;
  /** Optional notify sink for proactive_notify responses. */
  notify?: (message: string) => void | Promise<void>;
  /** Optional memory write for memory_update responses. */
  memoryUpdate?: (note: string) => void | Promise<void>;
  /**
   * Optional tool runner for silent_tool_run.
   * Receives checklist line text; implementer decides tools.
   */
  runSilentTools?: (
    item: ChecklistItem,
    signal: AbortSignal,
  ) => Promise<{ summary: string }>;
  /**
   * Classify a checklist item into a response type.
   * Default classifier uses simple prefixes in HEARTBEAT.md.
   */
  classify?: (item: ChecklistItem) => HeartbeatResponseType;
  /** Observability logger. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface HeartbeatSchedulerStatus {
  running: boolean;
  enabled: boolean;
  intervalSeconds: number;
  lastCycleAt?: string;
  nextCycleAt?: string;
  lastResult?: HeartbeatCycleResult;
  inQuietHours: boolean;
}
