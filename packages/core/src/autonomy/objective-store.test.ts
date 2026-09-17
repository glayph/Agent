import Database from "better-sqlite3";
import { SqliteObjectiveStore } from "./objective-store.js";
import type { Objective } from "./types.js";

function makeObjective(overrides: Partial<Objective> = {}): Objective {
  const now = Date.now();
  return {
    id: `objective-${now}-${Math.random().toString(36).slice(2, 6)}`,
    type: "TESTING",
    status: "in_progress",
    title: "Test objective",
    rationale: "because tests",
    createdAt: now,
    updatedAt: now,
    priority: 0.5,
    progress: 0,
    plan: [
      {
        id: "s1",
        description: "step one",
        status: "pending",
        attempts: 0,
        lastError: null,
      },
    ],
    context: { foo: "bar" },
    result: null,
    replans: 0,
    ...overrides,
  };
}

describe("SqliteObjectiveStore", () => {
  let db: Database.Database;
  let store: SqliteObjectiveStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new SqliteObjectiveStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips an objective including plan/context/result", () => {
    const objective = makeObjective({
      result: { summary: "done" },
    });
    store.create(objective);
    const loaded = store.get(objective.id);
    expect(loaded).toBeDefined();
    expect(loaded?.title).toBe(objective.title);
    expect(loaded?.plan).toEqual(objective.plan);
    expect(loaded?.context).toEqual(objective.context);
    expect(loaded?.result).toEqual({ summary: "done" });
  });

  it("lists unfinished objectives ordered by priority", () => {
    store.create(makeObjective({ id: "a", status: "pending", priority: 0.2 }));
    store.create(
      makeObjective({ id: "b", status: "in_progress", priority: 0.9 }),
    );
    store.create(makeObjective({ id: "c", status: "completed", priority: 1 }));
    const unfinished = store.listUnfinished();
    expect(unfinished.map((o) => o.id)).toEqual(["b", "a"]);
  });

  it("lists recent objectives most-recently-updated first", () => {
    store.create(makeObjective({ id: "old", updatedAt: 1000 }));
    store.create(makeObjective({ id: "new", updatedAt: 2000 }));
    const recent = store.listRecent(10);
    expect(recent[0].id).toBe("new");
  });

  it("counts objectives by status", () => {
    store.create(makeObjective({ id: "a", status: "completed" }));
    store.create(makeObjective({ id: "b", status: "completed" }));
    store.create(makeObjective({ id: "c", status: "failed" }));
    expect(store.countByStatus("completed")).toBe(2);
    expect(store.countByStatus("failed")).toBe(1);
  });

  it("update() overwrites the same row (upsert by id)", () => {
    const objective = makeObjective({ id: "x", progress: 0 });
    store.create(objective);
    objective.progress = 0.75;
    objective.status = "completed";
    store.update(objective);
    const loaded = store.get("x");
    expect(loaded?.progress).toBe(0.75);
    expect(loaded?.status).toBe("completed");
    expect(store.listRecent(10)).toHaveLength(1);
  });
});
