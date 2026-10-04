import Database from "better-sqlite3"
import { RunsStore } from "./runs-store.js"

describe("RunsStore", () => {
  let db: Database.Database
  let store: RunsStore

  beforeEach(() => {
    db = new Database(":memory:")
    store = new RunsStore(db)
  })

  afterEach(() => {
    db.close()
  })

  it("creates and finishes a run", () => {
    store.create({
      id: "run_1",
      source: "websocket",
      sessionId: "sess_1",
      goal: "hello",
    })
    const running = store.get("run_1")
    expect(running?.status).toBe("running")
    expect(running?.lane).toBe("chat")

    store.finish("run_1", {
      status: "completed",
      finalText: "world",
      turns: 2,
      toolCalls: 1,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    })
    const done = store.get("run_1")
    expect(done?.status).toBe("completed")
    expect(done?.final_text).toBe("world")
    expect(done?.usage_total_tokens).toBe(15)
  })

  it("lists with filters", () => {
    store.create({ id: "a", source: "websocket", goal: "alpha" })
    store.finish("a", { status: "completed" })
    store.create({ id: "b", source: "heartbeat", goal: "beta", lane: "heartbeat" })
    const all = store.list({})
    expect(all.total).toBe(2)
    const hb = store.list({ lane: "heartbeat" })
    expect(hb.total).toBe(1)
    expect(hb.runs[0].id).toBe("b")
    const q = store.list({ q: "alpha" })
    expect(q.total).toBe(1)
  })

  it("reports active by lane and stats", () => {
    store.create({ id: "r1", source: "websocket" })
    store.create({ id: "r2", source: "autonomy-scheduler", lane: "autonomy" })
    const active = store.activeByLane()
    expect(active.chat).toBe(1)
    expect(active.autonomy).toBe(1)
    const stats = store.stats()
    expect(stats.total).toBe(2)
    expect(stats.byStatus.running).toBe(2)
  })
})
