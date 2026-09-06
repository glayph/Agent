import { LRUCache, MultiLayerCache } from "./cache-manager";

describe("cache-manager optimizations", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("treats falsey cached values as cache hits", async () => {
    const cache = new MultiLayerCache<string, unknown>();

    await cache.set("zero", 0, 1_000);
    await cache.set("false", false, 1_000);
    await cache.set("empty", "", 1_000);

    await expect(cache.get("zero")).resolves.toBe(0);
    await expect(cache.get("false")).resolves.toBe(false);
    await expect(cache.get("empty")).resolves.toBe("");
    expect(cache.getStats().misses).toBe(0);
  });

  it("expires l1 and l2 entries consistently", async () => {
    const cache = new MultiLayerCache<string, unknown>();

    await cache.set("key", "value", 50);
    expect(await cache.get("key")).toBe("value");

    jest.advanceTimersByTime(51);

    await expect(cache.get("key")).resolves.toBeUndefined();
    expect(cache.getStats().misses).toBe(1);
  });

  it("does not revalidate fresh entries", async () => {
    const cache = new MultiLayerCache<string, unknown>();
    const compute = jest.fn(async () => "fresh");

    await cache.set("key", "cached", 1_000);
    await expect(cache.getWithRevalidate("key", compute, 1_000)).resolves.toBe(
      "cached",
    );
    jest.runOnlyPendingTimers();

    expect(compute).not.toHaveBeenCalled();
  });

  it("allows lru size tuning", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    cache.setMaxSize(2);

    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });
});
