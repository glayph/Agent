import type { AutonomyMode } from "./types.js";

export interface ModeProfile {
  mode: AutonomyMode;
  /** Minimum idle minutes before the controller will start considering
   * autonomous work at all (mirrors the existing >5min self-improvement
   * gate in heartbeat.ts, but is tunable per mode). */
  idleThresholdMins: number;
  /** How often (in heartbeat pulses) IDLE_DECISION re-evaluates the goal
   * queue while an objective is already running. Lower = more frequent. */
  planningEveryNPulses: number;
  /** Multiplier applied on top of HeartbeatEngine's own resource-based
   * concurrency suggestion, pushing concurrency up. */
  concurrencyMultiplier: number;
  /** Hard ceiling on concurrent autonomous (non-user) tasks, independent of
   * the action-count-per-cycle limit the spec explicitly forbids — this is
   * a resource-safety ceiling, not an autonomy-count limit (section 19). */
  maxConcurrentAutonomousTasks: number;
  /** How many goal categories get a context probe per IDLE_DECISION pass.
   * Turbo scans everything every time. */
  categoriesPerScan: number | "all";
  /** Relative frequency multipliers for background maintenance work,
   * matching the example table in the spec (section 3 / 4). */
  memoryMaintenanceFrequency: "normal" | "high";
  researchFrequency: "normal" | "high";
  projectMaintenanceFrequency: "normal" | "high";
  /** Whether independent plan steps may run in parallel via the existing
   * ConcurrentTaskManager rather than strictly sequentially. */
  parallelExecution: boolean;
  /** Deepest replan chain before an objective is marked blocked instead of
   * retried again (adaptive recovery ceiling, section 13). */
  maxReplans: number;
}

const TURBO: ModeProfile = {
  mode: "turbo",
  idleThresholdMins: 1,
  planningEveryNPulses: 1,
  concurrencyMultiplier: 1.5,
  maxConcurrentAutonomousTasks: 4,
  categoriesPerScan: "all",
  memoryMaintenanceFrequency: "high",
  researchFrequency: "high",
  projectMaintenanceFrequency: "high",
  parallelExecution: true,
  maxReplans: 5,
};

export function profileForMode(_mode: AutonomyMode): ModeProfile {
  return TURBO;
}

/** Human-readable summary matching the example tables in the spec, useful
 * for status endpoints / logs without re-deriving it from the profile. */
export function describeMode(mode: AutonomyMode): Record<string, string> {
  const p = profileForMode(mode);
  return {
    mode: mode.toUpperCase(),
    reasoning: "maximum practical",
    autonomous_planning: "high frequency",
    background_activity: "high",
    memory_maintenance: p.memoryMaintenanceFrequency,
    research: p.researchFrequency,
    project_maintenance: p.projectMaintenanceFrequency,
    parallel_execution: p.parallelExecution ? "enabled where safe" : "disabled",
  };
}
