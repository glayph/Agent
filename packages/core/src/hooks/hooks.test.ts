import {
  createEventBus,
  getLifecycleBus,
  setLifecycleBus,
  LIFECYCLE_EVENTS,
  type EventBus,
} from "./index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("EventBus isolation", () => {
  it("exception in one handler does not stop others or throw to caller", async () => {
    const bus = createEventBus({ defaultTimeoutMs: 500, log: () => {} });
    const seen: string[] = [];
    bus.on("session:start", () => {
      seen.push("a");
    });
    bus.on("session:start", () => {
      throw new Error("boom");
    });
    bus.on("session:start", () => {
      seen.push("c");
    });
    const result = await bus.emitAsync("session:start", {
      session_key: "s1",
    });
    expect(seen).toEqual(["a", "c"]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toMatch(/boom/);
    expect(result.blocked).toBe(false);
  });

  it("timeout does not hang the bus", async () => {
    const bus = createEventBus({ defaultTimeoutMs: 30, log: () => {} });
    bus.on("message:received", async () => {
      await sleep(200);
    });
    const t0 = Date.now();
    const result = await bus.emitAsync("message:received", { text: "x" });
    expect(Date.now() - t0).toBeLessThan(150);
    expect(result.errors.some((e) => /timeout/i.test(e.message))).toBe(true);
  });
});

describe("EventBus order", () => {
  it("runs higher priority first, then registration order", async () => {
    const bus = createEventBus({ log: () => {} });
    const order: number[] = [];
    bus.on("tool:before_call", () => {
      order.push(1);
    }, { priority: 0 });
    bus.on("tool:before_call", () => {
      order.push(2);
    }, { priority: 10 });
    bus.on("tool:before_call", () => {
      order.push(3);
    }, { priority: 10 });
    bus.on("tool:before_call", () => {
      order.push(4);
    }, { priority: -5 });
    await bus.emitAsync("tool:before_call", { toolName: "shell" });
    // priority 10 (reg order 2 then 3), priority 0 (1), priority -5 (4)
    expect(order).toEqual([2, 3, 1, 4]);
  });
});

describe("EventBus block", () => {
  it("aggregates block from tool:before_call", async () => {
    const bus = createEventBus({ log: () => {} });
    bus.on("tool:before_call", () => ({ block: true, reason: "needs approval" }), {
      priority: 100,
    });
    const result = await bus.emitAsync("tool:before_call", {
      toolName: "rm",
    });
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toMatch(/approval/);
  });
});

describe("lifecycle event catalog", () => {
  it("can fire every listed event with a logging hook", async () => {
    const bus = createEventBus({ log: () => {} });
    const fired: string[] = [];
    for (const name of LIFECYCLE_EVENTS) {
      bus.on(name, () => {
        fired.push(name);
      });
    }
    for (const name of LIFECYCLE_EVENTS) {
      await bus.emitAsync(name, { session_key: "test", toolName: "t", agentId: "a" });
    }
    expect(fired.sort()).toEqual([...LIFECYCLE_EVENTS].sort());
    expect(fired).toHaveLength(LIFECYCLE_EVENTS.length);
  });
});

describe("global bus", () => {
  afterEach(() => {
    setLifecycleBus(null);
  });

  it("getLifecycleBus returns singleton", () => {
    setLifecycleBus(null);
    const a = getLifecycleBus();
    const b = getLifecycleBus();
    expect(a).toBe(b);
  });
});
