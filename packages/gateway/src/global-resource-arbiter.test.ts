import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { GlobalResourceArbiter } from "./global-resource-arbiter.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("GlobalResourceArbiter", () => {
  it("admits only one owner for an exclusive cross-process resource", async () => {
    const db = new Database(":memory:");
    const arbiter = new GlobalResourceArbiter(db, { pollMs: 10 });
    const first = await arbiter.acquire("process-a/run-a", [{ resource: "browser" }]);
    let secondAcquired = false;
    const secondPromise = arbiter.acquire("process-b/run-b", [{ resource: "browser" }], { timeoutMs: 1_000 }).then((lease) => {
      secondAcquired = true;
      return lease;
    });
    await wait(30);
    expect(secondAcquired).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(second.ownerId).toBe("process-b/run-b");
    second.release();
    expect(arbiter.snapshot()).toMatchObject({ activeLeases: 0, waiting: 0 });
    db.close();
  });

  it("waits for a resource without an arbitrary deadline when timeoutMs is zero", async () => {
    const db = new Database(":memory:");
    const arbiter = new GlobalResourceArbiter(db, { pollMs: 5 });
    const holder = await arbiter.acquire("holder", [{ resource: "long-tool" }]);
    let acquired = false;
    const pending = arbiter.acquire("waiter", [{ resource: "long-tool" }], { timeoutMs: 0 }).then((lease) => {
      acquired = true;
      return lease;
    });
    await wait(30);
    expect(acquired).toBe(false);
    holder.release();
    const lease = await pending;
    expect(acquired).toBe(true);
    lease.release();
    db.close();
  });

  it("expires abandoned waiters while renewing live unlimited waiters", async () => {
    const db = new Database(":memory:");
    const arbiter = new GlobalResourceArbiter(db, { pollMs: 5, leaseMs: 5_000 });
    const holder = await arbiter.acquire("holder", [{ resource: "browser" }]);
    const pending = arbiter.acquire("abandoned", [{ resource: "browser" }], { timeoutMs: 0 });
    await wait(20);
    const row = db.prepare("SELECT waiter_id FROM miki_global_resource_waiters WHERE owner_id='abandoned'").get() as { waiter_id: string };
    expect(row.waiter_id).toBeTruthy();
    // Simulate a worker that died: its liveness lease expires and the waiter
    // must be removed instead of blocking the FIFO queue forever.
    db.prepare("UPDATE miki_global_resource_waiters SET expires_at='2000-01-01T00:00:00.000Z' WHERE waiter_id=?").run(row.waiter_id);
    await expect(pending).rejects.toThrow("lost its liveness lease");
    expect(arbiter.snapshot().waiting).toBe(0);
    holder.release();
    db.close();
  });

  it("reports the age of the oldest live waiter for starvation monitoring", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z")
    const db = new Database(":memory:")
    const arbiter = new GlobalResourceArbiter(db, { pollMs: 5, leaseMs: 5_000, now: () => new Date(nowMs).toISOString() })
    const holder = await arbiter.acquire("holder", [{ resource: "browser" }])
    const pending = arbiter.acquire("waiter", [{ resource: "browser" }], { timeoutMs: 0 })
    await wait(20)
    nowMs += 2_000
    expect(arbiter.snapshot()).toMatchObject({ waiting: 1, oldestWaiterAgeMs: 2_000 })
    holder.release()
    const lease = await pending
    lease.release()
    db.close()
  })

  it("allows a later foreground waiter to outrank a background waiter", async () => {
    const db = new Database(":memory:");
    const arbiter = new GlobalResourceArbiter(db, { pollMs: 5 });
    const first = await arbiter.acquire("holder", [{ resource: "shared_interactive" }]);
    const order: string[] = [];
    const background = arbiter.acquire("background", [{ resource: "shared_interactive" }], { priority: 10 }).then((lease) => {
      order.push("background");
      return lease;
    });
    await wait(10);
    const foreground = arbiter.acquire("foreground", [{ resource: "shared_interactive" }], { priority: 100 }).then((lease) => {
      order.push("foreground");
      return lease;
    });
    await wait(10);
    first.release();
    const foregroundLease = await foreground;
    expect(order).toEqual(["foreground"]);
    foregroundLease.release();
    const backgroundLease = await background;
    expect(order).toEqual(["foreground", "background"]);
    backgroundLease.release();
    db.close();
  });

  it("preserves insertion order for equal-priority waiters with identical timestamps", async () => {
    const db = new Database(":memory:");
    const arbiter = new GlobalResourceArbiter(db, { pollMs: 5, now: () => "2026-01-01T00:00:00.000Z" });
    const holder = await arbiter.acquire("holder", [{ resource: "browser" }]);
    const order: string[] = [];
    const first = arbiter.acquire("first", [{ resource: "browser" }]).then((lease) => { order.push("first"); return lease; });
    const second = arbiter.acquire("second", [{ resource: "browser" }]).then((lease) => { order.push("second"); return lease; });
    await wait(10);
    holder.release();
    const firstLease = await first;
    firstLease.release();
    const secondLease = await second;
    secondLease.release();
    expect(order).toEqual(["first", "second"]);
    db.close();
  });

  it("acquires multiple resources atomically and does not deadlock on order", async () => {
    const db = new Database(":memory:");
    const arbiter = new GlobalResourceArbiter(db, { pollMs: 5 });
    const browser = await arbiter.acquire("browser-owner", [{ resource: "browser" }]);
    const pending = arbiter.acquire("mixed-owner", [{ resource: "computer" }, { resource: "browser" }], { timeoutMs: 500 });
    await wait(20);
    expect(arbiter.snapshot().byResource).toEqual([{ resource: "browser", units: 1, capacity: 1 }]);
    browser.release();
    const mixed = await pending;
    expect(arbiter.snapshot().byResource).toHaveLength(2);
    mixed.release();
    db.close();
  });

  it("shares updated resource capacities across arbiter instances", async () => {
    const db = new Database(":memory:");
    const first = new GlobalResourceArbiter(db, { capacities: { agent_execution: 4 } });
    const second = new GlobalResourceArbiter(db, { capacities: { agent_execution: 2 } });
    first.setCapacity("agent_execution", 1);
    await expect(second.acquire("too-many", [{ resource: "agent_execution", units: 2 }]))
      .rejects.toThrow("exceeds capacity 1");
    db.close();
  });

  it("removes aborted waiters and rejects over-capacity requests", async () => {
    const db = new Database(":memory:");
    const arbiter = new GlobalResourceArbiter(db, { pollMs: 5 });
    const held = await arbiter.acquire("held", [{ resource: "browser" }]);
    const controller = new AbortController();
    const pending = arbiter.acquire("cancelled", [{ resource: "browser" }], { signal: controller.signal });
    controller.abort(new Error("cancelled by run"));
    await expect(pending).rejects.toThrow("cancelled by run");
    await expect(arbiter.acquire("too-many", [{ resource: "browser", units: 2 }])).rejects.toThrow("exceeds capacity");
    expect(arbiter.snapshot().waiting).toBe(0);
    held.release();
    db.close();
  });

  it("ages long-waiting resource requests so fixed priority cannot starve them forever", async () => {
    const db = new Database(":memory:");
    const fixedNow = "2026-01-01T00:00:00.000Z";
    const arbiter = new GlobalResourceArbiter(db, { pollMs: 5, now: () => fixedNow });
    const holder = await arbiter.acquire("holder", [{ resource: "shared_interactive" }]);
    const order: string[] = [];
    const lowPriorityOld = arbiter.acquire("old-low", [{ resource: "shared_interactive" }], { priority: -50 })
      .then((lease) => { order.push("old-low"); return lease; });
    await wait(10);
    const oldWaiter = db.prepare("SELECT waiter_id FROM miki_global_resource_waiters WHERE owner_id='old-low'").get() as { waiter_id: string };
    const agedAt = new Date(Date.parse(fixedNow) - 2_000 * 60_000).toISOString();
    db.prepare("UPDATE miki_global_resource_waiters SET requested_at=? WHERE waiter_id=?").run(agedAt, oldWaiter.waiter_id);
    const highPriorityNew = arbiter.acquire("new-high", [{ resource: "shared_interactive" }], { priority: 50 })
      .then((lease) => { order.push("new-high"); return lease; });
    await wait(10);
    holder.release();
    const firstLease = await lowPriorityOld;
    expect(order).toEqual(["old-low"]);
    firstLease.release();
    const secondLease = await highPriorityNew;
    expect(order).toEqual(["old-low", "new-high"]);
    secondLease.release();
    db.close();
  });

});
