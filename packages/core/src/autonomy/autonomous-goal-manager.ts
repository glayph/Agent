import * as crypto from "crypto";
import type {
  AutonomyContext,
  AutonomyMode,
  GoalCandidate,
  Objective,
  PlanStep,
} from "./types.js";
import { getGoalDefinition, listGoalDefinitions } from "./goal-catalog.js";
import { rankGoals } from "./goal-scorer.js";
import { profileForMode } from "./mode-config.js";
import type { SqliteObjectiveStore } from "./objective-store.js";
import { logAutonomyEvent } from "./logging.js";

const AUTONOMY_TAG_RE = /^\[\[miki-autonomy:([^\]]+)\]\]\s*\n?([\s\S]*)$/;

/** Tags a synthesized task message so the executing agent loop (and the
 * completion handler) can recognize which objective it belongs to —
 * mirrors the existing `[[miki-automation:...]]` convention in
 * automation.ts rather than inventing a new envelope format. */
export function formatAutonomyMessage(
  objectiveId: string,
  prompt: string,
): string {
  return `[[miki-autonomy:${objectiveId}]]\n${prompt}`;
}

export function parseAutonomyMessage(
  message: string,
): { objectiveId: string; prompt: string } | null {
  const match = message.match(AUTONOMY_TAG_RE);
  if (!match) return null;
  return { objectiveId: match[1], prompt: match[2].trim() };
}

export interface GoalDecision {
  objective: Objective;
  taskMessage: string;
}

export interface GoalOutcome {
  success: boolean;
  summary: string;
  error?: string;
}

export class AutonomousGoalManager {
  private _scanCycle = 0;

  constructor(private store: SqliteObjectiveStore) {}

  /**
   * Spec section 5, steps 1-7: collect context, inspect memory / active
   * objectives / environment, identify opportunities, score them, select
   * the best one, and generate an executable plan. Returns null when there
   * is genuinely nothing useful to do — that is a legitimate outcome, not
   * a failure (section 7 forbids inventing filler work).
   */
  decide(ctx: AutonomyContext): GoalDecision | null {
    this._scanCycle++;
    const profile = profileForMode(ctx.mode);
    const defs = this._categoriesToScan(profile.categoriesPerScan);

    const candidates: GoalCandidate[] = [];
    for (const definition of defs) {
      try {
        candidates.push(...definition.probe(ctx));
      } catch (err) {
        // One misbehaving probe must never block goal selection entirely.
        logAutonomyEvent("ACTION_FAILED", {
          phase: "probe",
          category: definition.category,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (candidates.length === 0) return null;

    const ranked = rankGoals(candidates, ctx.mode);
    const best = ranked[0];
    const definition = getGoalDefinition(best.candidate.category);
    const planSteps = definition
      ? definition.buildPlan(best.candidate, ctx)
      : [];

    const objective = this._materializeObjective(best.candidate, planSteps);
    this.store.update(objective);

    logAutonomyEvent("OBJECTIVE_SELECTED", {
      id: objective.id,
      type: objective.type,
      score: best.score,
      candidates: candidates.length,
      resumed: !!best.candidate.resumeObjectiveId,
    });
    logAutonomyEvent("PLAN_CREATED", {
      id: objective.id,
      steps: objective.plan.length,
    });

    return {
      objective,
      taskMessage: formatAutonomyMessage(
        objective.id,
        this._renderPrompt(objective),
      ),
    };
  }

  /**
   * Spec section 8/12/13: observe → evaluate → store result → decide
   * whether to finish, retry, or give up. `mode` determines how many
   * replans are tolerated before an objective is parked as `blocked`
   * instead of retried forever (adaptive recovery, not a hard-coded loop).
   */
  recordOutcome(
    objectiveId: string,
    outcome: GoalOutcome,
    mode: AutonomyMode,
  ): Objective | undefined {
    const objective = this.store.get(objectiveId);
    if (!objective) return undefined;

    if (outcome.success) {
      objective.status = "completed";
      objective.progress = 1;
      objective.result = { summary: outcome.summary };
      logAutonomyEvent("OBJECTIVE_COMPLETED", {
        id: objective.id,
        type: objective.type,
      });
    } else {
      objective.replans += 1;
      objective.result = { error: outcome.error ?? outcome.summary };
      const maxReplans = profileForMode(mode).maxReplans;
      if (objective.replans > maxReplans) {
        objective.status = "blocked";
        logAutonomyEvent("OBJECTIVE_ABORTED", {
          id: objective.id,
          reason: "max_replans_exceeded",
          replans: objective.replans,
        });
      } else {
        // Left as "pending" (not "failed") so it re-enters the unfinished
        // pool and can be picked up/replanned on a future IDLE_DECISION
        // pass rather than being treated as permanently done.
        objective.status = "pending";
        logAutonomyEvent("REPLAN", {
          id: objective.id,
          attempt: objective.replans,
        });
      }
    }
    objective.activeTaskId = undefined;
    objective.updatedAt = Date.now();
    this.store.update(objective);
    logAutonomyEvent("MEMORY_UPDATED", {
      id: objective.id,
      status: objective.status,
    });
    return objective;
  }

  private _categoriesToScan(categoriesPerScan: number | "all") {
    const all = listGoalDefinitions();
    if (categoriesPerScan === "all" || all.length <= categoriesPerScan) {
      return all;
    }
    const start = this._scanCycle % all.length;
    const window: typeof all = [];
    for (let i = 0; i < categoriesPerScan; i++) {
      window.push(all[(start + i) % all.length]);
    }
    return window;
  }

  private _materializeObjective(
    candidate: GoalCandidate,
    planSteps: PlanStep[],
  ): Objective {
    const now = Date.now();
    if (candidate.resumeObjectiveId) {
      const existing = this.store.get(candidate.resumeObjectiveId);
      if (existing) {
        existing.status = "in_progress";
        existing.updatedAt = now;
        if (existing.plan.length === 0) existing.plan = planSteps;
        existing.context = {
          ...existing.context,
          ...(candidate.context ?? {}),
        };
        return existing;
      }
    }
    const objective: Objective = {
      id: `objective-${now}-${crypto.randomUUID().slice(0, 8)}`,
      type: candidate.category,
      status: "in_progress",
      title: candidate.title,
      rationale: candidate.rationale,
      createdAt: now,
      updatedAt: now,
      priority: candidate.factors.priority,
      progress: 0,
      plan: planSteps,
      context: candidate.context ?? {},
      result: null,
      replans: 0,
    };
    logAutonomyEvent("OBJECTIVE_CREATED", {
      id: objective.id,
      type: objective.type,
    });
    return objective;
  }

  private _renderPrompt(objective: Objective): string {
    const steps = objective.plan
      .map((s, i) => `${i + 1}. ${s.description}`)
      .join("\n");
    return [
      `Autonomous objective (category: ${objective.type}): ${objective.title}`,
      "",
      `Rationale: ${objective.rationale}`,
      "",
      "Plan:",
      steps,
      "",
      "Work through this plan using your available tools. If a step turns " +
        "out to be unnecessary or blocked, adapt rather than stalling. When " +
        "finished, summarize what you did, what you found, and the outcome.",
    ].join("\n");
  }
}
