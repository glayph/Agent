import type Database from "better-sqlite3"
import { Router, type RequestHandler } from "express"

const RUN_STATUSES = new Set(["running", "completed", "failed"])
const NODE_STATUSES = new Set(["pending", "running", "retrying", "completed", "failed"])
const NODE_TYPES = new Set(["tool", "skill", "plugin", "file", "command", "pattern", "system", "browser", "computer", "terminal", "memory", "mcp", "search", "goal", "workflow", "agent"])
const safeId = (value: unknown, limit = 200): string => typeof value === "string" && /^[A-Za-z0-9_.:-]+$/.test(value) ? value.slice(0, limit) : ""
const safeLabel = (value: unknown): string => typeof value === "string" ? value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80) : "unknown"
const safeDisplayName = (value: unknown): string | undefined => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) || undefined : undefined
const safeError = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .trim().slice(0, 2000)
  return cleaned || undefined
}
const safeIconKey = (value: unknown): string | undefined => typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value) ? value.toLowerCase() : undefined
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
      trace_id TEXT, source_message_id TEXT, context_id TEXT, parent_run_id TEXT,
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
    CREATE TABLE IF NOT EXISTS system_health_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sampled_at TEXT NOT NULL, status TEXT NOT NULL,
      cpu_count REAL, load_per_cpu REAL, load_available INTEGER, free_memory_ratio REAL, free_memory_bytes REAL, total_memory_bytes REAL,
      free_disk_ratio REAL, disk_free_bytes REAL, disk_total_bytes REAL,
      process_rss_bytes REAL, process_heap_used_bytes REAL, process_cpu_percent REAL,
      event_loop_p99_ms REAL, active_runs INTEGER, active_leases INTEGER, waiting INTEGER,
      oldest_waiter_age_ms REAL, saturated_resources_json TEXT NOT NULL DEFAULT '[]',
      outbox_pending INTEGER, model_reachable INTEGER, database_ok INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_system_health_samples_at ON system_health_samples(sampled_at DESC);
  `)
  const columns = new Set((db.prepare("PRAGMA table_info(monitor_runs)").all() as Array<{ name: string }>).map((row) => row.name))
  for (const [name, definition] of [["trace_id", "TEXT"], ["source_message_id", "TEXT"], ["context_id", "TEXT"], ["parent_run_id", "TEXT"]] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE monitor_runs ADD COLUMN ${name} ${definition}`)
  }
  const nodeColumns = new Set((db.prepare("PRAGMA table_info(monitor_nodes)").all() as Array<{ name: string }>).map((row) => row.name))
  for (const [name, definition] of [["icon_key", "TEXT"], ["display_name", "TEXT"], ["tool_name", "TEXT"], ["plugin_id", "TEXT"], ["provider_id", "TEXT"], ["error", "TEXT"]] as const) {
    if (!nodeColumns.has(name)) db.exec(`ALTER TABLE monitor_nodes ADD COLUMN ${name} ${definition}`)
  }
  db.exec("UPDATE monitor_runs SET trace_id=run_id WHERE trace_id IS NULL")
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
    case "node.run_start": return {
      run_id: runId, status: "running",
      trace_id: safeId(input.trace_id) || runId,
      ...(safeId(input.source_message_id) ? { source_message_id: safeId(input.source_message_id) } : {}),
      ...(safeId(input.context_id) ? { context_id: safeId(input.context_id) } : {}),
      ...(safeId(input.parent_run_id) ? { parent_run_id: safeId(input.parent_run_id) } : {}),
    }
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
      const nodeType = typeof input.node_type === "string" && NODE_TYPES.has(input.node_type) ? input.node_type : undefined
      const rawParents = Array.isArray(input.parent_node_ids) ? input.parent_node_ids : Array.isArray(input.depends_on) ? input.depends_on : []
      const parentNodeIds = [...new Set(rawParents.slice(0, 50).map((value) => safeId(value)).filter((value) => value && value !== nodeId))]
      return {
        run_id: runId, node_id: nodeId, label: safeLabel(input.label), status, level, parallel: input.parallel === true,
        ...(nodeType ? { node_type: nodeType } : {}),
        parent_node_ids: parentNodeIds,
        ...(safeIconKey(input.icon_key) ? { icon_key: safeIconKey(input.icon_key) } : {}),
        ...(safeDisplayName(input.display_name) ? { display_name: safeDisplayName(input.display_name) } : {}),
        ...(safeId(input.tool_name, 80) ? { tool_name: safeId(input.tool_name, 80) } : {}),
        ...(safeId(input.plugin_id, 120) ? { plugin_id: safeId(input.plugin_id, 120) } : {}),
        ...(safeId(input.provider_id, 120) ? { provider_id: safeId(input.provider_id, 120) } : {}),
      }
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
      return { run_id: runId, node_id: nodeId, ok: input.ok !== false, ...(duration !== undefined ? { duration_ms: duration } : {}), ...(safeError(input.error ?? input.result_message) ? { error: safeError(input.error ?? input.result_message) } : {}) }
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
      db.prepare("INSERT INTO monitor_runs(run_id,session_id,status,trace_id,source_message_id,context_id,parent_run_id,started_at,last_seq,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(runId, sessionId, "running", runId, null, null, null, at, 0, at)
    }
    const inserted = db.prepare("INSERT OR IGNORE INTO monitor_events(run_id,session_id,stream_seq,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(runId, sessionId, event.sequence, event.type, JSON.stringify(cleaned), at)
    if (inserted.changes === 0) return

    if (event.type === "node.run_start") {
      const p = cleaned as { trace_id?: string; source_message_id?: string; context_id?: string; parent_run_id?: string }
      db.prepare("UPDATE monitor_runs SET status='running', trace_id=COALESCE(?,trace_id,run_id), source_message_id=COALESCE(?,source_message_id), context_id=COALESCE(?,context_id), parent_run_id=COALESCE(?,parent_run_id), started_at=COALESCE(started_at,?), finished_at=NULL, last_seq=?,updated_at=? WHERE run_id=?")
        .run(p.trace_id ?? runId, p.source_message_id ?? null, p.context_id ?? null, p.parent_run_id ?? null, at, event.sequence, at, runId)
    } else if (event.type === "node.plan") {
      const p = cleaned as { total?: number; levels?: number }
      db.prepare("UPDATE monitor_runs SET plan_total=COALESCE(?,plan_total),plan_levels=COALESCE(?,plan_levels),last_seq=?,updated_at=? WHERE run_id=?")
        .run(p.total ?? null, p.levels ?? null, event.sequence, at, runId)
    } else if (event.type === "node.spawn") {
      const p = cleaned as { node_id: string; label: string; status: string; level: number; parallel: boolean; node_type?: string; parent_node_ids?: string[]; icon_key?: string; display_name?: string; tool_name?: string; plugin_id?: string; provider_id?: string }
      const inferred = p.node_type ?? "tool"
      db.prepare(`INSERT INTO monitor_nodes(node_id,run_id,type,label,status,level,parallel,icon_key,display_name,tool_name,plugin_id,provider_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET type=excluded.type,label=excluded.label,status=excluded.status,level=excluded.level,parallel=excluded.parallel,icon_key=COALESCE(excluded.icon_key,monitor_nodes.icon_key),display_name=COALESCE(excluded.display_name,monitor_nodes.display_name),tool_name=COALESCE(excluded.tool_name,monitor_nodes.tool_name),plugin_id=COALESCE(excluded.plugin_id,monitor_nodes.plugin_id),provider_id=COALESCE(excluded.provider_id,monitor_nodes.provider_id),updated_at=excluded.updated_at`)
        .run(p.node_id, runId, NODE_TYPES.has(inferred) ? inferred : "tool", p.label, p.status, p.level, p.parallel ? 1 : 0, p.icon_key ?? null, p.display_name ?? null, p.tool_name ?? null, p.plugin_id ?? null, p.provider_id ?? null, at, at)
      // `node.spawn` is also used for planner updates. Replace this node's incoming
      // edges so changed plan dependencies cannot leave stale connections behind.
      db.prepare("DELETE FROM monitor_edges WHERE run_id=? AND target_node_id=?").run(runId, p.node_id)
      for (const parentId of p.parent_node_ids ?? []) {
        if (parentId === p.node_id) continue
        const existingParent = db.prepare("SELECT run_id FROM monitor_nodes WHERE node_id=?").get(parentId) as { run_id: string } | undefined
        // Known cross-run parents are rejected; not-yet-arrived same-run parents are retained and resolve later.
        if (existingParent && existingParent.run_id !== runId) continue
        if (!existingParent && !parentId.startsWith(`${runId}:`)) continue
        const wouldCreateCycle = db.prepare(`WITH RECURSIVE reachable(node_id) AS (
          SELECT target_node_id FROM monitor_edges WHERE run_id=? AND source_node_id=?
          UNION
          SELECT e.target_node_id FROM monitor_edges e JOIN reachable r ON e.source_node_id=r.node_id WHERE e.run_id=?
        ) SELECT 1 FROM reachable WHERE node_id=? LIMIT 1`).get(runId, p.node_id, runId, parentId)
        if (wouldCreateCycle) continue
        const edgeId = `${parentId}->${p.node_id}`.slice(0, 420)
        const animated = p.status === "running" || p.status === "retrying" ? 1 : 0
        db.prepare("INSERT OR IGNORE INTO monitor_edges(edge_id,run_id,source_node_id,target_node_id,animated) VALUES(?,?,?,?,?)").run(edgeId, runId, parentId, p.node_id, animated)
      }
    } else if (event.type === "node.update") {
      const p = cleaned as { node_id: string; status?: string; attempt?: number }
      db.prepare("UPDATE monitor_nodes SET status=COALESCE(?,status),attempt=COALESCE(?,attempt),updated_at=? WHERE run_id=? AND node_id=?")
        .run(p.status ?? null, p.attempt ?? null, at, runId, p.node_id)
      if (p.status) {
        const animated = p.status === "running" || p.status === "retrying" ? 1 : 0
        db.prepare("UPDATE monitor_edges SET animated=? WHERE run_id=? AND target_node_id=?").run(animated, runId, p.node_id)
      }
    } else if (event.type === "node.complete") {
      const p = cleaned as { node_id: string; ok: boolean; duration_ms?: number; error?: string }
      db.prepare("UPDATE monitor_nodes SET status=?,duration_ms=COALESCE(?,duration_ms),error=COALESCE(?,error),updated_at=? WHERE run_id=? AND node_id=?")
        .run(p.ok ? "completed" : "failed", p.duration_ms ?? null, p.error ?? null, at, runId, p.node_id)
      db.prepare("UPDATE monitor_edges SET animated=0 WHERE run_id=? AND (target_node_id=? OR (?=0 AND source_node_id=?))")
        .run(runId, p.node_id, p.ok ? 1 : 0, p.node_id)
    } else if (event.type === "node.run_end") {
      const p = cleaned as { status: string }
      db.prepare("UPDATE monitor_runs SET status=?,finished_at=?,last_seq=?,updated_at=? WHERE run_id=?")
        .run(p.status, at, event.sequence, at, runId)
      db.prepare("UPDATE monitor_nodes SET status='failed',updated_at=? WHERE run_id=? AND status IN ('pending','running','retrying') AND node_id<>?").run(at, runId, `${runId}:root`)
      db.prepare("UPDATE monitor_nodes SET status=?,updated_at=? WHERE run_id=? AND node_id=?").run(p.status, at, runId, `${runId}:root`)
      db.prepare("UPDATE monitor_edges SET animated=0 WHERE run_id=?").run(runId)
    }
    db.prepare("UPDATE monitor_runs SET last_seq=MAX(last_seq,?),updated_at=? WHERE run_id=?").run(event.sequence, at, runId)
  })
  write()
}

export function persistSystemHealthSample(db: Database.Database, report: {
  status?: unknown
  resource_arbitration?: Record<string, unknown> | null
  resources?: Record<string, unknown>
  resource_pressure?: Record<string, unknown>
  checks?: Record<string, unknown>
}, sampledAt = new Date().toISOString()): void {
  const host = report.resource_arbitration ?? {}
  const resources = report.resources ?? {}
  const pressure = report.resource_pressure ?? {}
  const checks = report.checks ?? {}
  const eventLoop = (checks.event_loop && typeof checks.event_loop === "object" ? checks.event_loop : {}) as Record<string, unknown>
  const runs = (checks.runs && typeof checks.runs === "object" ? checks.runs : {}) as Record<string, unknown>
  const outbox = (checks.outbox && typeof checks.outbox === "object" ? checks.outbox : {}) as Record<string, unknown>
  const model = (checks.model && typeof checks.model === "object" ? checks.model : {}) as Record<string, unknown>
  const database = (checks.database && typeof checks.database === "object" ? checks.database : {}) as Record<string, unknown>
  const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null
  const bool = (value: unknown): number | null => typeof value === "boolean" ? (value ? 1 : 0) : null
  const saturated = Array.isArray(pressure.saturated_resources) ? pressure.saturated_resources.filter((item: unknown) => typeof item === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(item)).slice(0, 50) : []
  const status = ["ok", "degraded", "unhealthy"].includes(String(report.status)) ? String(report.status) : "unknown"
  db.prepare(`INSERT INTO system_health_samples(sampled_at,status,cpu_count,load_per_cpu,load_available,free_memory_ratio,free_memory_bytes,total_memory_bytes,free_disk_ratio,disk_free_bytes,disk_total_bytes,process_rss_bytes,process_heap_used_bytes,process_cpu_percent,event_loop_p99_ms,active_runs,active_leases,waiting,oldest_waiter_age_ms,saturated_resources_json,outbox_pending,model_reachable,database_ok)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      iso(sampledAt, new Date().toISOString()),
      status,
      finite(host.cpuCount), finite(host.loadPerCpu), typeof host.loadAvailable === "boolean" ? (host.loadAvailable ? 1 : 0) : null, finite(host.freeMemoryRatio), finite(host.freeMemoryBytes), finite(host.totalMemoryBytes),
      finite(host.freeDiskRatio), finite(host.diskFreeBytes), finite(host.diskTotalBytes), finite(resources.process_rss_bytes), finite(resources.process_heap_used_bytes),
      finite(resources.process_cpu_percent_of_one_core), finite(eventLoop.p99_ms), finite(runs.active), finite(host.activeLeases), finite(host.waiting),
      finite(host.oldestWaiterAgeMs), JSON.stringify(saturated), finite(outbox.pending), bool(model.reachable), bool(database.ok),
    )
}

export function pruneSystemHealthSamples(db: Database.Database, timestamp = new Date().toISOString(), retentionDays = 14, maxRows = 20_000): number {
  const days = Number.isFinite(retentionDays) ? Math.max(1, Math.min(365, Math.floor(retentionDays))) : 14
  const limit = Number.isFinite(maxRows) ? Math.max(100, Math.min(200_000, Math.floor(maxRows))) : 20_000
  const cutoff = new Date(Date.parse(timestamp) - days * 86_400_000).toISOString()
  const result = db.prepare("DELETE FROM system_health_samples WHERE sampled_at<? OR id NOT IN (SELECT id FROM system_health_samples ORDER BY id DESC LIMIT ?)").run(cutoff, limit)
  return result.changes
}

function publicRun(row: Record<string, unknown>) {
  return { id: row.run_id, traceId: row.trace_id || row.run_id, ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}), ...(row.context_id ? { contextId: row.context_id } : {}), ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}), sessionId: row.session_id, status: row.status, startedAt: Date.parse(String(row.started_at)), ...(row.finished_at ? { endedAt: Date.parse(String(row.finished_at)) } : {}), lastSeq: row.last_seq, ...(row.plan_total != null ? { planTotal: row.plan_total } : {}), ...(row.plan_levels != null ? { planLevels: row.plan_levels } : {}), updatedAt: Date.parse(String(row.updated_at)) }
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
    const activeOnly = req.query.active_only === "1" || req.query.active_only === "true"
    const sessionWhere = [sessionId ? "r.session_id=?" : "1=1", ...(activeOnly ? ["r.status='running'"] : [])].join(" AND ")
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
      nodes: nodes.map((row) => ({ id: row.node_id, runId: row.run_id, type: NODE_TYPES.has(String(row.type)) ? row.type : "tool", label: row.label, status: NODE_STATUSES.has(String(row.status)) ? row.status : "failed", level: row.level, parallel: row.parallel === 1, ...(row.attempt != null ? { attempt: row.attempt } : {}), ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}), ...(row.icon_key ? { iconKey: row.icon_key } : {}), ...(row.display_name ? { displayName: row.display_name } : {}), ...(row.tool_name ? { toolName: row.tool_name } : {}), ...(row.plugin_id ? { pluginId: row.plugin_id } : {}), ...(row.provider_id ? { providerId: row.provider_id } : {}), ...(row.error ? { error: row.error } : {}), createdAt: Date.parse(String(row.created_at)), updatedAt: Date.parse(String(row.updated_at)), uiState: "minimized" })),
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
    return res.json({ run: publicRun(run), nodes: nodes.map((row) => ({ id: row.node_id, runId: row.run_id, type: row.type, label: row.label, status: row.status, level: row.level, parallel: row.parallel === 1, ...(row.attempt != null ? { attempt: row.attempt } : {}), ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}), ...(row.icon_key ? { iconKey: row.icon_key } : {}), ...(row.display_name ? { displayName: row.display_name } : {}), ...(row.tool_name ? { toolName: row.tool_name } : {}), ...(row.plugin_id ? { pluginId: row.plugin_id } : {}), ...(row.provider_id ? { providerId: row.provider_id } : {}), ...(row.error ? { error: row.error } : {}), createdAt: Date.parse(String(row.created_at)), updatedAt: Date.parse(String(row.updated_at)) })), edges: edges.map((row) => ({ id: row.edge_id, runId: row.run_id, source: row.source_node_id, target: row.target_node_id, animated: row.animated === 1 })) })
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

  router.get("/system-health", (req, res) => {
    const limitValue = Number(req.query.limit ?? 240)
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(2_000, Math.floor(limitValue))) : 240
    const rows = db.prepare("SELECT * FROM system_health_samples ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>
    return res.json({ samples: rows.reverse().map((row) => ({ id: row.id, sampledAt: Date.parse(String(row.sampled_at)), status: row.status, host: { cpuCount: row.cpu_count, loadPerCpu: row.load_per_cpu, loadAvailable: row.load_available == null ? null : row.load_available === 1, freeMemoryRatio: row.free_memory_ratio, freeMemoryBytes: row.free_memory_bytes, totalMemoryBytes: row.total_memory_bytes, freeDiskRatio: row.free_disk_ratio, diskFreeBytes: row.disk_free_bytes, diskTotalBytes: row.disk_total_bytes }, process: { rssBytes: row.process_rss_bytes, heapUsedBytes: row.process_heap_used_bytes, cpuPercentOfOneCore: row.process_cpu_percent }, eventLoopP99Ms: row.event_loop_p99_ms, runs: { active: row.active_runs }, resources: { activeLeases: row.active_leases, waiting: row.waiting, oldestWaiterAgeMs: row.oldest_waiter_age_ms, saturated: JSON.parse(String(row.saturated_resources_json || "[]")) }, outboxPending: row.outbox_pending, modelReachable: row.model_reachable == null ? null : row.model_reachable === 1, databaseOk: row.database_ok == null ? null : row.database_ok === 1 })), fetchedAt: now() })
  })

  router.get("/trace/:runId", (req, res) => {
    const runId = safeId(req.params.runId)
    const sessionId = typeof req.query.session_id === "string" ? safeId(req.query.session_id) : ""
    if (!runId || !sessionId) return res.status(400).json({ error: "session_id_required" })
    const run = db.prepare("SELECT * FROM monitor_runs WHERE run_id=? AND session_id=?").get(runId, sessionId) as Record<string, unknown> | undefined
    if (!run) return res.status(404).json({ error: "monitor_run_not_found" })
    const nodes = db.prepare("SELECT * FROM monitor_nodes WHERE run_id=? ORDER BY level,created_at,node_id").all(runId) as Array<Record<string, unknown>>
    const edges = db.prepare("SELECT * FROM monitor_edges WHERE run_id=? ORDER BY edge_id").all(runId) as Array<Record<string, unknown>>
    const events = db.prepare("SELECT seq,stream_seq,event_type,payload_json,created_at FROM monitor_events WHERE run_id=? ORDER BY seq LIMIT 2000").all(runId) as Array<Record<string, unknown>>
    return res.json({ trace: publicRun(run), nodes: nodes.map((row) => ({ id: row.node_id, type: row.type, label: row.label, status: row.status, level: row.level, attempt: row.attempt, durationMs: row.duration_ms, iconKey: row.icon_key, displayName: row.display_name, toolName: row.tool_name, pluginId: row.plugin_id, providerId: row.provider_id, error: row.error })), edges: edges.map((row) => ({ id: row.edge_id, source: row.source_node_id, target: row.target_node_id, animated: row.animated === 1 })), events: events.map((row) => ({ seq: row.seq, streamSeq: row.stream_seq, type: row.event_type, payload: JSON.parse(String(row.payload_json)), timestamp: Date.parse(String(row.created_at)) })), eventCount: events.length })
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
        db.prepare("INSERT OR IGNORE INTO monitor_nodes(node_id,run_id,type,label,status,level,parallel,attempt,duration_ms,created_at,updated_at,icon_key,display_name,tool_name,plugin_id,provider_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(nodeId, runId, type, safeLabel(n.label), ["pending", "running", "retrying"].includes(String(n.status)) ? "failed" : n.status, finiteInt(n.level) ?? 0, n.parallel === true ? 1 : 0, finiteInt(n.attempt) ?? null, finiteInt(n.durationMs, 0, 86_400_000) ?? null, iso(new Date(finiteInt(n.createdAt, 0, 8_640_000_000_000) ?? Date.now()).toISOString(), now()), now(), safeIconKey(n.iconKey) ?? null, safeDisplayName(n.displayName) ?? null, safeId(n.toolName, 160) || null, safeId(n.pluginId, 120) || null, safeId(n.providerId, 120) || null)
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
