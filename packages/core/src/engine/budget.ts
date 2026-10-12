import type { ToolCallRecord } from "./types.js";

export interface ProgressOptions {
  /** How many of the newest tool calls to judge (default 4). */
  window?: number;
  /** Share of those calls that must have succeeded (default 0.75). */
  minSuccessRate?: number;
  /** Share of those calls that must be different from each other (default 0.75). */
  minDistinctRate?: number;
  /** Records to leave out of the judgement (calls skipped only because a budget ended). */
  ignore?: (record: ToolCallRecord) => boolean;
}

export interface ProgressAssessment {
  productive: boolean;
  considered: number;
  successRate: number;
  distinctRate: number;
}

/**
 * Judges from structure alone, never from wording, whether a run that hit a
 * budget is still making real progress: its latest tool calls succeeded, did
 * not repeat each other, and the very last one worked. A run that is failing
 * or going in circles is stopped at the budget as before.
 */
export function assessProgress(records: ToolCallRecord[], options: ProgressOptions = {}): ProgressAssessment {
  const window = Math.max(2, Math.floor(options.window ?? 4));
  const considered = records.filter((record) => !options.ignore?.(record)).slice(-window);
  if (considered.length < Math.min(window, 2) || considered.length < 2) {
    return { productive: false, considered: considered.length, successRate: 0, distinctRate: 0 };
  }
  const succeeded = considered.filter((record) => record.status === "succeeded").length;
  const distinct = new Set(considered.map((record) => `${record.name}\u0000${record.arguments}`)).size;
  const successRate = succeeded / considered.length;
  const distinctRate = distinct / considered.length;
  const last = considered[considered.length - 1];
  return {
    productive:
      last.status === "succeeded" &&
      successRate >= (options.minSuccessRate ?? 0.75) &&
      distinctRate >= (options.minDistinctRate ?? 0.75),
    considered: considered.length,
    successRate,
    distinctRate,
  };
}
