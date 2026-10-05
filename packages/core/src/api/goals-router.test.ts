import Database from "better-sqlite3";
import { createGoalTools, GoalStore } from "./goals-router.js";

describe("persistent goal tool adapters", () => {
  let db: Database.Database;
  let store: GoalStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new GoalStore(db);
  });

  afterEach(() => db.close());

  it("persists priority and structured context through goal_create", async () => {
    const tools = createGoalTools(store);
    const create = tools.find((item) => item.name === "goal_create");
    expect(create).toBeDefined();
    const goal = await create!.execute({
      objective: "Review autonomy",
      priority: 2,
      context: { phase: 2, source: "test" },
      steps: ["Inspect", "Verify"],
    });
    expect(goal).toMatchObject({ title: "Review autonomy", priority: 2 });
    const stored = store.get(Number((goal as { id: number }).id))!;
    expect(JSON.parse(stored.context ?? "{}")).toEqual({ phase: 2, source: "test" });
    expect(JSON.parse(stored.steps)).toEqual(["Inspect", "Verify"]);
  });

  it("updates goal priority, context and steps through goal_update", () => {
    const goal = store.create({ title: "Initial", steps: ["One"], replaceExisting: false });
    const update = createGoalTools(store).find((item) => item.name === "goal_update");
    expect(update).toBeDefined();
    const updated = update!.execute({
      goal_id: goal.id,
      priority: 9,
      context: { verified: true },
      steps: ["One", "Two"],
    }) as ReturnType<GoalStore["get"]>;
    expect(updated).toMatchObject({ id: goal.id, priority: 9, total_steps: 2 });
    expect(JSON.parse(updated!.context ?? "{}")).toEqual({ verified: true });
    expect(JSON.parse(updated!.steps)).toEqual(["One", "Two"]);
  });
  it("migrates legacy goal tables with missing autonomy metadata columns", () => {
    db.close();
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE pursue_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        status_reason TEXT,
        progress REAL NOT NULL DEFAULT 0,
        total_steps INTEGER NOT NULL DEFAULT 0,
        completed_steps INTEGER NOT NULL DEFAULT 0,
        last_pursued_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const migrated = new GoalStore(db);
    const columns = db.prepare("PRAGMA table_info(pursue_goals)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    for (const name of ["priority", "context", "source", "steps", "acceptance_contract"]) {
      expect(names.has(name)).toBe(true);
    }
    const goal = migrated.create({ title: "Migrated" });
    expect(goal.priority).toBe(5);
    expect(goal.steps).toBe("[]");
  });

});
