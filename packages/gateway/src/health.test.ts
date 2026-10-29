import Database from "better-sqlite3"
import { createHealthMonitor, type HealthDeps } from "./health.js"

function build(overrides: Partial<HealthDeps> = {}) {
  const db = new Database(":memory:")
  const deps: HealthDeps = {
    db,
    probeModel: async () => ({ configured: true, reachable: true }),
    channels: () => [],
    outbox: () => ({ pending: 0, failed: 0, oldestPendingAgeMs: 0 }),
    runProgress: () => ({ activeRuns: 0 }),
    gatewayRole: "primary-node-gateway",
    lifecycleOwner: "launcher",
    ...overrides,
  }
  return { db, monitor: createHealthMonitor(deps) }
}

describe("gateway health", () => {
  it("is ok when the database, model, channels and outbox are fine", async () => {
    const { monitor } = build()
    await monitor.refreshModel()
    const report = monitor.report()
    expect(report).toMatchObject({ status: "ok", ok: true, coreHealthy: true })
    expect(report.degraded_reasons).toEqual([])
    expect(monitor.live()).toMatchObject({ status: "ok", ok: true })
  })

  it("is not falsely green: an unreachable model makes it degraded, not ok, and the gateway still answers ok:true", async () => {
    const { monitor } = build({ probeModel: async () => ({ configured: true, reachable: false, detail: "connect ECONNREFUSED" }) })
    await monitor.refreshModel()
    const report = monitor.report()
    expect(report.status).toBe("degraded")
    expect(report.ok).toBe(true) // restarting the gateway would not fix a model outage
    expect(report.degraded_reasons).toContain("model server is not reachable")
  })

  it("says loading for a local model server that is still starting", async () => {
    const { monitor } = build({ probeModel: async () => ({ configured: true, reachable: false, loading: true }) })
    await monitor.refreshModel()
    const report = monitor.report()
    expect(report.checks.model.loading).toBe(true)
    expect(report.degraded_reasons).toContain("model server is still loading")
  })

  it("reports a disconnected channel and a reply that has waited too long", async () => {
    const { monitor } = build({
      channels: () => [{ name: "telegram", enabled: true, configured: true, connected: false, lastError: "getUpdates failed" }, { name: "discord", enabled: false, configured: false, connected: false }],
      outbox: () => ({ pending: 2, failed: 0, oldestPendingAgeMs: 11 * 60_000 }),
    })
    await monitor.refreshModel()
    const report = monitor.report()
    expect(report.status).toBe("degraded")
    expect(report.checks.channels.items).toEqual([{ name: "telegram", connected: false, lastError: "getUpdates failed" }])
    expect(report.degraded_reasons).toEqual(expect.arrayContaining(["telegram channel is not connected", "2 channel replies are waiting to be delivered"]))
  })

  it("is unhealthy (HTTP 503 in the gateway) only when the database fails", async () => {
    const { monitor, db } = build()
    await monitor.refreshModel()
    db.close()
    const report = monitor.report()
    expect(report.status).toBe("unhealthy")
    expect(report.ok).toBe(false)
    expect(report.coreHealthy).toBe(false)
  })

  it("exposes how long ago a running task last made progress", async () => {
    let t = 1_000_000
    const { monitor } = build({ now: () => t, runProgress: () => ({ activeRuns: 1, lastProgressAt: t - 42_000 }) })
    await monitor.refreshModel()
    expect(monitor.report().checks.runs).toEqual({ active: 1, last_progress_age_s: 42 })
  })
})
