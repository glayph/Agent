import { createKeyedLane } from "./session-lane.js";

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

  it("a stuck holder cannot block the next one beyond the wait cap", async () => {
    const lane = createKeyedLane();
    await lane.acquire("stuck"); // never released
    const started = Date.now();
    const release = await lane.acquire("stuck", { maxWaitMs: 40 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    release();
  });

  it("counts waiting holders", async () => {
    const lane = createKeyedLane();
    const first = await lane.acquire("q");
    const second = lane.acquire("q");
    expect(lane.pending("q")).toBe(2);
    first();
    (await second)();
    expect(lane.pending("q")).toBe(0);
  });
});
