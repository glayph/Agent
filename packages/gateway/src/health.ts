import { monitorEventLoopDelay } from "node:perf_hooks"
import type Database from "better-sqlite3"

/**
 * Real health for the gateway.
 *
 *  - `/gateway/live`   : answers as long as the event loop runs. Nothing else is touched, so a missing answer means the
 *                        process is hung or dead. The watchdogs use this to find a hang.
 *  - `/gateway/health` : checks the database, event-loop lag, the model provider (a real network probe, cached), the
 *                        external channels, the reply outbox and run progress.
 *
 * Status meaning: `ok`; `degraded` = something is wrong but restarting the gateway would not fix it (model server
 * down or loading, a channel disconnected, replies waiting); `unhealthy` = the database itself failed.
 * A degraded gateway still answers HTTP 200 so that no watchdog restarts it for a model or network outage.
 */

export type HealthStatus = "ok" | "degraded" | "unhealthy"

export interface ModelProbeResult {
  configured: boolean
  reachable: boolean
  /** The provider answered but is still loading the model (a local llama server starting up). */
  loading?: boolean
  detail?: string
}

export interface HealthDeps {
  db: Database.Database
  /** One real, time-limited request to the model provider. Never throws. */
  probeModel: () => Promise<ModelProbeResult>
  channels: () => Array<{ name: string; enabled: boolean; configured: boolean; connected: boolean; lastError?: string }>
  outbox: () => { pending: number; failed: number; oldestPendingAgeMs: number }
  runProgress: () => { activeRuns: number; lastProgressAt?: number }
  /** Recovery manager state, when recovery v2 is on. */
  recovery?: () => string | undefined
  gatewayRole: string
  lifecycleOwner: string
  now?: () => number
  /** How long a model probe result is reused. Default 15 s. */
  modelProbeTtlMs?: number
  /** Event-loop delay (p99) above this makes the gateway degraded. Default 1000 ms. */
  eventLoopWarnMs?: number
  /** A reply waiting in the outbox longer than this makes the gateway degraded. Default 10 min. */
  outboxWarnAgeMs?: number
}

export interface HealthReport {
  status: HealthStatus
  ok: boolean
  coreHealthy: boolean
  gateway: string
  backend_role: string
  lifecycle_owner: string
  pid: number
  uptime_s: number
  checks: {
    database: { ok: boolean; ms: number; error?: string }
    event_loop: { ok: boolean; p99_ms: number; max_ms: number }
    model: { ok: boolean; configured: boolean; reachable: boolean | null; loading: boolean; detail?: string; checked_age_s: number | null }
    channels: { ok: boolean; items: Array<{ name: string; connected: boolean; lastError?: string }> }
    outbox: { ok: boolean; pending: number; failed: number; oldest_pending_age_s: number }
    runs: { active: number; last_progress_age_s: number | null }
    recovery: { state: string | null }
  }
  degraded_reasons: string[]
}

export function createHealthMonitor(deps: HealthDeps) {
  const now = deps.now ?? (() => Date.now())
  const modelTtl = deps.modelProbeTtlMs ?? 15_000
  const loopWarn = deps.eventLoopWarnMs ?? 1_000
  const outboxWarn = deps.outboxWarnAgeMs ?? 10 * 60_000
  const startedAt = now()
  const loop = monitorEventLoopDelay({ resolution: 20 })
  let loopStarted = false
  let model: { at: number; result: ModelProbeResult } | undefined
  let probing: Promise<void> | undefined
  let timer: NodeJS.Timeout | undefined

  const refreshModel = (): Promise<void> => {
    if (probing) return probing
    probing = deps.probeModel()
      .then((result) => { model = { at: now(), result } })
      .catch((error) => { model = { at: now(), result: { configured: true, reachable: false, detail: error instanceof Error ? error.message : String(error) } } })
      .finally(() => { probing = undefined })
    return probing
  }

  return {
    /** Starts event-loop sampling and keeps the model probe fresh in the background (never blocks a request). */
    start(): void {
      if (!loopStarted) { loop.enable(); loopStarted = true }
      void refreshModel()
      timer = setInterval(() => { void refreshModel() }, modelTtl)
      timer.unref?.()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = undefined
      if (loopStarted) { loop.disable(); loopStarted = false }
    },
    /** Cheap liveness answer; touches nothing but the process. */
    live() {
      return { status: "ok" as const, ok: true, pid: process.pid, uptime_s: Math.round((now() - startedAt) / 1000) }
    },
    /** Waits for a fresh model probe. Used by tests and by the verify script; HTTP health uses the cached result. */
    refreshModel,
    report(): HealthReport {
      const reasons: string[] = []
      const t0 = now()

      let database: HealthReport["checks"]["database"]
      try {
        deps.db.prepare("SELECT 1").get()
        database = { ok: true, ms: Math.max(0, now() - t0) }
      } catch (error) {
        database = { ok: false, ms: Math.max(0, now() - t0), error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }
        reasons.push("database check failed")
      }

      const p99 = loopStarted ? loop.percentile(99) / 1e6 : 0
      const max = loopStarted ? loop.max / 1e6 : 0
      if (loopStarted) loop.reset()
      const eventLoop = { ok: !(p99 > loopWarn), p99_ms: Math.round(p99), max_ms: Math.round(max) }
      if (!eventLoop.ok) reasons.push(`event loop is slow (p99 ${eventLoop.p99_ms} ms)`)

      if (!model || now() - model.at > modelTtl * 4) void refreshModel()
      const m = model?.result
      const modelCheck = {
        ok: Boolean(m && m.configured && m.reachable),
        configured: m?.configured ?? false,
        reachable: m ? m.reachable : null,
        loading: Boolean(m?.loading),
        ...(m?.detail ? { detail: m.detail.slice(0, 200) } : {}),
        checked_age_s: model ? Math.round((now() - model.at) / 1000) : null,
      }
      if (m && !modelCheck.ok) reasons.push(!m.configured ? "no model is configured" : m.loading ? "model server is still loading" : "model server is not reachable")

      const channelItems = deps.channels().filter((c) => c.enabled && c.configured).map((c) => ({ name: c.name, connected: c.connected, ...(c.lastError ? { lastError: c.lastError.slice(0, 200) } : {}) }))
      const channels = { ok: channelItems.every((c) => c.connected), items: channelItems }
      for (const c of channelItems) if (!c.connected) reasons.push(`${c.name} channel is not connected`)

      let outboxStats = { pending: 0, failed: 0, oldestPendingAgeMs: 0 }
      try { outboxStats = deps.outbox() } catch { /* the table may not exist yet */ }
      const outbox = { ok: !(outboxStats.oldestPendingAgeMs > outboxWarn), pending: outboxStats.pending, failed: outboxStats.failed, oldest_pending_age_s: Math.round(outboxStats.oldestPendingAgeMs / 1000) }
      if (!outbox.ok) reasons.push(`${outbox.pending} channel repl${outbox.pending === 1 ? "y is" : "ies are"} waiting to be delivered`)

      const progress = deps.runProgress()
      const runs = { active: progress.activeRuns, last_progress_age_s: progress.lastProgressAt === undefined ? null : Math.max(0, Math.round((now() - progress.lastProgressAt) / 1000)) }

      const status: HealthStatus = !database.ok ? "unhealthy" : reasons.length > 0 ? "degraded" : "ok"
      return {
        status,
        ok: status !== "unhealthy",
        coreHealthy: database.ok,
        gateway: "persistent-node-backend",
        backend_role: deps.gatewayRole,
        lifecycle_owner: deps.lifecycleOwner,
        pid: process.pid,
        uptime_s: Math.round((now() - startedAt) / 1000),
        checks: { database, event_loop: eventLoop, model: modelCheck, channels, outbox, runs, recovery: { state: deps.recovery?.() ?? null } },
        degraded_reasons: reasons,
      }
    },
  }
}
