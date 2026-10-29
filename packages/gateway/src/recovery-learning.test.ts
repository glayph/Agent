import Database from "better-sqlite3"
import { RecoveryLearning, classifyIncident } from "./recovery-learning.js"
import { RecoveryManager, ensureRecoverySchema, type RecoveryIncident } from "./recovery-manager.js"

function build() {
  const db = new Database(":memory:"); ensureRecoverySchema(db)
  const logs: string[] = []; const records: any[] = []; const notes: string[] = []
  const learning = new RecoveryLearning({ db, log: (m) => logs.push(m), record: (r) => records.push(r), remember: (l) => notes.push(l), calmBeforeRelax: 2 })
  const incident = (start: string, end: string, reason = "model server is not reachable", replayed = 1): RecoveryIncident => {
    const info = db.prepare("INSERT INTO recovery_incidents(started_at,ended_at,reason,replayed) VALUES(?,?,?,?)").run(start, end, reason, replayed)
    return db.prepare("SELECT * FROM recovery_incidents WHERE id=?").get(info.lastInsertRowid) as RecoveryIncident
  }
  return { db, logs, records, notes, learning, incident }
}

describe("recovery self-learning", () => {
  it("classifies reasons", () => {
    expect(classifyIncident("model server is not reachable")).toBe("model")
    expect(classifyIncident("cannot reach api.telegram.org")).toBe("network")
    expect(classifyIncident("crash: unhandled rejection")).toBe("crash")
    expect(classifyIncident("database check failed")).toBe("database")
  })

  it("writes every incident to the learning store and the identity memory", () => {
    const { learning, incident, records, notes } = build()
    learning.onIncidentClosed(incident("2026-10-27T10:00:00Z", "2026-10-27T10:05:00Z"))
    expect(records[0]).toMatchObject({ taskClass: "recovery", outcome: "success", metadata: { kind: "model", replayed: 1 } })
    expect(notes[0]).toContain("model outage")
    expect(notes[0]).toContain("5 min")
  })

  it("requires more green checks after a flap, within bounds, and logs the change", () => {
    const { learning, incident, logs, records } = build()
    expect(learning.requiredGreen()).toBe(3)
    learning.onIncidentClosed(incident("2026-10-27T10:00:00Z", "2026-10-27T10:05:00Z"))
    learning.onIncidentClosed(incident("2026-10-27T10:06:00Z", "2026-10-27T10:08:00Z")) // began 1 min after the last one ended
    expect(records[1].outcome).toBe("failure")
    expect(learning.requiredGreen()).toBe(4)
    expect(logs.join(" ")).toContain("required green checks 3 -> 4")
    for (let i = 0; i < 6; i += 1) { const h = 10 + i + 1; learning.onIncidentClosed(incident(`2026-10-27T${h}:00:00Z`, `2026-10-27T${h}:01:00Z`)) } // calm: hours apart
    for (let i = 0; i < 10; i += 1) { const base = Date.parse("2026-10-28T00:00:00Z") + i * 120_000; learning.onIncidentClosed(incident(new Date(base).toISOString(), new Date(base + 30_000).toISOString())) } // flapping: 90 s apart
    expect(learning.requiredGreen()).toBeLessThanOrEqual(6)
  })

  it("relaxes again after a run of calm incidents but never below the minimum", () => {
    const { learning, incident } = build()
    learning.onIncidentClosed(incident("2026-10-27T10:00:00Z", "2026-10-27T10:05:00Z"))
    learning.onIncidentClosed(incident("2026-10-27T10:06:00Z", "2026-10-27T10:08:00Z"))
    expect(learning.requiredGreen()).toBe(4)
    learning.onIncidentClosed(incident("2026-10-27T13:00:00Z", "2026-10-27T13:01:00Z"))
    learning.onIncidentClosed(incident("2026-10-27T15:00:00Z", "2026-10-27T15:01:00Z"))
    expect(learning.requiredGreen()).toBe(3)
    learning.onIncidentClosed(incident("2026-10-27T17:00:00Z", "2026-10-27T17:01:00Z"))
    learning.onIncidentClosed(incident("2026-10-27T19:00:00Z", "2026-10-27T19:01:00Z"))
    expect(learning.requiredGreen()).toBe(3)
  })

  it("the recovery manager uses the tuned number of green checks", async () => {
    const { db, learning } = build()
    let ok = false
    const recovered = jest.fn()
    const m = new RecoveryManager({ db, check: async () => ({ ok, reason: "model server is not reachable" }), requiredGreen: () => learning.requiredGreen(), onRecovered: recovered, onIncidentClosed: (i) => learning.onIncidentClosed(i), log: () => undefined })
    await m.tick(); ok = true
    await m.tick(); await m.tick(); expect(recovered).not.toHaveBeenCalled()
    await m.tick(); expect(recovered).toHaveBeenCalledTimes(1)
  })
})
