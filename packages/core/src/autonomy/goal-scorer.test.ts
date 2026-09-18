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
    const low = scoreGoal(factors({ usefulness: 0.1 }), "turbo");
    const high = scoreGoal(factors({ usefulness: 0.9 }), "turbo");
    expect(high).toBeGreaterThan(low);
  });

  it("decreases with resourceCost and risk", () => {
    const cheap = scoreGoal(
      factors({ resourceCost: 0.1, risk: 0.1 }),
      "turbo",
    );
    const costly = scoreGoal(
      factors({ resourceCost: 0.9, risk: 0.9 }),
      "turbo",
    );
    expect(cheap).toBeGreaterThan(costly);
  });

  it("clamps out-of-range factors instead of throwing", () => {
    expect(() =>
      scoreGoal(factors({ priority: 5, risk: -3 }), "turbo"),
    ).not.toThrow();
  });

  // Standard mode's weight table has been removed (owner-requested — turbo
  // is the only mode now), so this just pins down turbo's own fixed weights
  // rather than comparing it against a standard baseline that no longer
  // exists.
  it("always resolves to turbo's fixed weight table", () => {
    const weights = weightsForMode("turbo");
    expect(weights).toEqual({
      priority: 1.1,
      usefulness: 1.2,
      urgency: 1.3,
      relevance: 1.0,
      expectedValue: 1.3,
      unfinishedWorkBonus: 1.0,
      resourceCost: 0.6,
      risk: 0.9,
    });
  });
});

describe("rankGoals / selectBestGoal", () => {
  it("returns null for an empty candidate list", () => {
    expect(selectBestGoal([], "turbo")).toBeNull();
  });

  it("picks the highest-scoring candidate", () => {
    const weak = candidate("LEARNING", { usefulness: 0.1, expectedValue: 0.1 });
    const strong = candidate("BUG_INVESTIGATION", {
      usefulness: 0.9,
      urgency: 0.9,
    });
    const best = selectBestGoal([weak, strong], "turbo");
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
    const ranked = rankGoals([equalFresh, equalResumed], "turbo");
    expect(ranked[0].candidate.category).toBe("UNFINISHED_WORK");
  });
});
