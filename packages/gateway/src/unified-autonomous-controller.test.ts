import { createEventBus, setLifecycleBus } from "@miki/core/hooks"
import { UnifiedAutonomousController } from "./unified-autonomous-controller.js"

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

describe("UnifiedAutonomousController", () => {
  let bus: ReturnType<typeof createEventBus>

  beforeEach(() => {
    bus = createEventBus({ defaultTimeoutMs: 50 })
    setLifecycleBus(bus)
  })

  afterEach(() => {
    setLifecycleBus(null)
  })

  it("coordinates work wakeups and health sampling without starting learning on every idle tick", async () => {
    const wakeWork = vi.fn()
    const healthReport = vi.fn(() => ({ status: "degraded", ok: true, degraded_reasons: ["model server is not reachable"] }))
    const runLearningCycle = vi.fn(async () => ({ status: "completed" }))
    const controller = new UnifiedAutonomousController({
      getConfig: () => ({ autonomy: { enabled: true }, evolution: { enabled: true, cold_path_trigger: "after_turn" } }),
      wakeWork,
      autonomyContext: () => "Supervisor RUNNING; one active goal.",
      healthReport,
      runLearningCycle,
      log: vi.fn(),
      intervalMs: 60_000,
    })

    controller.start()
    await flush()
    expect(wakeWork).toHaveBeenCalled()
    expect(healthReport).toHaveBeenCalled()
    expect(runLearningCycle).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ running: true, lastHealth: { status: "degraded" }, lastAutonomyContext: "Supervisor RUNNING; one active goal." })

    await bus.emitAsync("learning:feedback", { session_key: "s1", rating: "down" })
    await flush()
    expect(runLearningCycle).toHaveBeenCalledTimes(1)
    expect(controller.status().lastLearningReason).toBe("learning:feedback")

    await controller.stop()
    expect(controller.status().running).toBe(false)
    expect(bus.listenerCount("learning:feedback")).toBe(0)
    expect(bus.listenerCount("message:sent")).toBe(0)
  })

  it("drives scheduled learning from startup/interval ticks and respects disabled autonomy", async () => {
    const wakeWork = vi.fn()
    const runLearningCycle = vi.fn(async () => ({ status: "not_due" }))
    const controller = new UnifiedAutonomousController({
      getConfig: () => ({ autonomy: { enabled: false }, evolution: { enabled: true, cold_path_trigger: "scheduled" } }),
      wakeWork,
      autonomyContext: () => "Supervisor STOPPED (disabled).",
      healthReport: () => ({ status: "ok", ok: true }),
      runLearningCycle,
      log: vi.fn(),
      intervalMs: 60_000,
    })

    controller.start()
    await flush()
    expect(wakeWork).not.toHaveBeenCalled()
    expect(runLearningCycle).toHaveBeenCalledTimes(1)
    expect(controller.status().lastLearningReason).toBe("startup")
    await controller.stop()
  })

  it("serializes overlapping ticks and stores failures without taking down the controller", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const wakeWork = vi.fn(() => undefined)
    const runLearningCycle = vi.fn(async () => { await pending; return { status: "completed" } })
    const controller = new UnifiedAutonomousController({
      getConfig: () => ({ autonomy: { enabled: true }, evolution: { enabled: true, cold_path_trigger: "scheduled" } }),
      wakeWork,
      autonomyContext: () => "Supervisor RUNNING.",
      healthReport: () => { throw new Error("health probe failed") },
      runLearningCycle,
      log: vi.fn(),
      intervalMs: 60_000,
    })

    controller.start()
    await flush()
    expect(controller.status().lastError).toContain("health probe failed")
    // A later tick must still run even after one subsystem reports an error.
    controller.wake("test_wake")
    await flush()
    expect(wakeWork).toHaveBeenCalledTimes(1)
    expect(runLearningCycle).toHaveBeenCalledTimes(1)
    release()
    await controller.stop()
    expect(controller.status().running).toBe(false)
  })
})
