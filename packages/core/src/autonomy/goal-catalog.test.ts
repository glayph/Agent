import { getGoalDefinition, BUILTIN_GOAL_CATEGORIES } from "./goal-catalog.js";
import type { AutonomyContext, Objective } from "./types.js";

function baseContext(
  overrides: Partial<AutonomyContext> = {},
): AutonomyContext {
  return {
    now: Date.now(),
    idleMins: 10,
    mode: "turbo",
    unfinishedObjectives: [],
    recentObjectives: [],
    resource: {
      freeMemPct: 50,
      cpus: 4,
      activeTasks: 0,
      maxConcurrent: 3,
      providerAvailable: true,
    },
    hints: {},
    ...overrides,
  };
}

describe("goal-catalog registry", () => {
  it("registers all 18 built-in categories", () => {
    for (const category of BUILTIN_GOAL_CATEGORIES) {
      expect(getGoalDefinition(category)).toBeDefined();
    }
    expect(BUILTIN_GOAL_CATEGORIES).toHaveLength(18);
  });
});

describe("USER_FOLLOWUP probe", () => {
  it("proposes nothing with no pending followups", () => {
    const def = getGoalDefinition("USER_FOLLOWUP")!;
    expect(def.probe(baseContext())).toEqual([]);
  });

  it("proposes a candidate when a followup is pending", () => {
    const def = getGoalDefinition("USER_FOLLOWUP")!;
    const ctx = baseContext({
      hints: { pendingFollowups: ["ship the report"] },
    });
    const candidates = def.probe(ctx);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].factors.urgency).toBeGreaterThan(0.5);
    const plan = def.buildPlan(candidates[0], ctx);
    expect(plan.length).toBeGreaterThan(0);
  });
});

describe("UNFINISHED_WORK probe", () => {
  it("proposes resuming the first non-followup unfinished objective", () => {
    const def = getGoalDefinition("UNFINISHED_WORK")!;
    const unfinished: Objective[] = [
      {
        id: "obj-1",
        type: "PROJECT_MAINTENANCE",
        status: "pending",
        title: "Clean up repo",
        rationale: "r",
        createdAt: 1,
        updatedAt: 1,
        priority: 0.6,
        progress: 0.2,
        plan: [],
        context: {},
        result: null,
        replans: 1,
      },
    ];
    const ctx = baseContext({ unfinishedObjectives: unfinished });
    const candidates = def.probe(ctx);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].resumeObjectiveId).toBe("obj-1");
    expect(candidates[0].factors.unfinishedWorkBonus).toBe(1);
  });

  it("proposes nothing when there is no unfinished work", () => {
    const def = getGoalDefinition("UNFINISHED_WORK")!;
    expect(def.probe(baseContext())).toEqual([]);
  });
});

describe("TESTING probe", () => {
  it("prioritizes failing tests over a periodic coverage review", () => {
    const def = getGoalDefinition("TESTING")!;
    const ctx = baseContext({ hints: { failingTests: ["test/foo.test.ts"] } });
    const candidates = def.probe(ctx);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].factors.urgency).toBeGreaterThan(0.5);
  });

  it("does not repeat a coverage review within 24h", () => {
    const def = getGoalDefinition("TESTING")!;
    const recent: Objective[] = [
      {
        id: "t1",
        type: "TESTING",
        status: "completed",
        title: "Review test coverage for gaps",
        rationale: "r",
        createdAt: 1,
        updatedAt: Date.now() - 60 * 1000, // 1 minute ago
        priority: 0.3,
        progress: 1,
        plan: [],
        context: {},
        result: null,
        replans: 0,
      },
    ];
    const ctx = baseContext({ recentObjectives: recent });
    expect(def.probe(ctx)).toEqual([]);
  });
});

describe("SYSTEM_HEALTH probe", () => {
  it("proposes nothing when resources are healthy", () => {
    const def = getGoalDefinition("SYSTEM_HEALTH")!;
    expect(def.probe(baseContext())).toEqual([]);
  });

  it("proposes an investigation when memory is low", () => {
    const def = getGoalDefinition("SYSTEM_HEALTH")!;
    const ctx = baseContext({
      resource: {
        freeMemPct: 5,
        cpus: 4,
        activeTasks: 0,
        maxConcurrent: 3,
        providerAvailable: true,
      },
    });
    expect(def.probe(ctx)).toHaveLength(1);
  });

  it("proposes an investigation when the provider is unavailable", () => {
    const def = getGoalDefinition("SYSTEM_HEALTH")!;
    const ctx = baseContext({
      resource: {
        freeMemPct: 80,
        cpus: 4,
        activeTasks: 0,
        maxConcurrent: 3,
        providerAvailable: false,
      },
    });
    expect(def.probe(ctx)).toHaveLength(1);
  });
});

describe("PLANNING probe (fallback)", () => {
  it("only fires when there is truly nothing else going on", () => {
    const def = getGoalDefinition("PLANNING")!;
    expect(def.probe(baseContext())).toHaveLength(1);
    expect(def.probe(baseContext({ hints: { projects: ["repo-a"] } }))).toEqual(
      [],
    );
  });
});
