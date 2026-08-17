import { HeartbeatEngine, type IOrchestrator } from "./heartbeat.js";

/**
 * Minimal IOrchestrator double. Only what a single quiescent pulse touches
 * needs to actually do something; everything else is a type-satisfying
 * stub. `_lastUserInteraction` is set to "now" inside the constructor, so
 * the self-improvement branch (only entered when idle > 5 minutes) is not
 * exercised by a single immediate pulse - selfImprovement below is never
 * actually invoked, just present to satisfy the interface.
 */
function makeOrchestrator(): IOrchestrator {
  return {
    runtimePaths: {} as IOrchestrator["runtimePaths"],
    modelName: "test-model",
    concurrentManager: {
      maxConcurrent: 3,
      setMaxConcurrent: jest.fn(),
    } as unknown as IOrchestrator["concurrentManager"],
    selfImprovement: {
      _reflectionDue: () => false,
      _tuningDue: () => false,
      _optimizationDue: () => false,
      runReflectionCycle: async () => undefined,
      runPromptTuningCycle: async () => undefined,
      runOptimizationCycle: async () => undefined,
      getAccumulatedTunings: () => [],
    },
    skillGovernance: {
      selfPlanner: { getActivePlan: () => null },
    },
    _callLlmApi: async () => ({ choices: [] }),
    _executeToolAndYield: async function* () {},
  };
}

describe("HeartbeatEngine interval units (#106)", () => {
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    setTimeoutSpy = jest.spyOn(global, "setTimeout");
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  /**
   * Returns the delay (ms) passed to the first setTimeout call made after
   * `start()` - that's always the engine's own sleep-between-pulses call:
   * `_pulse()` does not schedule any timers itself, only `_sleep()` does.
   */
  async function firstSleepDelayMs(engine: HeartbeatEngine): Promise<number> {
    await engine.start();
    // Flush the microtask queue so the async _loop -> _pulse -> _sleep
    // chain reaches its setTimeout call before we inspect the spy.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(setTimeoutSpy).toHaveBeenCalled();
    const [, delay] = setTimeoutSpy.mock.calls[0]!;
    await engine.stop();
    return delay as number;
  }

  it("treats the constructor interval as seconds: 1800s -> sleeps 1,800,000ms (30 minutes)", async () => {
    // The exact value that flows through the real end-to-end chain for a
    // user-configured "30 minutes" heartbeat interval: UI (30) -> *60 in
    // config-page.tsx -> persisted/loaded as heartbeat.interval_seconds
    // = 1800 -> passed here as the constructor's `interval` argument.
    // Before #106 was fixed, this value would have reached _sleep()
    // unconverted (1800ms - an 1800x-too-fast hot loop) instead of the
    // correct 1,800,000ms.
    const engine = new HeartbeatEngine(makeOrchestrator(), 1800, {});
    const delay = await firstSleepDelayMs(engine);
    expect(delay).toBe(1_800_000);
  });

  it("treats a small interval as seconds too: 45s -> sleeps 45,000ms", async () => {
    const engine = new HeartbeatEngine(makeOrchestrator(), 45, {});
    const delay = await firstSleepDelayMs(engine);
    expect(delay).toBe(45_000);
  });

  it("defaults to 300 seconds -> sleeps 300,000ms when no interval is given", async () => {
    const engine = new HeartbeatEngine(makeOrchestrator());
    const delay = await firstSleepDelayMs(engine);
    expect(delay).toBe(300_000);
  });
});
