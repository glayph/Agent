import { createKeyedLane, LaneWaitAbortedError, LaneWaitTimeoutError } from "./session-lane.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("createKeyedLane", () => {
  it("runs holders of the same key strictly in arrival order", async () => {
    const lane = createKeyedLane();
    const order: string[] = [];
    const job = async (name: string, ms: number) => {
      const release = await lane.acquire("chat-1");
      order.push(`start:${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`end:${name}`);
      release();
    };
    await Promise.all([job("a", 30), job("b", 1), job("c", 1)]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("does not make different keys wait for each other", async () => {
    const lane = createKeyedLane();
    const releaseA = await lane.acquire("a");
    const releaseB = await Promise.race([lane.acquire("b"), tick().then(() => undefined)]);
    expect(releaseB).toBeInstanceOf(Function);
    releaseA();
    (releaseB as () => void)();
  });

  it("release is idempotent and cleans up the key", async () => {
    const lane = createKeyedLane();
    const release = await lane.acquire("k");
    expect(lane.pending("k")).toBe(1);
    release();
    release();
    expect(lane.pending("k")).toBe(0);
    const again = await lane.acquire("k");
    again();
  });

  it("rejects a waiter that reaches the cap instead of allowing concurrent entry", async () => {
    const lane = createKeyedLane();
    await lane.acquire("stuck"); // never released
    const started = Date.now();
    const attempt = lane.acquire("stuck", { maxWaitMs: 40 });
    await expect(attempt).rejects.toBeInstanceOf(LaneWaitTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(lane.pending("stuck")).toBe(1);
  });

  it("waits without a deadline when maxWaitMs is zero", async () => {
    const lane = createKeyedLane();
    const releaseFirst = await lane.acquire("unbounded");
    let entered = false;
    const second = lane.acquire("unbounded", { maxWaitMs: 0 }).then((release) => {
      entered = true;
      return release;
    });
    await tick();
    expect(entered).toBe(false);
    releaseFirst();
    const releaseSecond = await second;
    expect(entered).toBe(true);
    releaseSecond();
  });

  it("counts active and waiting holders without applying a task deadline", async () => {
    const lane = createKeyedLane();
    const first = await lane.acquire("q");
    const second = lane.acquire("q");
    expect(lane.pending("q")).toBe(2);
    expect(lane.snapshot()).toMatchObject({ conversations: 1, active: 1, waiting: 1, total: 2 });
    expect(lane.snapshot().oldestActiveAgeMs).toBeGreaterThanOrEqual(0);
    expect(lane.snapshot().oldestWaitingAgeMs).toBeGreaterThanOrEqual(0);
    first();
    (await second)();
    expect(lane.pending("q")).toBe(0);
    expect(lane.snapshot()).toMatchObject({ conversations: 0, active: 0, waiting: 0, total: 0, oldestActiveAgeMs: 0, oldestWaitingAgeMs: 0 });
  });

  it("cancels a queued waiter without releasing or corrupting the active holder", async () => {
    const lane = createKeyedLane();
    const first = await lane.acquire("q");
    const controller = new AbortController();
    const second = lane.acquire("q", { signal: controller.signal });
    let thirdEntered = false;
    const third = lane.acquire("q").then((release) => { thirdEntered = true; return release; });
    expect(lane.snapshot()).toMatchObject({ conversations: 1, active: 1, waiting: 2, total: 3 });
    controller.abort();
    await expect(second).rejects.toBeInstanceOf(LaneWaitAbortedError);
    await tick();
    expect(thirdEntered).toBe(false);
    expect(lane.snapshot()).toMatchObject({ conversations: 1, active: 1, waiting: 1, total: 2 });
    first();
    (await third)();
    expect(lane.snapshot()).toMatchObject({ conversations: 0, active: 0, waiting: 0, total: 0, oldestActiveAgeMs: 0, oldestWaitingAgeMs: 0 });
  });

  it("rejects an already-aborted waiter without adding a ghost queue entry", async () => {
    const lane = createKeyedLane();
    const controller = new AbortController();
    controller.abort();
    await expect(lane.acquire("q", { signal: controller.signal })).rejects.toBeInstanceOf(LaneWaitAbortedError);
    expect(lane.snapshot()).toMatchObject({ conversations: 0, active: 0, waiting: 0, total: 0, oldestActiveAgeMs: 0, oldestWaitingAgeMs: 0 });
  });
});
