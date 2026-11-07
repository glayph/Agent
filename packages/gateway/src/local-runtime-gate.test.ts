import { createLocalRuntimeGate } from "./local-runtime-gate.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("createLocalRuntimeGate", () => {
  it("does not wait when no transition is pending", async () => {
    const gate = createLocalRuntimeGate({ getPending: () => undefined, usesManagedLocalModel: () => true, maxWaitMs: 1000 });
    await expect(gate()).resolves.toBeUndefined();
  });

  it("lets a run on a remote model start while a local transition is pending", async () => {
    const transition = deferred();
    const gate = createLocalRuntimeGate({ getPending: () => transition.promise, usesManagedLocalModel: () => false, maxWaitMs: 60_000 });
    // Must settle although the transition never resolves.
    await expect(Promise.race([gate("cloud-model"), new Promise((r) => setTimeout(() => r("blocked"), 100))])).resolves.toBeUndefined();
  });

  it("holds a run that uses the local model until the transition completes", async () => {
    const transition = deferred();
    let pending: Promise<void> | undefined = transition.promise;
    const gate = createLocalRuntimeGate({ getPending: () => pending, usesManagedLocalModel: () => true, maxWaitMs: 60_000 });
    let started = false;
    const waiting = gate("local-model").then(() => { started = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toBe(false);
    pending = undefined;
    transition.resolve();
    await waiting;
    expect(started).toBe(true);
  });

  it("gives up after the bounded wait instead of hanging forever", async () => {
    const never = new Promise<void>(() => {});
    const logs: string[] = [];
    const gate = createLocalRuntimeGate({ getPending: () => never, usesManagedLocalModel: () => true, maxWaitMs: 40, log: (m) => logs.push(m) });
    const startedAt = Date.now();
    await gate("local-model");
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(logs.join(" ")).toMatch(/starting the run without waiting longer/);
  });

  it("does not fail the run when the transition itself failed", async () => {
    const failed = Promise.reject(new Error("llama failed to start"));
    failed.catch(() => undefined);
    let pending: Promise<void> | undefined = failed;
    const gate = createLocalRuntimeGate({ getPending: () => pending, usesManagedLocalModel: () => true, maxWaitMs: 1000 });
    const waiting = gate("local-model");
    pending = undefined;
    await expect(waiting).resolves.toBeUndefined();
  });
});
