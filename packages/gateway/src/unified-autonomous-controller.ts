import type Database from "better-sqlite3"
import { getLifecycleBus } from "@miki/core/hooks"

export type UnifiedControllerHealth = {
  status?: string
  ok?: boolean
  degraded_reasons?: string[]
  pid?: number
  uptime_s?: number
  checks?: Record<string, unknown>
} | null

export interface UnifiedAutonomousControllerDeps {
  db?: Database.Database
  getConfig: () => Record<string, unknown>
  /** Wake the existing durable work supervisor; this controller does not execute goals itself. */
  wakeWork: () => void
  /** Current truthful runtime state from the existing AutonomousSupervisor. */
  autonomyContext: () => string
  /** Read-only current Gateway health snapshot. */
  healthReport: () => UnifiedControllerHealth
  /** Run the existing SelfImprovementEngine's due cycles. */
  runLearningCycle: (reason: string) => Promise<Record<string, unknown>>
  log: (message: string) => void
  intervalMs?: number
  now?: () => number
}

export interface UnifiedAutonomousControllerStatus {
  running: boolean
  startedAt: string | null
  lastTickAt: string | null
  lastTickReason: string | null
  tickCount: number
  lastLearningAt: string | null
  lastLearningReason: string | null
  lastLearningResult: Record<string, unknown> | null
  lastHealth: UnifiedControllerHealth
  lastAutonomyContext: string
  lastError: string | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

function normalizeHealth(value: UnifiedControllerHealth): UnifiedControllerHealth {
  if (!value) return null
  const checks = record(value.checks)
  const database = record(checks.database)
  const eventLoop = record(checks.event_loop)
  const model = record(checks.model)
  const channels = record(checks.channels)
  const outbox = record(checks.outbox)
  const runs = record(checks.runs)
  const recovery = record(checks.recovery)
  return {
    status: value.status,
    ok: value.ok,
    degraded_reasons: Array.isArray(value.degraded_reasons) ? value.degraded_reasons.slice(0, 20).map((reason) => String(reason).slice(0, 200)) : [],
    pid: value.pid,
    uptime_s: value.uptime_s,
    // Keep only operational metrics; provider/channel error details can contain sensitive endpoint data.
    checks: {
      database: { ok: database.ok, ms: database.ms },
      event_loop: { ok: eventLoop.ok, p99_ms: eventLoop.p99_ms, max_ms: eventLoop.max_ms },
      model: { ok: model.ok, configured: model.configured, reachable: model.reachable, loading: model.loading, checked_age_s: model.checked_age_s },
      channels: { ok: channels.ok, items: Array.isArray(channels.items) ? channels.items.map((item) => ({ name: record(item).name, connected: record(item).connected })) : [] },
      outbox: { ok: outbox.ok, pending: outbox.pending, failed: outbox.failed, oldest_pending_age_s: outbox.oldest_pending_age_s },
      runs: { active: runs.active, last_progress_age_s: runs.last_progress_age_s },
      recovery: { state: recovery.state },
    },
  }
}

/**
 * Coordinates the existing work supervisor, learning engine and health monitor.
 * It is intentionally an orchestration layer: goals, memory, recovery and policy remain owned by their existing modules.
 */
export class UnifiedAutonomousController {
  private readonly now: () => number
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private unsubscribe: Array<() => void> = []
  private tickPromise: Promise<void> | null = null
  private readonly pendingReasons = new Set<string>()
  private stopping = false
  private state: UnifiedAutonomousControllerStatus = {
    running: false,
    startedAt: null,
    lastTickAt: null,
    lastTickReason: null,
    tickCount: 0,
    lastLearningAt: null,
    lastLearningReason: null,
    lastLearningResult: null,
    lastHealth: null,
    lastAutonomyContext: "Runtime status has not been sampled yet.",
    lastError: null,
  }

  constructor(private readonly deps: UnifiedAutonomousControllerDeps) {
    this.now = deps.now ?? Date.now
    this.intervalMs = Math.max(5_000, Number(deps.intervalMs) || 30_000)
    this.restoreState()
  }

  private ensureSchema(): void {
    this.deps.db?.exec(`
      CREATE TABLE IF NOT EXISTS unified_autonomous_controller (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  private restoreState(): void {
    if (!this.deps.db) return
    try {
      this.ensureSchema()
      const row = this.deps.db.prepare("SELECT state_json FROM unified_autonomous_controller WHERE singleton=1").get() as { state_json?: string } | undefined
      if (!row?.state_json) return
      const saved = record(JSON.parse(row.state_json))
      this.state = {
        ...this.state,
        lastTickAt: typeof saved.lastTickAt === "string" ? saved.lastTickAt : null,
        lastTickReason: typeof saved.lastTickReason === "string" ? saved.lastTickReason : null,
        tickCount: Number.isFinite(Number(saved.tickCount)) ? Number(saved.tickCount) : 0,
        lastLearningAt: typeof saved.lastLearningAt === "string" ? saved.lastLearningAt : null,
        lastLearningReason: typeof saved.lastLearningReason === "string" ? saved.lastLearningReason : null,
        lastLearningResult: record(saved.lastLearningResult),
        lastHealth: normalizeHealth(saved.lastHealth as UnifiedControllerHealth),
        lastAutonomyContext: typeof saved.lastAutonomyContext === "string" ? saved.lastAutonomyContext : this.state.lastAutonomyContext,
        lastError: typeof saved.lastError === "string" ? saved.lastError : null,
      }
    } catch (error) {
      this.deps.log(`Unified controller state restore skipped: ${safeError(error)}`)
    }
  }

  private persist(): void {
    if (!this.deps.db) return
    try {
      this.ensureSchema()
      this.deps.db.prepare(`
        INSERT INTO unified_autonomous_controller(singleton,state_json,updated_at) VALUES(1,?,?)
        ON CONFLICT(singleton) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at
      `).run(JSON.stringify(this.state), new Date(this.now()).toISOString())
    } catch (error) {
      this.deps.log(`Unified controller state persistence skipped: ${safeError(error)}`)
    }
  }

  private evolutionSettings(): { enabled: boolean; trigger: string } {
    const config = this.deps.getConfig()
    const evolution = record(config.evolution)
    const selfImprovement = record(config.self_improvement)
    const merged = { ...selfImprovement, ...evolution }
    return {
      enabled: merged.enabled === true,
      trigger: String(merged.cold_path_trigger || "after_turn"),
    }
  }

  start(): void {
    if (this.timer || this.stopping) return
    this.stopping = false
    this.state.running = true
    this.state.startedAt = new Date(this.now()).toISOString()
    const bus = getLifecycleBus()
    this.unsubscribe.push(bus.on("gateway:startup", () => this.requestTick("gateway:startup")))
    this.unsubscribe.push(bus.on("message:received", () => this.requestTick("message:received")))
    this.unsubscribe.push(bus.on("message:sent", () => this.requestTick("message:sent")))
    this.unsubscribe.push(bus.on("learning:feedback", () => this.requestTick("learning:feedback")))
    this.timer = setInterval(() => this.requestTick("interval"), this.intervalMs)
    this.timer.unref?.()
    this.persist()
    this.requestTick("startup")
    this.deps.log(`Unified Autonomous Intelligence Controller started (interval ${this.intervalMs}ms).`)
  }

  private requestTick(reason: string): void {
    if (!this.state.running || this.stopping) return
    if (this.tickPromise) {
      this.pendingReasons.add(reason)
      return
    }
    const task = this.runTick(reason)
    this.tickPromise = task
    void task.finally(() => {
      if (this.tickPromise === task) this.tickPromise = null
      const priority = ["learning:feedback", "message:sent", "gateway:startup", "message:received", "interval"]
      const pending = priority.find((candidate) => this.pendingReasons.has(candidate)) ?? this.pendingReasons.values().next().value
      if (pending) this.pendingReasons.delete(pending)
      if (pending && !this.stopping) this.requestTick(pending)
    }).catch((error) => this.deps.log(`Unified controller tick dispatch failed: ${safeError(error)}`))
  }

  private async runTick(reason: string): Promise<void> {
    this.state.lastTickAt = new Date(this.now()).toISOString()
    this.state.lastTickReason = reason
    this.state.tickCount += 1
    this.state.lastError = null
    try {
      // Monitoring is read-only and deliberately isolated from work and learning failures.
      try {
        this.state.lastHealth = normalizeHealth(this.deps.healthReport())
      } catch (error) {
        this.state.lastError = `health: ${safeError(error)}`
      }

      try {
        this.state.lastAutonomyContext = String(this.deps.autonomyContext() || "Runtime status unavailable.").slice(0, 8_000)
      } catch (error) {
        this.state.lastAutonomyContext = `Runtime status unavailable: ${safeError(error)}`
      }

      const config = record(this.deps.getConfig())
      const autonomy = record(config.autonomy)
      const autonomyEnabled = process.env.MIKI_AUTONOMY_ENABLED !== "false" && autonomy.enabled !== false
      if (autonomyEnabled) {
        try { this.deps.wakeWork() }
        catch (error) {
          this.state.lastError = `work: ${safeError(error)}`
          this.deps.log(`Unified controller could not wake the work supervisor: ${safeError(error)}`)
        }
      }

      const evolution = this.evolutionSettings()
      const shouldLearn = evolution.enabled && (
        (evolution.trigger === "scheduled" && (reason === "startup" || reason === "interval" || reason === "gateway:startup")) ||
        (evolution.trigger === "after_turn" && (reason === "message:sent" || reason === "learning:feedback"))
      )
      if (shouldLearn) {
        try {
          const result = await this.deps.runLearningCycle(reason)
          this.state.lastLearningAt = new Date(this.now()).toISOString()
          this.state.lastLearningReason = reason
          this.state.lastLearningResult = result
        } catch (error) {
          this.state.lastError = `learning: ${safeError(error)}`
          this.deps.log(`Unified controller learning cycle failed: ${safeError(error)}`)
        }
      }
    } catch (error) {
      this.state.lastError = safeError(error)
      this.deps.log(`Unified controller tick failed: ${safeError(error)}`)
    } finally {
      this.persist()
    }
  }

  /** Explicit wake seam used by feedback ingestion and configuration changes. */
  wake(reason = "explicit_wake"): void {
    this.requestTick(reason)
  }

  status(): UnifiedAutonomousControllerStatus {
    return { ...this.state, lastHealth: this.state.lastHealth ? { ...this.state.lastHealth } : null, lastLearningResult: this.state.lastLearningResult ? { ...this.state.lastLearningResult } : null }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.state.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      try { unsubscribe() } catch { /* best-effort listener cleanup */ }
    }
    const running = this.tickPromise
    if (running) await running.catch((error) => this.deps.log(`Unified controller stopped after tick error: ${safeError(error)}`))
    this.persist()
    this.deps.log("Unified Autonomous Intelligence Controller stopped.")
  }
}
