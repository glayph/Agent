import { CommandQueue } from "./command-queue.js";
import { resolveQueueMode } from "./resolve-mode.js";
import { DEFAULT_QUEUE_CONFIG, type QueueMode } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("resolveQueueMode", () => {
  it("priority: inline > session > surface > default", () => {
    const config = {
      ...DEFAULT_QUEUE_CONFIG,
      defaultMode: "followup" as QueueMode,
      surfaceModes: { cli: "collect" as QueueMode },
      sessionModes: { "cli:main:default": "interrupt" as QueueMode },
    };
    expect(
      resolveQueueMode(config, {
        session_key: "cli:main:default",
        surface: "cli",
        inlineMode: "steer",
      }),
    ).toBe("steer");
    expect(
      resolveQueueMode(config, {
        session_key: "cli:main:default",
        surface: "cli",
      }),
    ).toBe("interrupt");
    expect(
      resolveQueueMode(config, {
        session_key: "other",
        surface: "cli",
      }),
    ).toBe("collect");
    expect(
      resolveQueueMode(config, {
        session_key: "other",
        surface: "web",
      }),
    ).toBe("followup");
  });
});

describe("CommandQueue concurrency", () => {
  it("never runs two commands concurrently on the same session_key", async () => {
    const q = new CommandQueue({ defaultMode: "followup", steerFallback: "followup" });
    const order: string[] = [];
    const session = "cli:s1:default";

    await q.enqueue({
      session_key: session,
      message: "A",
      mode: "followup",
      execute: async ({ signal }) => {
        order.push("A-start");
        await sleep(40);
        if (signal.aborted) return;
        order.push("A-end");
      },
    });
    await q.enqueue({
      session_key: session,
      message: "B",
      mode: "followup",
      execute: async () => {
        order.push("B-start");
        order.push("B-end");
      },
    });

    await q.drain(session);
    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  it("runs different session_keys in parallel within lane cap", async () => {
    const q = new CommandQueue({
      defaultMode: "followup",
      lanes: { main: { concurrency: 4 }, subagent: { concurrency: 4 }, heartbeat: { concurrency: 2 } },
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const mk = (sk: string, label: string) =>
      q.enqueue({
        session_key: sk,
        message: label,
        mode: "followup",
        execute: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await sleep(30);
          concurrent--;
        },
      });

    await Promise.all([
      mk("cli:a:default", "A"),
      mk("cli:b:default", "B"),
      mk("cli:c:default", "C"),
    ]);
    await Promise.all([
      q.drain("cli:a:default"),
      q.drain("cli:b:default"),
      q.drain("cli:c:default"),
    ]);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });
});

describe("CommandQueue modes", () => {
  it("followup: B runs after A completes", async () => {
    const q = new CommandQueue({ defaultMode: "followup" });
    const session = "web:f1:default";
    const timeline: string[] = [];

    await q.enqueue({
      session_key: session,
      message: "A",
      mode: "followup",
      execute: async () => {
        timeline.push("A");
        await sleep(25);
      },
    });
    const rB = await q.enqueue({
      session_key: session,
      message: "B",
      mode: "followup",
      execute: async () => {
        timeline.push("B");
      },
    });
    expect(rB.accepted).toBe(true);
    expect(rB.command?.status).toBe("queued");
    await q.drain(session);
    expect(timeline).toEqual(["A", "B"]);
  });

  it("interrupt: aborts A then runs B", async () => {
    const q = new CommandQueue({ defaultMode: "followup" });
    const session = "web:i1:default";
    let aFinishedClean = false;
    let aSawAbort = false;

    await q.enqueue({
      session_key: session,
      message: "A",
      mode: "followup",
      execute: async ({ signal }) => {
        const start = Date.now();
        while (Date.now() - start < 500) {
          if (signal.aborted) {
            aSawAbort = true;
            return;
          }
          await sleep(10);
        }
        aFinishedClean = true;
      },
    });
    await sleep(15);
    const rB = await q.enqueue({
      session_key: session,
      message: "B",
      mode: "interrupt",
      execute: async () => {
        /* B runs */
      },
    });
    expect(rB.accepted).toBe(true);
    expect(rB.abortedRunId).toBeTruthy();
    await q.drain(session);
    expect(aSawAbort).toBe(true);
    expect(aFinishedClean).toBe(false);
    const cancelled = q.events().filter((e) => e.type === "cancelled");
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
  });

  it("collect: coalesces multiple messages into one turn", async () => {
    const q = new CommandQueue({
      defaultMode: "collect",
      collectDebounceMs: 50,
    });
    const session = "webhook:c1:default";
    const seen: string[] = [];

    await q.enqueue({
      session_key: session,
      message: "one",
      mode: "collect",
      execute: async ({ command }) => {
        seen.push(command.message);
      },
    });
    await q.enqueue({
      session_key: session,
      message: "two",
      mode: "collect",
      execute: async ({ command }) => {
        seen.push(command.message);
      },
    });
    await q.enqueue({
      session_key: session,
      message: "three",
      mode: "collect",
      execute: async ({ command }) => {
        seen.push(command.message);
      },
    });
    await sleep(120);
    await q.drain(session);
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("one");
    expect(seen[0]).toContain("two");
    expect(seen[0]).toContain("three");
  });

  it("steer with inject hook receives mid-run messages", async () => {
    const q = new CommandQueue({ defaultMode: "steer", steerFallback: "followup" });
    const session = "cli:st1:default";
    const injected: string[] = [];

    await q.enqueue({
      session_key: session,
      message: "A",
      mode: "steer",
      execute: async ({ onSteerInject, signal }) => {
        onSteerInject?.((msgs) => {
          injected.push(...msgs);
        });
        await sleep(60);
        if (signal.aborted) return;
      },
    });
    await sleep(10);
    const r = await q.enqueue({
      session_key: session,
      message: "steer-me",
      mode: "steer",
    });
    expect(r.accepted).toBe(true);
    await q.drain(session);
    expect(injected).toContain("steer-me");
    expect(q.events().some((e) => e.type === "steered")).toBe(true);
  });

  it("steer without inject falls back to followup", async () => {
    const q = new CommandQueue({ defaultMode: "steer", steerFallback: "followup" });
    const session = "cli:st2:default";
    const timeline: string[] = [];

    await q.enqueue({
      session_key: session,
      message: "A",
      mode: "steer",
      execute: async () => {
        timeline.push("A");
        await sleep(40);
      },
    });
    await q.enqueue({
      session_key: session,
      message: "B",
      mode: "steer",
      execute: async () => {
        timeline.push("B");
      },
    });
    await q.drain(session);
    expect(timeline).toEqual(["A", "B"]);
  });
});

describe("CommandQueue drop policy", () => {
  it("reject_new when session queue is full", async () => {
    const q = new CommandQueue({
      defaultMode: "followup",
      maxQueuePerSession: 2,
      dropPolicy: "reject_new",
    });
    const session = "api:d1:default";
    // Hold active
    await q.enqueue({
      session_key: session,
      message: "active",
      mode: "followup",
      execute: async () => sleep(80),
    });
    await q.enqueue({ session_key: session, message: "p1", mode: "followup" });
    await q.enqueue({ session_key: session, message: "p2", mode: "followup" });
    const rejected = await q.enqueue({
      session_key: session,
      message: "p3",
      mode: "followup",
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toMatch(/full/);
    expect(q.events().some((e) => e.type === "dropped")).toBe(true);
    await q.drain(session);
  });

  it("drop_oldest when configured", async () => {
    const q = new CommandQueue({
      defaultMode: "followup",
      maxQueuePerSession: 1,
      dropPolicy: "drop_oldest",
    });
    const session = "api:d2:default";
    await q.enqueue({
      session_key: session,
      message: "active",
      mode: "followup",
      execute: async () => sleep(60),
    });
    await q.enqueue({ session_key: session, message: "old", mode: "followup" });
    const newer = await q.enqueue({
      session_key: session,
      message: "new",
      mode: "followup",
    });
    expect(newer.accepted).toBe(true);
    expect(q.pendingCount(session)).toBe(1);
    await q.drain(session);
  });
});
