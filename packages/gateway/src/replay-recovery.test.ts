import Database from "better-sqlite3"
import { RecoveryManager } from "./recovery-manager.js"
import { ReplaySweeper, type ReplayCandidate } from "./replay-sweeper.js"

function chatDb() {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT, kind TEXT DEFAULT 'normal', context_id TEXT, status TEXT DEFAULT 'completed', status_detail TEXT)")
  return db
}
const add = (db: Database.Database, id: string, ctx: string, status: string, at: string, detail: string | null = null) =>
  db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,status,status_detail) VALUES(?,?,?,?,?,?,?,?)").run(id, ctx, "user", "hi", at, ctx, status, detail)

describe("recovery manager", () => {
  it("declares recovery only after three green checks in a row, then replays once", async () => {
    const db = chatDb()
    const results = [false, false, true, true, false, true, true, true]
    let i = 0
    const recovered = jest.fn(async () => 2)
    const m = new RecoveryManager({ db, check: async () => ({ ok: results[i++], reason: "model server is not reachable" }), onRecovered: recovered, log: () => undefined })
    expect(await m.tick()).toBe("disrupted")
    expect(await m.tick()).toBe("disrupted")
    expect(await m.tick()).toBe("recovering")
    expect(await m.tick()).toBe("recovering")
    expect(await m.tick()).toBe("disrupted") // flapped: the green streak starts over
    await m.tick(); await m.tick()
    expect(recovered).not.toHaveBeenCalled()
    expect(await m.tick()).toBe("healthy")
    expect(recovered).toHaveBeenCalledTimes(1)
    const [incident] = m.recentIncidents()
    expect(incident).toMatchObject({ replayed: 2, reason: "model server is not reachable" })
    expect(incident.ended_at).not.toBeNull()
    expect(incident.checks_failed).toBeGreaterThanOrEqual(3)
  })

  it("stays quiet while healthy and closes an incident left open by a crash", async () => {
    const db = chatDb()
    const down = new RecoveryManager({ db, check: async () => ({ ok: false, reason: "x" }), log: () => undefined })
    await down.tick()
    const again = new RecoveryManager({ db, check: async () => ({ ok: true }), log: () => undefined })
    expect(db.prepare("SELECT COUNT(*) n FROM recovery_incidents WHERE ended_at IS NULL").get()).toEqual({ n: 0 })
    expect(await again.tick()).toBe("healthy")
  })
})

describe("replay sweeper", () => {
  const NOW = Date.parse("2026-10-27T12:00:00.000Z")
  const outcome = { status: "completed", runId: "r" } as never
  function build(extra: Partial<ConstructorParameters<typeof ReplaySweeper>[0]> = {}) {
    const db = chatDb()
    const order: string[] = []
    const given: string[] = []
    const sweeper = new ReplaySweeper({
      db, now: () => NOW, log: () => undefined, isContextActive: () => false,
      replay: async (m: ReplayCandidate) => { order.push(m.id); db.prepare("UPDATE chat_messages SET status='completed' WHERE id=?").run(m.id); return outcome },
      onGivenUp: (m, why) => given.push(`${m.id}:${why}`),
      ...extra,
    })
    return { db, order, given, sweeper }
  }

  it("replays unanswered and temporarily failed messages in order, and leaves real failures alone", async () => {
    const { db, order, sweeper } = build()
    add(db, "m1", "c1", "processing", "2026-10-27T11:00:00.000Z")
    add(db, "m2", "c1", "failed", "2026-10-27T11:01:00.000Z", "fetch failed: ECONNREFUSED")
    add(db, "m3", "c2", "failed", "2026-10-27T11:02:00.000Z", "The provider rejected the API key (401)")
    add(db, "m4", "c2", "completed", "2026-10-27T11:03:00.000Z")
    const result = await sweeper.sweep("test")
    expect(order).toEqual(["m1", "m2"]) // c1 kept in order; m3 (a real refusal) and m4 (done) untouched
    expect(result).toMatchObject({ replayed: 2, skipped: 1 })
  })

  it("never touches a conversation whose turn is still running", async () => {
    const { db, order, sweeper } = build({ isContextActive: (c) => c === "busy" })
    add(db, "a", "busy", "retrying", "2026-10-27T11:00:00.000Z")
    add(db, "b", "idle", "queued", "2026-10-27T11:00:01.000Z")
    await sweeper.sweep("test")
    expect(order).toEqual(["b"])
  })

  it("sets a poison message aside after three attempts instead of replaying it for ever", async () => {
    const { db, order, given, sweeper } = build({ replay: async () => { throw new Error("boom") } })
    add(db, "poison", "c1", "queued", "2026-10-27T11:00:00.000Z")
    for (let i = 0; i < 3; i += 1) await sweeper.sweep("test") // three failed attempts
    const result = await sweeper.sweep("test")
    expect(result.quarantined).toBe(1)
    expect(given).toEqual(["poison:quarantined"])
    expect(db.prepare("SELECT replay_attempts a, replay_state s FROM chat_messages WHERE id='poison'").get()).toEqual({ a: 3, s: "quarantined" })
    await sweeper.sweep("test")
    expect(order).toEqual([])
    expect(given).toHaveLength(1) // the user is told once
  })

  it("does not replay messages older than the time limit, and reports them once", async () => {
    const { db, order, given, sweeper } = build({ ttlMs: 60 * 60_000 })
    add(db, "old", "c1", "queued", "2026-10-27T08:00:00.000Z")
    add(db, "new", "c1", "queued", "2026-10-27T11:30:00.000Z")
    await sweeper.sweep("test"); await sweeper.sweep("test")
    expect(order).toEqual(["new"])
    expect(given).toEqual(["old:expired"])
  })

  it("runs at most two conversations at the same time", async () => {
    let active = 0, peak = 0
    const { db, sweeper } = build({ replay: async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active -= 1; return outcome } })
    for (let i = 0; i < 6; i += 1) add(db, `m${i}`, `c${i}`, "queued", `2026-10-27T11:0${i}:00.000Z`)
    const result = await sweeper.sweep("test")
    expect(result.replayed).toBe(6)
    expect(peak).toBe(2)
  })
})
