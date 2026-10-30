import type Database from "better-sqlite3"
import { Router, type RequestHandler } from "express"

const RUN_STATUSES = new Set(["running", "completed", "failed"])
const NODE_STATUSES = new Set(["pending", "running", "retrying", "completed", "failed"])
const NODE_TYPES = new Set(["tool", "skill", "plugin", "file", "command", "pattern", "system"])
const safeId = (value: unknown, limit = 200): string => typeof value === "string" && /^[A-Za-z0-9_.:-]+$/.test(value) ? value.slice(0, limit) : ""
const safeLabel = (value: unknown): string => typeof value === "string" ? value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80) : "unknown"
const finiteInt = (value: unknown, min = 0, max = 1_000_000): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined
const iso = (value: unknown, fallback: string): string => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback

export interface PersistedMonitorEvent {
  runId: string
  sessionId: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  timestamp: number
}

export function ensureMonitorHistorySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_runs (
      run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL, finished_at TEXT, last_seq INTEGER NOT NULL DEFAULT 0,
      plan_total INTEGER, plan_levels INTEGER, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_runs_session_started ON monitor_runs(session_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS monitor_nodes (
      node_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL,
      status TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0, parallel INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER, duration_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES monitor_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_nodes_run_level ON monitor_nodes(run_id, level, created_at);
    CREATE TABLE IF NOT EXISTS monitor_edges (
      edge_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL, animated INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(run_id) REFERENCES monitor_runs(run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS monitor_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, session_id TEXT NOT NULL,
      stream_seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(run_id, stream_seq),
      FOREIGN KEY(run_id) REFERENCES monitor_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_events_session_seq ON monitor_events(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_monitor_events_run_seq ON monitor_events(run_id, seq);
    CREATE TABLE IF NOT EXISTS monitor_imports (
      import_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, imported_at TEXT NOT NULL, imported_count INTEGER NOT NULL DEFAULT 0
    );
  `)
}

/** Prune terminal history outside the retention window or per-session run cap. */
export function pruneMonitorHistory(db: Database.Database, timestamp = new Date().toISOString(), retentionDays = 30, maxRunsPerSession = 100): number {
  const safeDays = Number.isFinite(retentionDays) ? Math.max(1, Math.min(3650, Math.floor(retentionDays))) : 30
  const safeLimit = Number.isFinite(maxRunsPerSession) ? Math.max(1, Math.min(1000, Math.floor(maxRunsPerSession))) : 100
  const cutoff = new Date(Date.parse(timestamp) - safeDays * 86_400_000).toISOString()
  const rows = db.prepare("SELECT run_id,session_id,started_at,status FROM monitor_runs ORDER BY session_id,started_at DESC").all() as Array<{ run_id: string; session_id: string; started_at: string; status: string }>
  const counts = new Map<string, number>()
  const expired: string[] = []
  for (const row of rows) {
    // Never prune active work, even if it exceeds the configured retention window or session cap.
    if (row.status === "running") continue
    const count = counts.get(row.session_id) ?? 0
    counts.set(row.session_id, count + 1)
    if (row.started_at < cutoff || count >= safeLimit) expired.push(row.run_id)
  }
  if (expired.length === 0) return 0
  const prune = db.transaction(() => {
    for (const runId of expired) {
      db.prepare("DELETE FROM monitor_events WHERE run_id=?").run(runId)
      db.prepare("DELETE FROM monitor_edges WHERE run_id=?").run(runId)
      db.prepare("DELETE FROM monitor_nodes WHERE run_id=?").run(runId)
      db.prepare("DELETE FROM monitor_runs WHERE run_id=?").run(runId)
    }
  })
  prune()
  return expired.length
}

export function markInterruptedMonitorRuns(db: Database.Database, timestamp = new Date().toISOString()): number {
  const mark = db.transaction(() => {
    const affected = db.prepare("UPDATE monitor_runs SET status='failed',finished_at=COALESCE(finished_at,?),updated_at=? WHERE status='running'").run(timestamp, timestamp)
    db.prepare("UPDATE monitor_nodes SET status='failed',updated_at=? WHERE status IN ('pending','running','retrying') AND run_id IN (SELECT run_id FROM monitor_runs WHERE status='failed' AND finished_at=?)").run(timestamp, timestamp)
    db.prepare("UPDATE monitor_edges SET animated=0 WHERE run_id IN (SELECT run_id FROM monitor_runs WHERE status='failed' AND finished_at=?)").run(timestamp)
    return affected.changes
  })
  return mark()
}

function safeEvent(type: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  const runId = safeId(input.run_id)
  if (!runId || !type.startsWith("node.")) return undefined
  switch (type) {
    case "node.run_start": return { run_id: runId, status: "running" }
    case "node.plan": {
      const total = finiteInt(input.total)
      const levels = finiteInt(input.levels)
      return { run_id: runId, ...(total !== undefined ? { total } : {}), ...(levels !== undefined ? { levels } : {}) }
    }
    case "node.spawn": {
      const nodeId = safeId(input.node_id)
      if (!nodeId) return undefined
      const status = typeof input.status === "string" && NODE_STATUSES.has(input.status) ? input.status : "running"
      const level = finiteInt(input.level) ?? 0
      return { run_id: runId, node_id: nodeId, label: safeLabel(input.label), status, level, parallel: input.parallel === true }
    }
    case "node.update": {
      const nodeId = safeId(input.node_id)
      if (!nodeId) return undefined
      const status = typeof input.status === "string" && NODE_STATUSES.has(input.status) ? input.status : undefined
      const attempt = finiteInt(input.attempt)
      return { run_id: runId, node_id: nodeId, ...(status ? { status } : {}), ...(attempt !== undefined ? { attempt } : {}) }
    }
    case "node.complete": {
      const nodeId = safeId(input.node_id)
      if (!nodeId) return undefined
      const duration = finiteInt(input.duration_ms, 0, 86_400_000)
      return { run_id: runId, node_id: nodeId, ok: input.ok !== false, ...(duration !== undefined ? { duration_ms: duration } : {}) }
    }
    case "node.run_end": {
      const status = input.status === "failed" || input.status === "cancelled" ? "failed" : "completed"
      return { run_id: runId, status }
    }
    default: return undefined
  }
}

export function persistMonitorEvent(db: Database.Database, event: PersistedMonitorEvent): void {
  const sessionId = safeId(event.sessionId)
  const cleaned = safeEvent(event.type, event.payload)
  const eventRunId = safeId(event.runId)
  if (!sessionId || !eventRunId || !cleaned || String(cleaned.run_id) !== eventRunId || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return
  if (!Number.isFinite(event.timestamp) || event.timestamp < 0 || !Number.isFinite(new Date(event.timestamp).getTime())) return
  const runId = eventRunId
  const at = new Date(event.timestamp).toISOString()
  const write = db.transaction(() => {
    const prior = db.prepare("SELECT session_id,last_seq FROM monitor_runs WHERE run_id=?").get(runId) as { session_id: string; last_seq: number } | undefined
    if (prior && prior.session_id !== sessionId) return
    // Stream callbacks must be persisted in the same strictly increasing order in which they were emitted.
    if (prior && event.sequence <= prior.last_seq) return
    if (!prior) {
      db.prepare("INSERT INTO monitor_runs(run_id,session_id,status,started_at,last_seq,updated_at) VALUES(?,?,?,?,?,?)")
        .run(runId, sessionId, "running", at, 0, at)
    }
    const inserted = db.prepare("INSERT OR IGNORE INTO monitor_events(run_id,session_id,stream_seq,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(runId, sessionId, event.sequence, event.type, JSON.stringify(cleaned), at)
    if (inserted.changes === 0) return

    if (event.type === "node.run_start") {
      db.prepare("UPDATE monitor_runs SET status='running', started_at=COALESCE(started_at,?), finished_at=NULL, last_seq=?,updated_at=? WHERE run_id=?")
        .run(at, event.sequence, at, runId)
    } else if (event.type === "node.plan") {
      const p = cleaned as { total?: number; levels?: number }
      db.prepare("UPDATE monitor_runs SET plan_total=COALESCE(?,plan_total),plan_levels=COALESCE(?,plan_levels),last_seq=?,updated_at=? WHERE run_id=?")
        .run(p.total ?? null, p.levels ?? null, event.sequence, at, runId)
    } else if (event.type === "node.spawn") {
      const p = cleaned as { node_id: string; label: string; status: string; level: number; parallel: boolean }
      const inferred = p.label.startsWith("skill") ? "skill" : p.label.startsWith("plugin") ? "plugin" : /(file|read|write|delete|copy)/i.test(p.label) ? "file" : /(command|shell|terminal|execute)/i.test(p.label) ? "command" : /(workflow|orchestrat|pattern)/i.test(p.label) ? "pattern" : "tool"
      db.prepare(`INSERT INTO monitor_nodes(node_id,run_id,type,label,status,level,parallel,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET status=excluded.status,level=excluded.level,parallel=excluded.parallel,updated_at=excluded.updated_at`)
        .run(p.node_id, runId, NODE_TYPES.has(inferred) ? inferred : "tool", p.label, p.status, p.level, p.parallel ? 1 : 0, at, at)
      // Consecutive level edges are safe structural metadata only.
      if (p.level > 0) {
        const parents = db.prepare("SELECT node_id FROM monitor_nodes WHERE run_id=? AND level=? AND node_id<>?").all(runId, p.level - 1, p.node_id) as Array<{ node_id: string }>
        for (const parent of parents) {
          const edgeId = `${parent.node_id}->${p.node_id}`.slice(0, 420)
          db.prepare("INSERT OR IGNORE INTO monitor_edges(edge_id,run_id,source_node_id,target_node_id,animated) VALUES(?,?,?,?,1)").run(edgeId, runId, parent.node_id, p.node_id)
        }
      }
    } else if (event.type === "node.update") {
      const p = cleaned as { node_id: string; status?: string; attempt?: number }
      db.prepare("UPDATE monitor_nodes SET status=COALESCE(?,status),attempt=COALESCE(?,attempt),updated_at=? WHERE run_id=? AND node_id=?")
        .run(p.status ?? null, p.attempt ?? null, at, runId, p.node_id)
    } else if (event.type === "node.complete") {
      const p = cleaned as { node_id: string; ok: boolean; duration_ms?: number }
      db.prepare("UPDATE monitor_nodes SET status=?,duration_ms=COALESCE(?,duration_ms),updated_at=? WHERE run_id=? AND node_id=?")
        .run(p.ok ? "completed" : "failed", p.duration_ms ?? null, at, runId, p.node_id)
      db.prepare("UPDATE monitor_edges SET animated=0 WHERE run_id=? AND (target_node_id=? OR (?=0 AND source_node_id=?))")
        .run(runId, p.node_id, p.ok ? 1 : 0, p.node_id)
    } else if (event.type === "node.run_end") {
      const p = cleaned as { status: string }
      db.prepare("UPDATE monitor_runs SET status=?,finished_at=?,last_seq=?,updated_at=? WHERE run_id=?")
        .run(p.status, at, event.sequence, at, runId)
      db.prepare("UPDATE monitor_nodes SET status='failed',updated_at=? WHERE run_id=? AND status IN ('pending','running','retrying')").run(at, runId)
      db.prepare("UPDATE monitor_edges SET animated=0 WHERE run_id=?").run(runId)
    }
    db.prepare("UPDATE monitor_runs SET last_seq=MAX(last_seq,?),updated_at=? WHERE run_id=?").run(event.sequence, at, runId)
  })
  write()
}

function publicRun(row: Record<string, unknown>) {
  return { id: row.run_id, sessionId: row.session_id, status: row.status, startedAt: Date.parse(String(row.started_at)), ...(row.finished_at ? { endedAt: Date.parse(String(row.finished_at)) } : {}), lastSeq: row.last_seq, ...(row.plan_total != null ? { planTotal: row.plan_total } : {}), ...(row.plan_levels != null ? { planLevels: row.plan_levels } : {}), updatedAt: Date.parse(String(row.updated_at)) }
}

export function createMonitorHistoryRouter(db: Database.Database, requireAuth: RequestHandler, now: () => string) {
  ensureMonitorHistorySchema(db)
  const router = Router()
  router.use(requireAuth)

  router.get("/history", (req, res) => {
    const sessionId = typeof req.query.session_id === "string" ? safeId(req.query.session_id) : ""
    if (req.query.session_id && !sessionId) return res.status(400).json({ error: "invalid_session_id" })
    const limitValue = Number(req.query.limit ?? 12)
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(50, Math.floor(limitValue))) : 12
    const cursorFields = [req.query.before_seq, req.query.before_started_at, req.query.before_run_id]
    const hasCursor = cursorFields.some((value) => value !== undefined)
    let cursor: { seq: number; startedAt: string; runId: string } | undefined
    if (hasCursor) {
      const seq = Number(req.query.before_seq)
      const startedAt = typeof req.query.before_started_at === "string" ? req.query.before_started_at : ""
      const runId = safeId(req.query.before_run_id)
      if (!Number.isSafeInteger(seq) || seq < 0 || !startedAt || !Number.isFinite(Date.parse(startedAt)) || !runId) {
        return res.status(400).json({ error: "invalid_monitor_history_cursor" })
      }
      cursor = { seq, startedAt, runId }
    }
    const sessionWhere = sessionId ? "r.session_id=?" : "1=1"
    const cursorWhere = cursor ? `AND (
      (SELECT COALESCE(MAX(e.seq),0) FROM monitor_events e WHERE e.run_id=r.run_id)<?
      OR ((SELECT COALESCE(MAX(e.seq),0) FROM monitor_events e WHERE e.run_id=r.run_id)=?
        AND (r.started_at<? OR (r.started_at=? AND r.run_id<?)))
    )` : ""
    const sql = `SELECT r.*,(SELECT COALESCE(MAX(e.seq),0) FROM monitor_events e WHERE e.run_id=r.run_id) AS global_seq
      FROM monitor_runs r WHERE ${sessionWhere} ${cursorWhere}
      ORDER BY global_seq DESC,r.started_at DESC,r.run_id DESC LIMIT ?`
    const params: Array<string | number> = []
    if (sessionId) params.push(sessionId)
    if (cursor) params.push(cursor.seq, cursor.seq, cursor.startedAt, cursor.startedAt, cursor.runId)
    params.push(limit)
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    const high = db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM monitor_events").get() as { seq: number }
    const ids = rows.map((row) => row.run_id as string)
    if (ids.length === 0) return res.json({ runs: [], nodes: [], edges: [], high_water_seq: high.seq, next_before_seq: null, next_before: null, fetched_at: now() })
    const placeholders = ids.map(() => "?").join(",")
    const nodes = db.prepare(`SELECT * FROM monitor_nodes WHERE run_id IN (${placeholders}) ORDER BY created_at`).all(...ids) as Array<Record<string, unknown>>
    const edges = db.prepare(`SELECT * FROM monitor_edges WHERE run_id IN (${placeholders})`).all(...ids) as Array<Record<string, unknown>>
    const last = rows.at(-1)
    const hasMore = rows.length === limit && last !== undefined
    return res.json({
      runs: rows.map(publicRun),
      nodes: nodes.map((row) => ({ id: row.node_id, runId: row.run_id, type: NODE_TYPES.has(String(row.type)) ? row.type : "tool", label: row.label, status: NODE_STATUSES.has(String(row.status)) ? row.status : "failed", level: row.level, parallel: row.parallel === 1, ...(row.attempt != null ? { attempt: row.attempt } : {}), ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}), createdAt: Date.parse(String(row.created_at)), updatedAt: Date.parse(String(row.updated_at)), uiState: "minimized" })),
      edges: edges.map((row) => ({ id: row.edge_id, runId: row.run_id, source: row.source_node_id, target: row.target_node_id, animated: row.animated === 1 })),
      high_water_seq: high.seq,
      // Retain the numeric hint for older clients; the compound cursor also pages
      // legacy imported rows whose event sequence is zero.
      next_before_seq: hasMore && Math.min(...rows.map((row) => Number(row.global_seq))) > 0 ? Math.min(...rows.map((row) => Number(row.global_seq))) : null,
      next_before: hasMore ? { seq: Number(last.global_seq), started_at: String(last.started_at), run_id: String(last.run_id) } : null,
      fetched_at: now(),
    })
  })

  router.get("/history/:runId", (req, res) => {
    const runId = safeId(req.params.runId)
    const sessionId = typeof req.query.session_id === "string" ? safeId(req.query.session_id) : ""
    if (!runId || !sessionId) return res.status(400).json({ error: "session_id_required" })
    const run = db.prepare("SELECT * FROM monitor_runs WHERE run_id=? AND session_id=?").get(runId, sessionId) as Record<string, unknown> | undefined
    if (!run) return res.status(404).json({ error: "monitor_run_not_found" })
    const nodes = db.prepare("SELECT * FROM monitor_nodes WHERE run_id=? ORDER BY created_at").all(runId) as Array<Record<string, unknown>>
    const edges = db.prepare("SELECT * FROM monitor_edges WHERE run_id=?").all(runId) as Array<Record<string, unknown>>
    return res.json({ run: publicRun(run), nodes: nodes.map((row) => ({ id: row.node_id, runId: row.run_id, type: row.type, label: row.label, status: row.status, level: row.level, parallel: row.parallel === 1, ...(row.attempt != null ? { attempt: row.attempt } : {}), ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}), createdAt: Date.parse(String(row.created_at)), updatedAt: Date.parse(String(row.updated_at)) })), edges: edges.map((row) => ({ id: row.edge_id, runId: row.run_id, source: row.source_node_id, target: row.target_node_id, animated: row.animated === 1 })) })
  })

  router.get("/history/:runId/events", (req, res) => {
    const runId = safeId(req.params.runId)
    const after = Number(req.query.after_seq ?? 0)
    const requestedSession = typeof req.query.session_id === "string" ? safeId(req.query.session_id) : ""
    if (!runId || !requestedSession || !Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: "session_id_and_valid_cursor_required" })
    const run = db.prepare("SELECT session_id FROM monitor_runs WHERE run_id=?").get(runId) as { session_id: string } | undefined
    if (!run) return res.status(404).json({ error: "monitor_run_not_found" })
    if (run.session_id !== requestedSession) return res.status(404).json({ error: "monitor_run_not_found" })
    const rows = db.prepare("SELECT seq,stream_seq,event_type,payload_json,created_at FROM monitor_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500").all(runId, after) as Array<Record<string, unknown>>
    return res.json({ events: rows.map((row) => ({ seq: row.seq, stream_seq: row.stream_seq, type: row.event_type, payload: JSON.parse(String(row.payload_json)), timestamp: Date.parse(String(row.created_at)) })), high_water_seq: rows.at(-1)?.seq ?? after })
  })

  router.delete("/history/:runId", (req, res) => {
    const runId = safeId(req.params.runId)
    const sessionId = typeof req.query.session_id === "string" ? safeId(req.query.session_id) : ""
    if (!runId) return res.status(400).json({ error: "invalid_run_id" })
    if (!sessionId) return res.status(400).json({ error: "session_id_required" })
    const exists = db.prepare("SELECT 1 FROM monitor_runs WHERE run_id=? AND session_id=?").get(runId, sessionId)
    if (!exists) return res.status(404).json({ error: "monitor_run_not_found" })
    const remove = db.transaction(() => {
      db.prepare("DELETE FROM monitor_events WHERE run_id=?").run(runId)
      db.prepare("DELETE FROM monitor_edges WHERE run_id=?").run(runId)
      db.prepare("DELETE FROM monitor_nodes WHERE run_id=?").run(runId)
      db.prepare("DELETE FROM monitor_runs WHERE run_id=?").run(runId)
    })
    remove()
    return res.json({ deleted: true })
  })

  router.post("/history/import", (req, res) => {
    const importId = safeId(req.body?.import_id, 160)
    const sessionId = safeId(req.body?.session_id)
    if (!importId || !sessionId || !req.body?.history || typeof req.body.history !== "object") return res.status(400).json({ error: "invalid_import" })
    const prior = db.prepare("SELECT imported_count FROM monitor_imports WHERE import_id=?").get(importId) as { imported_count: number } | undefined
    if (prior) return res.json({ imported: true, duplicate: true, count: prior.imported_count })
    const history = req.body.history as Record<string, unknown>
    const runs = history.runs && typeof history.runs === "object" ? Object.values(history.runs as Record<string, unknown>).slice(0, 12) : []
    const nodes = history.nodes && typeof history.nodes === "object" ? Object.values(history.nodes as Record<string, unknown>).slice(0, 500) : []
    let count = 0
    const importTransaction = db.transaction(() => {
      for (const value of runs) {
        if (!value || typeof value !== "object") continue
        const r = value as Record<string, unknown>
        const runId = safeId(r.id)
        if (!runId || !RUN_STATUSES.has(String(r.status))) continue
        const dateFromMs = (value: unknown): string | null => {
          if (typeof value !== "number" || !Number.isFinite(value)) return null
          const parsed = new Date(value)
          return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
        }
        const started = dateFromMs(r.startedAt) ?? now()
        const rawStatus = String(r.status)
        const status = rawStatus === "running" ? "failed" : rawStatus
        const finished = dateFromMs(r.endedAt) ?? (rawStatus === "running" ? now() : null)
        const inserted = db.prepare("INSERT OR IGNORE INTO monitor_runs(run_id,session_id,status,started_at,finished_at,plan_total,plan_levels,updated_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(runId, sessionId, status, started, finished, finiteInt(r.planTotal) ?? null, finiteInt(r.planLevels) ?? null, now())
        if (inserted.changes) count++
      }
      for (const value of nodes) {
        if (!value || typeof value !== "object") continue
        const n = value as Record<string, unknown>
        const runId = safeId(n.runId); const nodeId = safeId(n.id)
        if (!runId || !nodeId || typeof n.label !== "string" || !NODE_STATUSES.has(String(n.status)) || !db.prepare("SELECT 1 FROM monitor_runs WHERE run_id=? AND session_id=?").get(runId, sessionId)) continue
        const type = NODE_TYPES.has(String(n.type)) ? String(n.type) : "tool"
        db.prepare("INSERT OR IGNORE INTO monitor_nodes(node_id,run_id,type,label,status,level,parallel,attempt,duration_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(nodeId, runId, type, safeLabel(n.label), ["pending", "running", "retrying"].includes(String(n.status)) ? "failed" : n.status, finiteInt(n.level) ?? 0, n.parallel === true ? 1 : 0, finiteInt(n.attempt) ?? null, finiteInt(n.durationMs, 0, 86_400_000) ?? null, iso(new Date(finiteInt(n.createdAt, 0, 8_640_000_000_000) ?? Date.now()).toISOString(), now()), now())
      }
      const edges = history.edges && typeof history.edges === "object" ? Object.values(history.edges as Record<string, unknown>).slice(0, 1500) : []
      for (const value of edges) {
        if (!value || typeof value !== "object") continue
        const edge = value as Record<string, unknown>
        const runId = safeId(edge.runId)
        const source = safeId(edge.source); const target = safeId(edge.target)
        if (!runId || !source || !target || !db.prepare("SELECT 1 FROM monitor_nodes WHERE run_id=? AND node_id=?").get(runId, source) || !db.prepare("SELECT 1 FROM monitor_nodes WHERE run_id=? AND node_id=?").get(runId, target)) continue
        const edgeId = `${source}->${target}`.slice(0, 420)
        db.prepare("INSERT OR IGNORE INTO monitor_edges(edge_id,run_id,source_node_id,target_node_id,animated) VALUES(?,?,?,?,0)").run(edgeId, runId, source, target)
      }
      db.prepare("INSERT INTO monitor_imports(import_id,session_id,imported_at,imported_count) VALUES(?,?,?,?)").run(importId, sessionId, now(), count)
    })
    importTransaction()
    return res.json({ imported: true, duplicate: false, count })
  })

  return router
}
