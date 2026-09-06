import {
  ToolConcurrencyMetrics,
  ToolResourceLockManager,
  createToolExecutionPlan,
  getToolConcurrencyPolicy,
  locksConflict,
  mapWithConcurrencyLimit,
  resolveParallelToolCallLimit,
} from "./tool-call-parallelism.js";

describe("tool call parallelism", () => {
  it("plans independent read-only tools in the same execution level", () => {
    const plan = createToolExecutionPlan([
      { toolName: "file_read", toolArgs: { path: "a.txt" } },
      { toolName: "file_read", toolArgs: { path: "b.txt" } },
      { toolName: "direct_download_search", toolArgs: { query: "x" } },
    ]);

    expect(plan.levels).toHaveLength(1);
    expect(plan.levels[0].parallel).toBe(true);
    expect(
      plan.levels[0].items.map((item) => item.invocation.toolName),
    ).toEqual(["file_read", "file_read", "direct_download_search"]);
  });

  it("orders conflicting read/write operations by resource dependency", () => {
    const plan = createToolExecutionPlan([
      { toolName: "file_write", toolArgs: { path: "a.txt", content: "x" } },
      { toolName: "file_read", toolArgs: { path: "a.txt" } },
      { toolName: "file_read", toolArgs: { path: "b.txt" } },
    ]);

    expect(plan.levels).toHaveLength(2);
    expect(plan.levels[0].items.map((item) => item.index)).toEqual([0, 2]);
    expect(plan.levels[1].items.map((item) => item.index)).toEqual([1]);
  });

  it("serializes shared-browser tools without blocking unrelated reads", () => {
    const plan = createToolExecutionPlan([
      { toolName: "browser_navigate", toolArgs: { url: "https://a.test" } },
      { toolName: "browser_extract", toolArgs: {} },
      { toolName: "file_read", toolArgs: { path: "notes.md" } },
    ]);

    expect(plan.levels).toHaveLength(2);
    expect(plan.levels[0].items.map((item) => item.index)).toEqual([0, 2]);
    expect(plan.levels[1].items.map((item) => item.index)).toEqual([1]);
  });

  it("derives lock conflicts from policy metadata", () => {
    const write = getToolConcurrencyPolicy("file_write", {
      path: "same.txt",
    });
    const readSame = getToolConcurrencyPolicy("file_read", {
      path: "same.txt",
    });
    const readOther = getToolConcurrencyPolicy("file_read", {
      path: "other.txt",
    });

    expect(locksConflict(write.locks, readSame.locks)).toBe(true);
    expect(locksConflict(write.locks, readOther.locks)).toBe(false);
  });

  it("limits concurrent work while preserving result order", async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapWithConcurrencyLimit(
      [30, 10, 20, 5],
      2,
      async (delayMs, index) => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return `${index}:${delayMs}`;
        } finally {
          active--;
        }
      },
    );

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results).toEqual(["0:30", "1:10", "2:20", "3:5"]);
  });

  it("stress-runs many independent calls under a bounded parallel cap", async () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    let active = 0;
    let maxActive = 0;

    const results = await mapWithConcurrencyLimit(items, 5, async (index) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return index * 2;
      } finally {
        active--;
      }
    });

    expect(maxActive).toBeLessThanOrEqual(5);
    expect(results).toEqual(items.map((index) => index * 2));
  });

  it("allows shared lock holders and queues exclusive waiters", async () => {
    const locks = new ToolResourceLockManager(1_000);
    const sharedA = await locks.acquireMany([
      { key: "file:a", mode: "shared" },
    ]);
    const sharedB = await locks.acquireMany([
      { key: "file:a", mode: "shared" },
    ]);
    let exclusiveAcquired = false;

    const exclusive = locks
      .acquireMany([{ key: "file:a", mode: "exclusive" }])
      .then((release) => {
        exclusiveAcquired = true;
        return release;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exclusiveAcquired).toBe(false);

    sharedA.release();
    sharedB.release();
    const exclusiveRelease = await exclusive;
    expect(exclusiveAcquired).toBe(true);
    exclusiveRelease.release();
  });

  it("times out queued lock acquisition", async () => {
    const locks = new ToolResourceLockManager(10);
    const held = await locks.acquireMany([
      { key: "browser:default", mode: "exclusive" },
    ]);

    await expect(
      locks.acquireMany([{ key: "browser:default", mode: "exclusive" }]),
    ).rejects.toThrow("Tool resource lock timeout");

    held.release();
  });

  it("records planning, execution, retry, and lock metrics", () => {
    const metrics = new ToolConcurrencyMetrics();
    const plan = createToolExecutionPlan([
      { toolName: "file_read", toolArgs: { path: "a" } },
      { toolName: "file_read", toolArgs: { path: "b" } },
    ]);

    metrics.recordPlan(plan);
    metrics.beginInvocation();
    metrics.beginInvocation();
    metrics.recordRetry();
    metrics.recordLockWait(25);
    metrics.endInvocation(true);
    metrics.endInvocation(false);

    expect(metrics.snapshot()).toMatchObject({
      plannedInvocations: 2,
      plannedLevels: 1,
      parallelLevels: 1,
      maxObservedParallel: 2,
      completedInvocations: 1,
      failedInvocations: 1,
      retriedInvocations: 1,
      totalLockWaitMs: 25,
    });
  });

  it("clamps invalid parallel limits to a safe positive value", () => {
    expect(resolveParallelToolCallLimit(0, 3)).toBe(1);
    expect(resolveParallelToolCallLimit(101, 3)).toBe(100);
    expect(resolveParallelToolCallLimit(undefined, 4)).toBe(4);
  });
});
