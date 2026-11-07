import { RunResourceLock, RunScopedSerialExecutor, usesSharedInteractiveResource } from "./run-resource-lock.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("interactive resource policy", () => {
  it("does not lock the stateful desktop for immutable capability metadata", () => {
    expect(usesSharedInteractiveResource("computer_capabilities")).toBe(false);
    expect(usesSharedInteractiveResource("computer_observe")).toBe(true);
    expect(usesSharedInteractiveResource("computer_click_at")).toBe(true);
    expect(usesSharedInteractiveResource("browser_navigate")).toBe(true);
  });
});

describe("RunResourceLock", () => {
  it("keeps a multi-step resource reservation exclusive and releases in FIFO order", async () => {
    const lock = new RunResourceLock();
    const firstRelease = await lock.acquire("run-a");
    const order: string[] = [];
    const second = lock.acquire("run-b").then((release) => { order.push("b"); return release; });
    const third = lock.acquire("run-c").then((release) => { order.push("c"); return release; });
    await wait(5);
    expect(order).toEqual([]);
    firstRelease();
    const secondRelease = await second;
    expect(order).toEqual(["b"]);
    secondRelease();
    const thirdRelease = await third;
    expect(order).toEqual(["b", "c"]);
    thirdRelease();
    expect(lock.currentOwner).toBeUndefined();
  });

  it("allows an owner to re-enter without deadlocking itself", async () => {
    const lock = new RunResourceLock();
    const release = await lock.acquire("same-run");
    const nestedRelease = await lock.acquire("same-run");
    nestedRelease();
    expect(lock.currentOwner).toBe("same-run");
    release();
    expect(lock.currentOwner).toBeUndefined();
  });

  it("removes an aborted waiter without disturbing the current owner", async () => {
    const lock = new RunResourceLock();
    const release = await lock.acquire("owner");
    const controller = new AbortController();
    const pending = lock.acquire("cancelled", { signal: controller.signal });
    controller.abort(new Error("run cancelled"));
    await expect(pending).rejects.toThrow("run cancelled");
    expect(lock.queued).toBe(0);
    expect(lock.currentOwner).toBe("owner");
    release();
  });

  it("times out a waiter and lets the next queued run acquire the resource", async () => {
    const lock = new RunResourceLock();
    const release = await lock.acquire("owner");
    const timedOut = lock.acquire("slow", { timeoutMs: 5 });
    const next = lock.acquire("next", { timeoutMs: 100 });
    await expect(timedOut).rejects.toThrow("Timed out waiting 5ms");
    release();
    const releaseNext = await next;
    expect(lock.currentOwner).toBe("next");
    releaseNext();
  });

  it("waits without a deadline when timeoutMs is zero and remains cancellable", async () => {
    const lock = new RunResourceLock();
    const releaseOwner = await lock.acquire("owner");
    const controller = new AbortController();
    const waiting = lock.acquire("long-running-goal", { timeoutMs: 0, signal: controller.signal });
    await wait(10);
    expect(lock.currentOwner).toBe("owner");
    expect(lock.queued).toBe(1);
    releaseOwner();
    const releaseWaiter = await waiting;
    expect(lock.currentOwner).toBe("long-running-goal");
    releaseWaiter();
    expect(lock.currentOwner).toBeUndefined();
  });
});


describe("RunScopedSerialExecutor", () => {
  it("serializes UI actions inside one run while allowing different runs to proceed", async () => {
    const executor = new RunScopedSerialExecutor();
    const controller = new AbortController();
    const events: string[] = [];
    let finishFirst!: () => void;
    const gate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const first = executor.run("run-a", controller.signal, async () => {
      events.push("a1:start");
      await gate;
      events.push("a1:end");
    });
    const second = executor.run("run-a", controller.signal, async () => { events.push("a2"); });
    await executor.run("run-b", controller.signal, async () => { events.push("b1"); });
    expect(events).toEqual(["a1:start", "b1"]);
    finishFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1:start", "b1", "a1:end", "a2"]);
  });

  it("cancels a queued action without blocking the next action", async () => {
    const executor = new RunScopedSerialExecutor();
    const firstController = new AbortController();
    const queuedController = new AbortController();
    let finishFirst!: () => void;
    const gate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const first = executor.run("run", firstController.signal, async () => gate);
    const cancelled = executor.run("run", queuedController.signal, async () => "must not execute");
    queuedController.abort(new Error("cancel queued action"));
    await expect(cancelled).rejects.toThrow("cancel queued action");
    finishFirst();
    await first;
    const next = await executor.run("run", new AbortController().signal, async () => "ok");
    expect(next).toBe("ok");
  });
});
