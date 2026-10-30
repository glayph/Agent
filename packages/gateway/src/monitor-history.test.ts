import Database from "better-sqlite3"
import express from "express"
import { describe, expect, it, beforeEach } from "vitest"
import { createMonitorHistoryRouter, ensureMonitorHistorySchema, persistMonitorEvent, pruneMonitorHistory } from "./monitor-history.js"

function setup() {
  const db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  ensureMonitorHistorySchema(db)
  return db
}
function emit(db: Database.Database, sessionId: string, sequence: number, type: string, payload: Record<string, unknown>) {
  persistMonitorEvent(db, { runId: "run-a", sessionId, sequence, type, payload: { run_id: "run-a", ...payload }, timestamp: Date.UTC(2026, 9, 30, 0, 0, sequence) })
}

describe("server-side monitor history", () => {
  let db: Database.Database
  beforeEach(() => { db = setup() })

  it("persists allowlisted run and node metadata without objectives, inputs, outputs, errors, or secrets", () => {
    emit(db, "session-a", 1, "node.run_start", { objective: "private plan to acquire secret token" })
    emit(db, "session-a", 2, "node.spawn", { node_id: "run-a:call-1", label: "browser_navigate", level: 0, status: "running", input: { api_key: "private-key", password: "hunter2", text: "private page content" }, action: "private action" })
    emit(db, "session-a", 3, "node.complete", { node_id: "run-a:call-1", ok: false, result_message: "private error and token=abcd", output_preview: "private output", error: "secret error" })
    const runs = db.prepare("SELECT * FROM monitor_runs").all() as Array<Record<string, unknown>>
    const nodes = db.prepare("SELECT * FROM monitor_nodes").all() as Array<Record<string, unknown>>
    const events = db.prepare("SELECT payload_json FROM monitor_events").all() as Array<{ payload_json: string }>
    expect(runs[0]).toMatchObject({ run_id: "run-a", session_id: "session-a", status: "running" })
    expect(nodes[0]).toMatchObject({ node_id: "run-a:call-1", label: "browser_navigate", status: "failed" })
    const serialized = JSON.stringify({ runs, nodes, events })
    for (const forbidden of ["private plan", "private-key", "hunter2", "private page content", "private action", "private error", "private output", "secret error"]) expect(serialized).not.toContain(forbidden)
    expect(events[1]?.payload_json).toBe(JSON.stringify({ run_id: "run-a", node_id: "run-a:call-1", label: "browser_navigate", status: "running", level: 0, parallel: false }))
  })

  it("is idempotent by stream sequence and refuses cross-session run reuse", () => {
    emit(db, "session-a", 1, "node.run_start", {})
    emit(db, "session-a", 2, "node.spawn", { node_id: "n1", label: "tool", status: "running", level: 0 })
    emit(db, "session-a", 2, "node.spawn", { node_id: "n1", label: "different_tool", status: "failed", level: 0 })
    emit(db, "session-b", 3, "node.complete", { node_id: "n1", ok: true })
    expect((db.prepare("SELECT COUNT(*) n FROM monitor_events").get() as { n: number }).n).toBe(2)
    expect((db.prepare("SELECT session_id FROM monitor_runs WHERE run_id='run-a'").get() as { session_id: string }).session_id).toBe("session-a")
    expect((db.prepare("SELECT label FROM monitor_nodes WHERE node_id='n1'").get() as { label: string }).label).toBe("tool")
  })

  it("marks active work as failed/interrupted when the run ends", () => {
    emit(db, "session-a", 1, "node.run_start", {})
    emit(db, "session-a", 2, "node.spawn", { node_id: "n1", label: "tool", status: "running", level: 0 })
    emit(db, "session-a", 3, "node.run_end", { status: "failed", error: "not persisted" })
    expect(db.prepare("SELECT status FROM monitor_runs").get()).toEqual({ status: "failed" })
    expect(db.prepare("SELECT status FROM monitor_nodes").get()).toEqual({ status: "failed" })
    expect((db.prepare("SELECT payload_json FROM monitor_events ORDER BY seq DESC LIMIT 1").get() as { payload_json: string }).payload_json).toBe('{"run_id":"run-a","status":"failed"}')
  })

  it("prunes expired history and enforces a per-session run cap", () => {
    const base = Date.UTC(2026, 9, 30)
    for (let i = 1; i <= 3; i++) {
      const runId = `run-${i}`
      persistMonitorEvent(db, { runId, sessionId: "session-a", sequence: 1, type: "node.run_start", payload: { run_id: runId }, timestamp: base - i * 2 * 86_400_000 })
      persistMonitorEvent(db, { runId, sessionId: "session-a", sequence: 2, type: "node.run_end", payload: { run_id: runId, status: "completed" }, timestamp: base - i * 2 * 86_400_000 + 1 })
    }
    const pruned = pruneMonitorHistory(db, new Date(base).toISOString(), 30, 2)
    expect(pruned).toBe(1)
    expect((db.prepare("SELECT COUNT(*) n FROM monitor_runs").get() as { n: number }).n).toBe(2)
    const expired = pruneMonitorHistory(db, new Date(base).toISOString(), 1, 100)
    expect(expired).toBe(2)
    expect((db.prepare("SELECT COUNT(*) n FROM monitor_events").get() as { n: number }).n).toBe(0)
  })

  it("never prunes a still-running run when applying retention limits", () => {
    const timestamp = Date.UTC(2026, 9, 30) - 90 * 86_400_000
    persistMonitorEvent(db, { runId: "run-active", sessionId: "session-a", sequence: 1, type: "node.run_start", payload: { run_id: "run-active" }, timestamp })
    expect(pruneMonitorHistory(db, new Date().toISOString(), 1, 1)).toBe(0)
    expect((db.prepare("SELECT status FROM monitor_runs WHERE run_id='run-active'").get() as { status: string }).status).toBe("running")
  })

  it("rejects out-of-order stream events instead of moving the durable cursor backwards", () => {
    emit(db, "session-a", 4, "node.run_start", {})
    emit(db, "session-a", 3, "node.plan", { total: 3, levels: 1 })
    expect((db.prepare("SELECT COUNT(*) n FROM monitor_events").get() as { n: number }).n).toBe(1)
    expect((db.prepare("SELECT last_seq FROM monitor_runs").get() as { last_seq: number }).last_seq).toBe(4)
  })

  it("protects history APIs with authentication and enforces session scope for detail/delete", async () => {
    emit(db, "session-a", 1, "node.run_start", {})
    const app = express()
    app.use(express.json())
    const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.header("x-test-auth") !== "yes") return res.status(401).json({ error: "unauthorized" })
      next()
    }
    app.use("/api/monitor", createMonitorHistoryRouter(db, requireAuth, () => new Date().toISOString()))
    const server = app.listen(0, "127.0.0.1")
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject) })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind")
    const base = `http://127.0.0.1:${address.port}/api/monitor/history/run-a`
    try {
      expect((await fetch(base + "?session_id=session-a")).status).toBe(401)
      const detail = await fetch(base + "?session_id=session-a", { headers: { "x-test-auth": "yes" } })
      expect(detail.status).toBe(200)
      expect(await detail.json()).toMatchObject({ run: { id: "run-a", sessionId: "session-a" } })
      const crossSession = await fetch(base + "?session_id=session-b", { headers: { "x-test-auth": "yes" } })
      expect(crossSession.status).toBe(404)
      const noScope = await fetch(base, { method: "DELETE", headers: { "x-test-auth": "yes" } })
      expect(noScope.status).toBe(400)
      const wrongScope = await fetch(base + "?session_id=session-b", { method: "DELETE", headers: { "x-test-auth": "yes" } })
      expect(wrongScope.status).toBe(404)
      const deleted = await fetch(base + "?session_id=session-a", { method: "DELETE", headers: { "x-test-auth": "yes" } })
      expect(deleted.status).toBe(200)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it("paginates history with a stable exclusive cursor and optional session scope", async () => {
    for (let index = 1; index <= 5; index++) {
      const runId = `page-run-${index}`
      persistMonitorEvent(db, { runId, sessionId: index < 4 ? "session-a" : "session-b", sequence: 1, type: "node.run_start", payload: { run_id: runId }, timestamp: Date.UTC(2026, 9, 30, 0, 0, index) })
      persistMonitorEvent(db, { runId, sessionId: index < 4 ? "session-a" : "session-b", sequence: 2, type: "node.run_end", payload: { run_id: runId, status: "completed" }, timestamp: Date.UTC(2026, 9, 30, 0, 1, index) })
    }
    const app = express()
    const auth = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
    app.use("/api/monitor", createMonitorHistoryRouter(db, auth, () => new Date().toISOString()))
    const server = app.listen(0, "127.0.0.1")
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject) })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind")
    const base = `http://127.0.0.1:${address.port}/api/monitor/history`
    try {
      const firstResponse = await fetch(`${base}?limit=2&session_id=session-a`)
      const first = await firstResponse.json() as { runs: Array<{ id: string }>; next_before_seq: number | null; next_before: { seq: number; started_at: string; run_id: string } | null; high_water_seq: number }
      expect(first.runs.map((run) => run.id)).toEqual(["page-run-3", "page-run-2"])
      expect(first.next_before_seq).toBeTypeOf("number")
      expect(first.next_before?.run_id).toBe("page-run-2")
      const cursor = new URLSearchParams({ before_seq: String(first.next_before?.seq), before_started_at: String(first.next_before?.started_at), before_run_id: String(first.next_before?.run_id) })
      const secondResponse = await fetch(`${base}?limit=2&session_id=session-a&${cursor}`)
      const second = await secondResponse.json() as { runs: Array<{ id: string }>; next_before_seq: number | null; next_before: unknown }
      expect(second.runs.map((run) => run.id)).toEqual(["page-run-1"])
      expect(second.next_before_seq).toBeNull()
      expect(second.next_before).toBeNull()
      const third = await fetch(`${base}?limit=5&session_id=session-b`)
      const thirdBody = await third.json() as { runs: Array<{ id: string }> }
      expect(thirdBody.runs.map((run) => run.id)).toEqual(["page-run-5", "page-run-4"])
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it("paginates legacy imported runs with zero event sequences without repeating rows", async () => {
    for (let index = 1; index <= 5; index++) {
      db.prepare("INSERT INTO monitor_runs(run_id,session_id,status,started_at,updated_at) VALUES(?,?,?,?,?)")
        .run(`legacy-run-${index}`, "legacy-local-import", "completed", new Date(Date.UTC(2026, 9, 30, 0, 0, index)).toISOString(), new Date(Date.UTC(2026, 9, 30, 0, 0, index)).toISOString())
    }
    const app = express()
    const auth = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
    app.use("/api/monitor", createMonitorHistoryRouter(db, auth, () => new Date().toISOString()))
    const server = app.listen(0, "127.0.0.1")
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject) })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind")
    const base = `http://127.0.0.1:${address.port}/api/monitor/history?limit=2&session_id=legacy-local-import`
    try {
      const seen: string[] = []
      let cursor: { seq: number; started_at: string; run_id: string } | null = null
      for (let page = 0; page < 4; page++) {
        const query = cursor ? `&${new URLSearchParams({ before_seq: String(cursor.seq), before_started_at: cursor.started_at, before_run_id: cursor.run_id })}` : ""
        const response = await fetch(`${base}${query}`)
        const body = await response.json() as { runs: Array<{ id: string }>; next_before: { seq: number; started_at: string; run_id: string } | null }
        seen.push(...body.runs.map((run) => run.id))
        cursor = body.next_before
        if (!cursor) break
      }
      expect(seen).toEqual(["legacy-run-5", "legacy-run-4", "legacy-run-3", "legacy-run-2", "legacy-run-1"])
      expect(new Set(seen).size).toBe(5)
      expect(cursor).toBeNull()
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it("does not persist non-monitor, malformed, or non-monotonic event sequences", () => {
    emit(db, "session-a", 0, "node.run_start", {})
    emit(db, "session-a", -1, "node.spawn", { node_id: "n1", label: "tool" })
    emit(db, "session-a", 1, "message.create", { content: "private chat body" })
    emit(db, "session-a", 2, "node.spawn", { node_id: "unsafe/id", label: "tool" })
    expect((db.prepare("SELECT COUNT(*) n FROM monitor_events").get() as { n: number }).n).toBe(0)
  })
})
