/**
 * AgentAggregator — Phase 4: Result Aggregation & Failure Replanning
 *
 * When multiple specialists complete work in parallel, their raw results must
 * be merged into a coherent response and any failures must be identified so
 * the planner can retry them.
 *
 * Responsibilities:
 *   1. Merge parallel DelegationResult[] into a structured final response
 *   2. Detect failures and return the PlanSteps that need replanning
 *   3. Produce a human-readable summary of the swarm's work
 */

import type { PlanStep } from "./agent-planner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegationResult {
  /** Corresponds to PlanStep.id */
  stepId: string;
  /** The agent instance ID that executed this step */
  agentId: string;
  /** The specialist role (e.g. "sage", "forge") */
  specialistId: string;
  /** Whether the step completed successfully */
  success: boolean;
  /** Raw output text from the specialist */
  output: string;
  /** Wall-clock duration the specialist took */
  durationMs: number;
  /** Optional structured data payload from the specialist */
  data?: unknown;
  /** Error message if success === false */
  error?: string;
}

export interface AggregationResult {
  /** Merged response suitable for returning to the user */
  response: string;
  /** Which steps failed and should be retried */
  failedSteps: PlanStep[];
  /** Structured metadata about each specialist's contribution */
  contributions: ContributionSummary[];
  /** True if all steps succeeded */
  allSucceeded: boolean;
  /** Total wall-clock time across all parallel branches */
  totalDurationMs: number;
  /** Longest single-step duration (critical-path bottleneck) */
  criticalPathMs: number;
}

export interface ContributionSummary {
  stepId: string;
  agentId: string;
  specialistId: string;
  success: boolean;
  durationMs: number;
  excerpt: string;
}

// ---------------------------------------------------------------------------
// AgentAggregator
// ---------------------------------------------------------------------------

export class AgentAggregator {
  /**
   * Merge parallel results from multiple specialists into a coherent response.
   *
   * Strategy:
   * - Successful results are ordered by step dependency / insertion order
   * - Each specialist's output is attributed and concatenated
   * - Failed steps are extracted for replanning
   */
  aggregate(
    results: DelegationResult[],
    stepMap?: Map<string, PlanStep>,
  ): AggregationResult {
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    const contributions: ContributionSummary[] = results.map((r) => ({
      stepId: r.stepId,
      agentId: r.agentId,
      specialistId: r.specialistId,
      success: r.success,
      durationMs: r.durationMs,
      excerpt: this._excerpt(r.output, 200),
    }));

    const responseParts: string[] = [];

    if (successful.length > 0) {
      for (const result of successful) {
        const header = `### [${result.specialistId.toUpperCase()}] Step ${result.stepId}`;
        responseParts.push(`${header}\n${result.output.trim()}`);
      }
    }

    if (failed.length > 0) {
      const failedSummary = failed
        .map(
          (r) =>
            `- Step ${r.stepId} (${r.specialistId}): ${r.error ?? "unknown error"}`,
        )
        .join("\n");
      responseParts.push(`### Failed Steps\n${failedSummary}`);
    }

    const response = responseParts.join("\n\n---\n\n");

    const failedSteps: PlanStep[] = failed
      .map((r) => stepMap?.get(r.stepId))
      .filter((s): s is PlanStep => s !== undefined);

    const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);
    const criticalPathMs = results.reduce(
      (max, r) => Math.max(max, r.durationMs),
      0,
    );

    return {
      response,
      failedSteps,
      contributions,
      allSucceeded: failed.length === 0,
      totalDurationMs,
      criticalPathMs,
    };
  }

  /**
   * Identify failed steps that should be handed back to the planner for retry.
   * Returns steps sorted by their estimated cost (cheapest retry first).
   */
  detectFailures(results: DelegationResult[]): PlanStep[] {
    // We only have partial information here (just stepIds); the full PlanStep
    // objects live in the planner. Return placeholder stubs that the caller
    // can enrich from the planner's cache.
    return results
      .filter((r) => !r.success)
      .map((r) => ({
        id: r.stepId,
        goal: `retry_${r.stepId}`,
        action: `Retry failed step ${r.stepId} (originally handled by ${r.specialistId})`,
        preconditions: [],
        estimatedCost: 2,
        successLikelihood: 0.7,
        assignedSpecialist: r.specialistId,
      }));
  }

  /**
   * Produce a concise markdown summary of the swarm's performance.
   */
  summarize(result: AggregationResult): string {
    const successCount = result.contributions.filter((c) => c.success).length;
    const failCount = result.contributions.length - successCount;
    const lines = [
      `**Swarm Summary**`,
      `- Steps: ${result.contributions.length} total, ${successCount} succeeded, ${failCount} failed`,
      `- Wall-clock: ${result.totalDurationMs.toLocaleString()} ms total | ${result.criticalPathMs.toLocaleString()} ms critical path`,
      ``,
      `| Step | Specialist | Status | Duration |`,
      `|------|-----------|--------|----------|`,
      ...result.contributions.map(
        (c) =>
          `| ${c.stepId} | ${c.specialistId} | ${c.success ? "✅" : "❌"} | ${c.durationMs} ms |`,
      ),
    ];
    return lines.join("\n");
  }

  // ---- Private helpers -----------------------------------------------------

  private _excerpt(text: string, maxChars: number): string {
    const trimmed = text.trim();
    if (trimmed.length <= maxChars) return trimmed;
    return trimmed.slice(0, maxChars) + "…";
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const globalAgentAggregator = new AgentAggregator();
