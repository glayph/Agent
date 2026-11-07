import type Database from "better-sqlite3"

/**
 * Decides when "the outage is over".
 *
 * Every few seconds it asks one question: is everything Miki depends on reachable and healthy (database, model
 * provider, channel hosts)? A failed answer opens an incident (`disrupted`). Recovery is declared only after
 * `requiredGreen` consecutive good answers (default 3), and only then does the `recovered` callback fire, which is what
 * starts the replay of unanswered messages. Waiting for several green checks stops the replay from starting on a
 * connection that flaps.
 */

export type RecoveryState = "healthy" | "disrupted" | "recovering"

export interface RecoveryCheck {
  ok: boolean
  /** Short reason when not ok, e.g. "model server is not reachable". Never contains secrets. */
  reason?: string
}

export interface RecoveryIncident {
  id: number
  started_at: string
  ended_at: string | null
  reason: string
  checks_failed: number
  replayed: number
  remedy: string | null
}

function safeIncidentReason(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "unknown recovery failure")
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(\b(?:api[-_]?key|token|secret|password|passwd|credential|client[-_]?secret)\b\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .slice(0, 300)
}

export interface RecoveryManagerDeps {
  db: Database.Database
  check: () => Promise<RecoveryCheck>
  /** Runs when an incident ends. Returns how many messages it replayed, for the incident record. */
  onRecovered?: (incident: RecoveryIncident) => Promise<number | void> | number | void
  onDisrupted?: (incident: RecoveryIncident) => void
  log: (message: string) => void
  now?: () => string
  intervalMs?: number
  /** Consecutive good checks needed to declare recovery. May be a function so it can be tuned while running. */
  requiredGreen?: number | (() => number)
  /** Called after an incident is closed and its replay count is recorded (used by self-learning). */
  onIncidentClosed?: (incident: RecoveryIncident) => void
}

export function ensureRecoverySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      reason TEXT NOT NULL,
      checks_failed INTEGER NOT NULL DEFAULT 1,
      replayed INTEGER NOT NULL DEFAULT 0,
      remedy TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_incidents_started ON recovery_incidents(started_at);
  `)
}

export class RecoveryManager {
  private current: RecoveryState = "healthy"
  private incidentId: number | undefined
  private green = 0
  private timer: NodeJS.Timeout | undefined
  private busy = false
  private readonly now: () => string
  private readonly greenNeeded: () => number

  constructor(private readonly deps: RecoveryManagerDeps) {
    ensureRecoverySchema(deps.db)
    this.now = deps.now ?? (() => new Date().toISOString())
    const configured = deps.requiredGreen
    this.greenNeeded = () => Math.max(1, Math.floor(typeof configured === "function" ? configured() : configured ?? 3))
    // An incident left open by a crash is closed at startup: the process is back, which is recovery enough.
    deps.db.prepare("UPDATE recovery_incidents SET ended_at=?, remedy=COALESCE(remedy,'process restarted') WHERE ended_at IS NULL").run(this.now())
  }

  get state(): RecoveryState { return this.current }

  start(): void {
    if (this.timer) return
    const interval = Math.max(1_000, Math.min(5 * 60_000, this.deps.intervalMs ?? 10_000))
    this.timer = setInterval(() => { void this.tick() }, interval)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  recentIncidents(limit = 20): RecoveryIncident[] {
    return this.deps.db.prepare("SELECT * FROM recovery_incidents ORDER BY id DESC LIMIT ?").all(limit) as RecoveryIncident[]
  }

  /** One check. Public so tests (and a manual "check now") can drive it. */
  async tick(): Promise<RecoveryState> {
    if (this.busy) return this.current
    this.busy = true
    try {
      let result: RecoveryCheck
      try { result = await this.deps.check() } catch (error) { result = { ok: false, reason: safeIncidentReason(error) } }
      if (!result.ok) await this.noteFailure(result.reason || "a dependency is not healthy")
      else await this.noteSuccess()
    } finally { this.busy = false }
    return this.current
  }

  private async noteFailure(reason: string): Promise<void> {
    this.green = 0
    if (this.current === "healthy") {
      const info = this.deps.db.prepare("INSERT INTO recovery_incidents(started_at,reason) VALUES(?,?)").run(this.now(), safeIncidentReason(reason))
      this.incidentId = Number(info.lastInsertRowid)
      this.current = "disrupted"
      this.deps.log(`Recovery: disruption detected (${reason}).`)
      const incident = this.incident()
      if (incident) { try { this.deps.onDisrupted?.(incident) } catch { /* observers must not break detection */ } }
      return
    }
    if (this.incidentId !== undefined) this.deps.db.prepare("UPDATE recovery_incidents SET checks_failed=checks_failed+1, reason=? WHERE id=?").run(safeIncidentReason(reason), this.incidentId)
    this.current = "disrupted"
  }

  private async noteSuccess(): Promise<void> {
    if (this.current === "healthy") return
    this.green += 1
    this.current = "recovering"
    if (this.green < this.greenNeeded()) return
    const id = this.incidentId
    if (id === undefined) { this.current = "healthy"; this.green = 0; return }
    let replayed = 0
    try {
      replayed = Number(await this.deps.onRecovered?.(this.incident()!)) || 0
    } catch (error) {
      // Keep the incident open. A later green-check window retries replay; the replay sweeper is idempotent.
      this.current = "disrupted"
      this.green = 0
      this.deps.log(`Recovery: dependencies are healthy but replay did not complete; recovery will retry (${safeIncidentReason(error)}).`)
      return
    }
    this.deps.db.prepare("UPDATE recovery_incidents SET ended_at=?, replayed=?, remedy=? WHERE id=?").run(this.now(), replayed, "dependencies recovered; unanswered messages replayed", id)
    const incident = this.deps.db.prepare("SELECT * FROM recovery_incidents WHERE id=?").get(id) as RecoveryIncident
    this.incidentId = undefined
    this.green = 0
    this.current = "healthy"
    this.deps.log("Recovery: dependencies are healthy again; replay completed.")
    try { this.deps.onIncidentClosed?.(incident) } catch { /* learning must never break recovery */ }
  }

  private incident(): RecoveryIncident | undefined {
    return this.incidentId === undefined ? undefined : this.deps.db.prepare("SELECT * FROM recovery_incidents WHERE id=?").get(this.incidentId) as RecoveryIncident
  }

  /** Writes what was done about the current incident (read by the self-learning step). */
  setRemedy(text: string): void {
    if (this.incidentId !== undefined) this.deps.db.prepare("UPDATE recovery_incidents SET remedy=? WHERE id=?").run(safeIncidentReason(text), this.incidentId)
  }
}
