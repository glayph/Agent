/**
 * Step 09 — Cron Scheduler types (OpenClaw-style persisted jobs).
 */

export type CronScheduleKind = "once" | "cron";

export type CronExecutionStyle = "main" | "isolated";

/** What to do when a fire time was missed (process was down). */
export type MissedRunPolicy = "skip" | "run_on_load";

export interface CronSchedule {
  kind: CronScheduleKind;
  /**
   * One-shot: ISO timestamp or epoch ms.
   * Recurring: 5-field cron, or @hourly/@daily/@weekly, or "every N minutes".
   */
  expr: string;
  timezone?: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  /** Message / prompt payload to run. */
  payload: string;
  executionStyle: CronExecutionStyle;
  /** Optional delivery target (channel/session hint). */
  deliveryTarget?: string;
  deleteAfterRun: boolean;
  missedRunPolicy: MissedRunPolicy;
  /**
   * When true, fire immediately into queue; when false, may wait for next
   * heartbeat tick if a HeartbeatScheduler is attached.
   */
  wakeNow: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Next planned fire (ISO). */
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  runCount: number;
}

export interface CronJobInput {
  name: string;
  schedule: CronSchedule;
  payload: string;
  executionStyle?: CronExecutionStyle;
  deliveryTarget?: string;
  deleteAfterRun?: boolean;
  missedRunPolicy?: MissedRunPolicy;
  wakeNow?: boolean;
  enabled?: boolean;
}

export interface CronStoreSnapshot {
  version: 1;
  jobs: CronJob[];
}

export interface CronRunResult {
  jobId: string;
  accepted: boolean;
  deleted?: boolean;
  error?: string;
  session_key?: string;
}
