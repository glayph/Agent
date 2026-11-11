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
    expect(report.resources.process_rss_bytes).toBeGreaterThan(0)
    expect(report.resources.process_heap_used_bytes).toBeGreaterThan(0)
    expect(report.checks.model).toMatchObject({
      catalog_reachable: true,
      completion_reachable: null,
      completion_tested: false,
      entitlement_blocked: null,
      last_error_at: null,
    })
    expect(Number.isInteger(report.resources.process_active_resources)).toBe(true)
    expect(monitor.live()).toMatchObject({ status: "ok", ok: true })
  })

  it("includes shared resource-arbitration capacity, lease and waiter telemetry", async () => {
    const { monitor } = build({ resourceSnapshot: () => ({
      cpuCount: 4,
      loadPerCpu: 0.25,
      freeMemoryRatio: 0.6,
      sampledAt: "2026-01-01T00:00:00.000Z",
      activeLeases: 2,
      waiting: 1,
      byResource: [{ resource: "agent_execution", units: 2, capacity: 4 }],
    }) });
    await monitor.refreshModel();
    expect(monitor.report().resource_arbitration).toMatchObject({
      activeLeases: 2,
      waiting: 1,
      byResource: [{ resource: "agent_execution", units: 2, capacity: 4 }],
    });
  });

  it("does not interpret an unavailable platform load average as zero or as a pressure signal", async () => {
    const { monitor } = build({ resourceSnapshot: () => ({
      cpuCount: 8, loadPerCpu: 99, loadAvailable: false, freeMemoryRatio: 0.7, freeDiskRatio: 0.5,
      activeLeases: 0, waiting: 0, byResource: [],
    }) })
    await monitor.refreshModel()
    const report = monitor.report()
    expect(report.resource_pressure.reasons).not.toContain("host load is critically high")
    expect(report.status).toBe("ok")
  })

  it("reports host disk pressure and sustained resource starvation", async () => {
    const { monitor } = build({
      resourceWaitWarnMs: 30_000,
      resourceSnapshot: () => ({
        cpuCount: 4, loadPerCpu: 2.5, freeMemoryRatio: 0.04, freeMemoryBytes: 40, totalMemoryBytes: 1000,
        diskFreeBytes: 20, diskTotalBytes: 1000, freeDiskRatio: 0.02, sampledAt: "2026-01-01T00:00:00.000Z",
        activeLeases: 1, waiting: 2, oldestWaiterAgeMs: 45_000,
        byResource: [{ resource: "browser", units: 1, capacity: 1 }],
      }),
    })
    await monitor.refreshModel()
    const report = monitor.report()
    expect(report.status).toBe("degraded")
    expect(report.resource_pressure.ok).toBe(false)
    expect(report.resource_pressure.saturated_resources).toEqual(["browser"])
    expect(report.resource_pressure.oldest_waiter_age_s).toBe(45)
    expect(report.degraded_reasons).toEqual(expect.arrayContaining([
      "host memory is critically low", "data volume disk space is critically low", "host load is critically high",
      "resource waiters are experiencing sustained capacity starvation",
    ]))
    expect(report.resources.process_cpu_percent_of_one_core === null || report.resources.process_cpu_percent_of_one_core >= 0).toBe(true)
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

  it("exposes run progress and queue state without imposing an execution deadline", async () => {
    const t = 1_000_000
    const { monitor } = build({ now: () => t, runProgress: () => ({
      activeRuns: 1, lastProgressAt: t - 42_000, queuedMessages: 3, oldestQueuedAgeMs: 15_000,
      conversationLanes: 2, activeLanes: 1, waitingLaneEntries: 3,
      oldestActiveLaneAgeMs: 24_000, oldestLaneWaitAgeMs: 12_000,
    }) })
    await monitor.refreshModel()
    expect(monitor.report().checks.runs).toEqual({
      active: 1, last_progress_age_s: 42, queued_messages: 3, oldest_queued_age_s: 15,
      conversation_lanes: 2, active_lanes: 1, waiting_lane_entries: 3,
      oldest_active_lane_age_s: 24, oldest_lane_wait_age_s: 12,
    })
  })
})
