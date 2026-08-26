import { SessionTurnLock } from "../src/session-turn-lock.js";

describe("SessionTurnLock", () => {
  it("lets a single caller through immediately", async () => {
    const lock = new SessionTurnLock();
    expect(lock.isLocked("s1")).toBe(false);
    const release = await lock.acquire("s1");
    expect(lock.isLocked("s1")).toBe(true);
    release();
    expect(lock.isLocked("s1")).toBe(false);
  });

  it("serializes two turns for the same session in call order", async () => {
    const lock = new SessionTurnLock();
    const events: string[] = [];

    const turn = async (name: string, delayMs: number) => {
      const release = await lock.acquire("shared");
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, delayMs));
      events.push(`${name}:end`);
      release();
    };

    // Start "first" and, once it has definitely acquired the lock, start
    // "second" - "second" must not begin until "first" fully finishes,
    // even though "first" is still mid-flight (simulates a scheduled task
    // running long while a channel message comes in for the same session).
    const firstPromise = turn("first", 20);
    await new Promise((r) => setTimeout(r, 5)); // let "first" acquire
    const secondPromise = turn("second", 1);

    await Promise.all([firstPromise, secondPromise]);

    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("never interleaves more than one holder for the same session", async () => {
    const lock = new SessionTurnLock();
    let concurrent = 0;
    let maxConcurrent = 0;

    const turn = async () => {
      const release = await lock.acquire("shared");
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      release();
    };

    await Promise.all([turn(), turn(), turn(), turn(), turn()]);
    expect(maxConcurrent).toBe(1);
  });

  it("does not block unrelated sessions from running concurrently", async () => {
    const lock = new SessionTurnLock();
    const order: string[] = [];

    const turn = async (session: string, delayMs: number) => {
      const release = await lock.acquire(session);
      order.push(`${session}:start`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`${session}:end`);
      release();
    };

    // "slow" session A takes much longer than session B; B must not be
    // held up waiting for A since they're different sessions.
    await Promise.all([turn("a", 30), turn("b", 1)]);

    expect(order.indexOf("b:end")).toBeLessThan(order.indexOf("a:end"));
  });

  it("releases the lock even if the wrapped function throws", async () => {
    const lock = new SessionTurnLock();
    await expect(
      lock.withLock("s1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lock.isLocked("s1")).toBe(false);

    // A subsequent caller must be able to acquire immediately.
    const release = await lock.acquire("s1");
    expect(lock.isLocked("s1")).toBe(true);
    release();
  });

  it("reports waitingCount for queued callers", async () => {
    const lock = new SessionTurnLock();
    const release = await lock.acquire("s1");
    expect(lock.waitingCount("s1")).toBe(0);

    const p1 = lock.acquire("s1");
    const p2 = lock.acquire("s1");
    expect(lock.waitingCount("s1")).toBe(2);

    release();
    const release1 = await p1;
    expect(lock.waitingCount("s1")).toBe(1);
    release1();
    const release2 = await p2;
    expect(lock.waitingCount("s1")).toBe(0);
    release2();
  });
});
