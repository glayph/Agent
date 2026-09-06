import { calculateReward, SelfImprovementEngine } from "./engine.js";

import { jest } from "@jest/globals";

type StoredExperience = {
  id: string;
  actionKey: string;
  contextHash: string;
  contextSummary: string;
  outcome: string;
  reward: number;
  rewardComponents: Record<string, number>;
  actionPayload: Record<string, unknown>;
  policyVersion: number;
  modelId: string | null;
  createdAt: string;
};

function makeStore() {
  const rows: StoredExperience[] = [];
  const policy = {
    policyVersion: 1,
    mode: "observe",
    actionStats: {},
    totalDecisions: 0,
    averageReward: 0,
    baselineAction: null,
  };
  return {
    rows,
    policy,
    normalizeScope: () => ({
      agentId: "miki",
      ownerId: "owner",
      workspaceId: "workspace",
      scopeKey: "miki:owner:workspace",
    }),
    recordExperience(input: Record<string, unknown>) {
      const duplicate = rows.find(
        (row) =>
          row.contextHash === input.contextHash &&
          row.outcome === input.outcome,
      );
      if (duplicate) return { stored: false, duplicate: true, row: duplicate };
      const row = {
        id: `experience-${rows.length + 1}`,
        actionKey: String(input.actionKey),
        contextHash: String(input.contextHash),
        contextSummary: String(input.contextSummary || ""),
        outcome: String(input.outcome),
        reward: Number(input.reward),
        rewardComponents: (input.rewardComponents || {}) as Record<
          string,
          number
        >,
        actionPayload: (input.actionPayload || {}) as Record<string, unknown>,
        policyVersion: Number(input.policyVersion || 1),
        modelId: (input.modelId as string | null) || null,
        createdAt: new Date().toISOString(),
      };
      rows.push(row);
      return { stored: true, duplicate: false, row };
    },
    listExperiences: () => rows,
    getExperienceStats: () => ({
      total: rows.length,
      averageReward: rows[0]?.reward || 0,
      actions: [],
      outcomes: [],
    }),
    readPolicyState: () => policy,
    upsertPolicyState: (_scope: unknown, state: Record<string, unknown>) =>
      Object.assign(policy, state),
    startCycle: () => ({ id: "cycle-1", status: "running" }),
    finishCycle: (_id: string, result: Record<string, unknown>) => ({
      ...result,
      status: result.status || "completed",
    }),
    countCyclesSince: () => 0,
    lastCycle: () => null,
    createProposal: () => ({ id: "proposal-1", status: "draft" }),
    listProposals: () => [],
  };
}

describe("SelfImprovementEngine durable learning", () => {
  it("calculates bounded, explainable rewards", () => {
    const success = calculateReward({
      outcome: "success",
      completionQuality: 1,
      taskSuccess: 1,
      verificationSuccess: 1,
      latencyScore: 1,
    });
    expect(success.reward).toBeGreaterThan(0.7);
    expect(success.reward).toBeLessThanOrEqual(1);

    const failure = calculateReward({
      outcome: "failure",
      completionQuality: 0,
      taskSuccess: 0,
      verificationSuccess: 0,
      retryCount: 3,
      safetyViolation: 1,
    });
    expect(failure.reward).toBeLessThan(0);
    expect(failure.reward).toBeGreaterThanOrEqual(-1);
  });

  it("runs durable reflection and optimization cycles with truthful results", async () => {
    const store = makeStore();
    const engine = new SelfImprovementEngine(
      { tkg: { learningStore: store } },
      {},
      async () => ({
        choices: [
          {
            message: {
              content:
                '{"finding":"stable","confidence":0.8,"recommendation":"keep baseline"}',
            },
          },
        ],
      }),
      {
        enabled: true,
        behavior_learning: {
          mode: "draft",
          min_samples: 3,
          max_draft_notes: 3,
        },
      },
    );
    engine.recordExperience({
      actionKey: "model:local-lfm",
      context: "cycle request",
      outcome: "success",
      rewardInput: { outcome: "success", completionQuality: 1 },
      idempotencyKey: "cycle-run-1",
    });
    const reflection = await engine.runReflectionCycle({ force: true });
    expect(reflection.status).toBe("completed");
    expect(reflection.outputCount).toBe(1);
    const optimization = await engine.runOptimizationCycle({ force: true });
    expect(optimization.status).toBe("completed");
    expect(optimization.outputCount).toBe(1);
    const apply = await engine.runOptimizationCycle({
      force: true,
      apply: true,
    });
    expect(apply.status).toBe("rejected");
    expect(apply.reason).toBe("apply_mode_required");
  });

  it("records an experience with a model action and preserves idempotent behavior", () => {
    const store = makeStore();
    const engine = new SelfImprovementEngine(
      { tkg: { learningStore: store } },
      {},
      async () => ({ choices: [] }),
      { enabled: true, behavior_learning: { mode: "observe", min_samples: 3 } },
    );
    const first = engine.recordExperience({
      actionKey: "model:local-lfm",
      context: "test request",
      outcome: "success",
      rewardInput: { outcome: "success", completionQuality: 1 },
      idempotencyKey: "run-1-turn-1",
    });
    expect(first?.stored).toBe(true);
    expect(first?.row.actionKey).toBe("model:local-lfm");
    expect(first?.reward).toBeGreaterThan(0);
    expect(store.policy.totalDecisions).toBe(1);
    expect(
      (store.policy.actionStats as Record<string, { count: number }>)[
        "model:local-lfm"
      ].count,
    ).toBe(1);

    Object.assign(store.policy, {
      actionStats: {
        "model:local-lfm": { count: 3, averageReward: 0.8 },
        "model:gemini": { count: 3, averageReward: 0.2 },
      },
    });
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      const decision = engine.chooseAction({
        context: "complex",
        candidates: ["model:local-lfm", "model:gemini"],
        baselineAction: "model:gemini",
      });
      expect(decision.actionKey).toBe("model:local-lfm");
    } finally {
      randomSpy.mockRestore();
    }
  });
});
