import type { AutonomyMode, GoalCandidate, GoalScoreFactors } from "./types.js";

/**
 * Per-factor weights. Turbo mode leans harder into urgency/expectedValue and
 * tolerates more resource cost/risk than Standard mode, which is the concrete
 * behavioral difference the spec asks for beyond "a UI label" (section 4).
 */
export interface GoalScoreWeights {
  priority: number;
  usefulness: number;
  urgency: number;
  relevance: number;
  expectedValue: number;
  unfinishedWorkBonus: number;
  resourceCost: number;
  risk: number;
}

const STANDARD_WEIGHTS: GoalScoreWeights = {
  priority: 1.0,
  usefulness: 1.0,
  urgency: 0.8,
  relevance: 1.0,
  expectedValue: 1.0,
  unfinishedWorkBonus: 1.2,
  resourceCost: 1.0,
  risk: 1.4,
};

const TURBO_WEIGHTS: GoalScoreWeights = {
  priority: 1.1,
  usefulness: 1.2,
  urgency: 1.3,
  relevance: 1.0,
  expectedValue: 1.3,
  unfinishedWorkBonus: 1.0,
  resourceCost: 0.6,
  risk: 0.9,
};

export function weightsForMode(mode: AutonomyMode): GoalScoreWeights {
  return mode === "turbo" ? TURBO_WEIGHTS : STANDARD_WEIGHTS;
}

/**
 * Goal Score =
 *   priority + usefulness + urgency + relevance + expected_value
 *   + unfinished_work_bonus - resource_cost - risk
 *
 * Every factor is expected in [0, 1]; weights scale each term's
 * contribution per mode. The result is not clamped — candidates are only
 * ever compared relative to each other, never against an absolute
 * threshold, so there is nothing to hard-code here that would silently
 * exclude a legitimate goal category.
 */
export function scoreGoal(
  factors: GoalScoreFactors,
  mode: AutonomyMode,
  weights: GoalScoreWeights = weightsForMode(mode),
): number {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const f = {
    priority: clamp01(factors.priority),
    usefulness: clamp01(factors.usefulness),
    urgency: clamp01(factors.urgency),
    relevance: clamp01(factors.relevance),
    expectedValue: clamp01(factors.expectedValue),
    unfinishedWorkBonus: clamp01(factors.unfinishedWorkBonus),
    resourceCost: clamp01(factors.resourceCost),
    risk: clamp01(factors.risk),
  };

  return (
    f.priority * weights.priority +
    f.usefulness * weights.usefulness +
    f.urgency * weights.urgency +
    f.relevance * weights.relevance +
    f.expectedValue * weights.expectedValue +
    f.unfinishedWorkBonus * weights.unfinishedWorkBonus -
    f.resourceCost * weights.resourceCost -
    f.risk * weights.risk
  );
}

/**
 * Ranks candidates highest score first. Ties broken by unfinished-work
 * bonus (resuming existing objectives beats starting new ones, all else
 * equal) then by category name for determinism in tests.
 */
export function rankGoals(
  candidates: GoalCandidate[],
  mode: AutonomyMode,
): { candidate: GoalCandidate; score: number }[] {
  const weights = weightsForMode(mode);
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreGoal(candidate.factors, mode, weights),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const bonusDiff =
        b.candidate.factors.unfinishedWorkBonus -
        a.candidate.factors.unfinishedWorkBonus;
      if (bonusDiff !== 0) return bonusDiff;
      return String(a.candidate.category).localeCompare(
        String(b.candidate.category),
      );
    });
}

export function selectBestGoal(
  candidates: GoalCandidate[],
  mode: AutonomyMode,
): { candidate: GoalCandidate; score: number } | null {
  if (candidates.length === 0) return null;
  return rankGoals(candidates, mode)[0];
}
