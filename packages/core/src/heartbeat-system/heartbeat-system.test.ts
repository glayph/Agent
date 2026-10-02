import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CommandQueue } from "../command-queue/index.js";
import {
  defaultClassify,
  isInQuietHours,
  parseChecklistMarkdown,
  parseTimeToMinutes,
  HeartbeatRunner,
  HeartbeatScheduler,
  runHeartbeatNow,
} from "./index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("quiet_hours", () => {
  it("parses HH:MM", () => {
    expect(parseTimeToMinutes("22:30")).toBe(22 * 60 + 30);
    expect(parseTimeToMinutes("7:05")).toBe(7 * 60 + 5);
    expect(parseTimeToMinutes("bad")).toBeNull();
  });

  it("detects daytime quiet window", () => {
    // 09:00–17:00 quiet; test at 10:00 local by constructing a date
    const at = new Date();
    at.setHours(10, 0, 0, 0);
    expect(
      isInQuietHours({ start: "09:00", end: "17:00" }, at),
    ).toBe(true);
    at.setHours(8, 0, 0, 0);
    expect(
      isInQuietHours({ start: "09:00", end: "17:00" }, at),
    ).toBe(false);
  });

  it("detects overnight quiet window", () => {
    const at = new Date();
    at.setHours(23, 0, 0, 0);
    expect(
      isInQuietHours({ start: "22:00", end: "07:00" }, at),
    ).toBe(true);
    at.setHours(8, 0, 0, 0);
    expect(
      isInQuietHours({ start: "22:00", end: "07:00" }, at),
    ).toBe(false);
  });
});

describe("checklist parser", () => {
  it("parses list items and skips comments", () => {
    const md = `# Heartbeat
# comment
- [notify] Check stuck tasks
* [tool] Run health probe
1. [memory] Log daily status
plain no-op line

`;
    const items = parseChecklistMarkdown(md);
    expect(items).toHaveLength(4);
    expect(defaultClassify(items[0]!)).toBe("proactive_notify");
    expect(defaultClassify(items[1]!)).toBe("silent_tool_run");
    expect(defaultClassify(items[2]!)).toBe("memory_update");
    expect(defaultClassify(items[3]!)).toBe("no_op");
  });
});

describe("HeartbeatRunner", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-hb-"));
    const identity = path.join(dir, "identity");
    fs.mkdirSync(identity, { recursive: true });
    fs.writeFileSync(
      path.join(identity, "HEARTBEAT.md"),
      `# Checks
- [notify] Stuck tasks in queue
- [memory] Note cycle ran
- plain check
`,
      "utf8",
    );
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("dry_run reports without side effects", async () => {
    const notifications: string[] = [];
    const memories: string[] = [];
    const runner = new HeartbeatRunner({
      workspaceRoot: dir,
      config: { enabled: true, intervalSeconds: 60 },
      hooks: {
        notify: (m) => {
          notifications.push(m);
        },
        memoryUpdate: (m) => {
          memories.push(m);
        },
      },
    });
    const result = await runHeartbeatNow(runner, true);
    expect(result.dryRun).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(result.items.length).toBe(3);
    expect(result.report).toMatch(/dry_run/);
    expect(notifications).toHaveLength(0);
    expect(memories).toHaveLength(0);
  });

  it("executes notify and memory hooks when not dry_run", async () => {
    const notifications: string[] = [];
    const memories: string[] = [];
    const runner = new HeartbeatRunner({
      workspaceRoot: dir,
      hooks: {
        notify: (m) => {
          notifications.push(m);
        },
        memoryUpdate: (m) => {
          memories.push(m);
        },
      },
    });
    const result = await runner.runNow(false);
    expect(result.suppressed).toBe(false);
    expect(notifications.some((n) => n.includes("Stuck"))).toBe(true);
    expect(memories.length).toBeGreaterThanOrEqual(1);
  });

  it("suppresses during quiet_hours", async () => {
    const atHour = new Date().getHours();
    const start = `${String(atHour).padStart(2, "0")}:00`;
    const endHour = (atHour + 2) % 24;
    const end = `${String(endHour).padStart(2, "0")}:00`;
    const runner = new HeartbeatRunner({
      workspaceRoot: dir,
      config: {
        quietHours: { start, end },
      },
    });
    const result = await runner.runNow(false);
    expect(result.suppressed).toBe(true);
    expect(result.suppressReason).toBe("quiet_hours");
  });

  it("does not affect main-lane task when heartbeat fires", async () => {
    const queue = new CommandQueue({
      defaultMode: "followup",
      lanes: {
        main: { concurrency: 4 },
        subagent: { concurrency: 2 },
        heartbeat: { concurrency: 2 },
      },
    });
    const mainSession = "cli:user:default";
    const mainLog: string[] = [];

    // Start long main-lane task
    await queue.enqueue({
      session_key: mainSession,
      message: "main-work",
      lane: "main",
      mode: "followup",
      execute: async ({ signal }) => {
        mainLog.push("main-start");
        for (let i = 0; i < 10; i++) {
          if (signal.aborted) {
            mainLog.push("main-aborted");
            return;
          }
          await sleep(20);
        }
        mainLog.push("main-end");
      },
    });

    await sleep(15);
    expect(queue.isActive(mainSession)).toBe(true);

    const runner = new HeartbeatRunner({
      workspaceRoot: dir,
      commandQueue: queue,
      hooks: {
        isMainLaneBusy: () => queue.isActive(mainSession),
      },
      config: { skipWhenMainBusy: false }, // still must not interrupt
    });

    // Fire heartbeat while main is running
    const hb = await runner.runNow(false);
    expect(hb.suppressed).toBe(false);

    await queue.drain(mainSession);
    // Main must complete untouched
    expect(mainLog).toEqual(["main-start", "main-end"]);
    expect(mainLog).not.toContain("main-aborted");
  });

  it("skipWhenMainBusy suppresses cycle", async () => {
    const runner = new HeartbeatRunner({
      workspaceRoot: dir,
      config: { skipWhenMainBusy: true },
      hooks: { isMainLaneBusy: () => true },
    });
    const result = await runner.runNow(false);
    expect(result.suppressed).toBe(true);
    expect(result.suppressReason).toBe("main_lane_busy");
  });
});

describe("HeartbeatScheduler", () => {
  it("fires on interval and logs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-hbs-"));
    fs.mkdirSync(path.join(dir, "identity"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "identity", "HEARTBEAT.md"),
      "- [noop] tick\n",
      "utf8",
    );
    const logs: string[] = [];
    const runner = new HeartbeatRunner({
      workspaceRoot: dir,
      config: { intervalSeconds: 1, enabled: true },
      hooks: {
        log: (m) => {
          logs.push(m);
        },
      },
    });
    const sched = new HeartbeatScheduler(runner, {
      log: (m) => {
        logs.push(m);
      },
    });
    sched.start();
    expect(sched.isRunning()).toBe(true);
    // Force a tick instead of waiting full interval
    const result = await sched.tick();
    expect(result.suppressed).toBe(false);
    expect(logs.some((l) => l.includes("tick") || l.includes("cycle"))).toBe(
      true,
    );
    sched.stop();
    expect(sched.isRunning()).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
