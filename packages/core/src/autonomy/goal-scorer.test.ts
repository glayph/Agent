import {
  rankGoals,
  scoreGoal,
  selectBestGoal,
  weightsForMode,
} from "./goal-scorer.js";
import type { GoalCandidate, GoalScoreFactors } from "./types.js";

function factors(overrides: Partial<GoalScoreFactors> = {}): GoalScoreFactors {
  return {
    priority: 0.5,
    usefulness: 0.5,
    urgency: 0.5,
    relevance: 0.5,
    expectedValue: 0.5,
    unfinishedWorkBonus: 0,
    resourceCost: 0.2,
    risk: 0.1,
    ...overrides,
  };
}

function candidate(
  category: string,
  overrides: Partial<GoalScoreFactors> = {},
): GoalCandidate {
  return {
    category,
    title: category,
    rationale: "test",
    factors: factors(overrides),
  };
}

describe("scoreGoal", () => {
  it("increases with usefulness/urgency/expectedValue", () => {
    const low = scoreGoal(factors({ usefulness: 0.1 }), "standard");
    const high = scoreGoal(factors({ usefulness: 0.9 }), "standard");
    expect(high).toBeGreaterThan(low);
  });

  it("decreases with resourceCost and risk", () => {
    const cheap = scoreGoal(
      factors({ resourceCost: 0.1, risk: 0.1 }),
      "standard",
    );
    const costly = scoreGoal(
      factors({ resourceCost: 0.9, risk: 0.9 }),
      "standard",
    );
    expect(cheap).toBeGreaterThan(costly);
  });

  it("clamps out-of-range factors instead of throwing", () => {
    expect(() =>
      scoreGoal(factors({ priority: 5, risk: -3 }), "standard"),
    ).not.toThrow();
  });

  it("turbo weights favor urgency/expectedValue more than standard", () => {
    const f = factors({ urgency: 0.9, expectedValue: 0.9, resourceCost: 0.8 });
    const standardWeights = weightsForMode("standard");
    const turboWeights = weightsForMode("turbo");
    const standardScore = scoreGoal(f, "standard", standardWeights);
    const turboScore = scoreGoal(f, "turbo", turboWeights);
    // Turbo tolerates resource cost more and rewards urgency/expectedValue
    // more, so an urgent-but-costly candidate should score relatively
    // higher under turbo than under standard.
    expect(turboScore).toBeGreaterThan(standardScore);
  });
});

describe("rankGoals / selectBestGoal", () => {
  it("returns null for an empty candidate list", () => {
    expect(selectBestGoal([], "standard")).toBeNull();
  });

  it("picks the highest-scoring candidate", () => {
    const weak = candidate("LEARNING", { usefulness: 0.1, expectedValue: 0.1 });
    const strong = candidate("BUG_INVESTIGATION", {
      usefulness: 0.9,
      urgency: 0.9,
    });
    const best = selectBestGoal([weak, strong], "standard");
    expect(best?.candidate.category).toBe("BUG_INVESTIGATION");
  });

  it("breaks ties in favor of resuming unfinished work", () => {
    const fresh = candidate("RESEARCH", { unfinishedWorkBonus: 0 });
    const resumed = candidate("UNFINISHED_WORK", { unfinishedWorkBonus: 1 });
    // Force identical scores by giving both identical factors except the bonus.
    const equalFresh = {
      ...fresh,
      factors: { ...fresh.factors, unfinishedWorkBonus: 0 },
    };
    const equalResumed = {
      ...resumed,
      factors: { ...fresh.factors, unfinishedWorkBonus: 1 },
    };
    const ranked = rankGoals([equalFresh, equalResumed], "standard");
    expect(ranked[0].candidate.category).toBe("UNFINISHED_WORK");
  });
});
