import Database from "better-sqlite3";
import {
  AutonomousGoalManager,
  parseAutonomyMessage,
} from "./autonomous-goal-manager.js";
import { SqliteObjectiveStore } from "./objective-store.js";
import type { AutonomyContext } from "./types.js";

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

describe("AutonomousGoalManager.decide", () => {
  let db: Database.Database;
  let store: SqliteObjectiveStore;
  let manager: AutonomousGoalManager;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new SqliteObjectiveStore(db);
    manager = new AutonomousGoalManager(store);
  });

  afterEach(() => db.close());

  it("returns null when there is genuinely nothing to do", () => {
    // Healthy resources, no unfinished objectives, and TESTING's periodic
    // "review coverage" nudge already satisfied recently. A non-empty
    // hints object also keeps PLANNING's fallback quiet (it only fires
    // when there is *nothing* else, including no hints at all).
    // Turbo mode scans every goal category every cycle (categoriesPerScan:
    // "all" — standard mode's rotating 6-category subset is gone along
    // with standard mode itself), so every category's own "not done
    // recently" check now runs every time instead of only on the cycles a
    // subset scan happened to include it. DOCUMENTATION and
    // MEMORY_MAINTENANCE are the two categories gated purely by recency
    // (no hint array also has to be empty), so both need a satisfying
    // recent objective below for this to still be a genuinely idle cycle.
    const ctx = baseContext({
      hints: { projects: [] },
      recentObjectives: [
        {
          id: "t-recent",
          type: "TESTING",
          status: "completed",
          title: "Review test coverage for gaps",
          rationale: "r",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          priority: 0.3,
          progress: 1,
          plan: [],
          context: { documented: true },
          result: null,
          replans: 0,
        },
        {
          id: "mm-recent",
          type: "MEMORY_MAINTENANCE",
          status: "completed",
          title: "Organize recent memory",
          rationale: "r",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          priority: 0.3,
          progress: 1,
          plan: [],
          context: { documented: true },
          result: null,
          replans: 0,
        },
      ],
    });
    expect(manager.decide(ctx)).toBeNull();
  });

  it("selects the highest-scoring candidate and persists a plan", () => {
    const ctx = baseContext({
      hints: { failingTests: ["a.test.ts", "b.test.ts"] },
    });
    const decision = manager.decide(ctx);
    expect(decision).not.toBeNull();
    expect(decision?.objective.type).toBe("TESTING");
    expect(decision?.objective.plan.length).toBeGreaterThan(0);
    expect(decision?.objective.status).toBe("in_progress");

    const persisted = store.get(decision!.objective.id);
    expect(persisted).toBeDefined();
    expect(persisted?.title).toBe(decision?.objective.title);

    const parsed = parseAutonomyMessage(decision!.taskMessage);
    expect(parsed?.objectiveId).toBe(decision?.objective.id);
    expect(parsed?.prompt).toContain("Plan:");
  });

  it("prefers turbo scoring weights when mode is turbo", () => {
    // Same context under both modes; the manager should still find a
    // candidate either way, but this exercises the mode plumbing rather
    // than crashing.
    const ctx = baseContext({
      mode: "turbo",
      hints: { recentErrors: ["boom"] },
    });
    const decision = manager.decide(ctx);
    expect(decision?.objective.type).toBe("BUG_INVESTIGATION");
  });
});

describe("AutonomousGoalManager.recordOutcome", () => {
  let db: Database.Database;
  let store: SqliteObjectiveStore;
  let manager: AutonomousGoalManager;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new SqliteObjectiveStore(db);
    manager = new AutonomousGoalManager(store);
  });

  afterEach(() => db.close());

  it("marks an objective completed on success", () => {
    const ctx = baseContext({ hints: { failingTests: ["a.test.ts"] } });
    const decision = manager.decide(ctx)!;
    const updated = manager.recordOutcome(
      decision.objective.id,
      { success: true, summary: "fixed it" },
      "turbo",
    );
    expect(updated?.status).toBe("completed");
    expect(updated?.progress).toBe(1);
  });

  it("replans on failure up to the mode's max, then blocks", () => {
    const ctx = baseContext({ hints: { failingTests: ["a.test.ts"] } });
    const decision = manager.decide(ctx)!;
    let last = decision.objective;
    // Turbo mode allows 5 replans (see mode-config.ts) before blocking.
    for (let i = 0; i < 5; i++) {
      last = manager.recordOutcome(
        last.id,
        { success: false, summary: "still broken" },
        "turbo",
      )!;
      expect(last.status).toBe("pending");
    }
    last = manager.recordOutcome(
      last.id,
      { success: false, summary: "still broken" },
      "turbo",
    )!;
    expect(last.status).toBe("blocked");
  });

  it("returns undefined for an unknown objective id", () => {
    expect(
      manager.recordOutcome(
        "nonexistent",
        { success: true, summary: "n/a" },
        "turbo",
      ),
    ).toBeUndefined();
  });
});
