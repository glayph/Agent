import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CommandQueue } from "../command-queue/index.js";
import {
  CronScheduler,
  computeNextRunAt,
  cron_add,
  cron_list,
  cron_remove,
  cron_run,
  setDefaultCronScheduler,
} from "./index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("computeNextRunAt", () => {
  it("parses one-shot future ISO", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const next = computeNextRunAt({ kind: "once", expr: future });
    expect(next).toBeGreaterThan(Date.now());
  });

  it("returns null for past one-shot", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(computeNextRunAt({ kind: "once", expr: past })).toBeNull();
  });

  it("supports every N seconds", () => {
    const from = Date.now();
    const next = computeNextRunAt(
      { kind: "cron", expr: "every 5 seconds" },
      from,
    );
    expect(next).toBe(from + 5000);
  });
});

describe("CronScheduler persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-cron-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    setDefaultCronScheduler(null);
  });

  it("survives process restart (reload from disk)", () => {
    const a = new CronScheduler({ stateDir: dir, log: () => {} });
    const job = a.add({
      name: "nightly",
      schedule: { kind: "cron", expr: "@daily" },
      payload: "run report",
    });
    expect(a.list()).toHaveLength(1);

    // New instance = process restart
    const b = new CronScheduler({ stateDir: dir, log: () => {} });
    const listed = b.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(job.id);
    expect(listed[0]!.name).toBe("nightly");
  });

  it("delete_after_run removes one-shot after run", async () => {
    const q = new CommandQueue({ defaultMode: "followup" });
    const s = new CronScheduler({
      stateDir: dir,
      commandQueue: q,
      log: () => {},
    });
    const job = s.add({
      name: "once",
      schedule: {
        kind: "once",
        expr: new Date(Date.now() + 3600_000).toISOString(),
      },
      payload: "one shot",
      deleteAfterRun: true,
    });
    const result = await s.run(job.id);
    expect(result.accepted).toBe(true);
    expect(result.deleted).toBe(true);
    expect(s.list()).toHaveLength(0);
  });

  it("isolated job does not touch main session state", async () => {
    const q = new CommandQueue({ defaultMode: "followup" });
    const mainSession = "cli:user:default";
    const mainLog: string[] = [];

    await q.enqueue({
      session_key: mainSession,
      message: "main work",
      lane: "main",
      mode: "followup",
      execute: async ({ signal }) => {
        mainLog.push("start");
        for (let i = 0; i < 8; i++) {
          if (signal.aborted) {
            mainLog.push("aborted");
            return;
          }
          await sleep(15);
        }
        mainLog.push("end");
      },
    });
    await sleep(10);

    const s = new CronScheduler({
      stateDir: dir,
      commandQueue: q,
      log: () => {},
    });
    const job = s.add({
      name: "iso",
      schedule: {
        kind: "once",
        expr: new Date(Date.now() + 3600_000).toISOString(),
      },
      payload: "isolated work",
      executionStyle: "isolated",
      deleteAfterRun: true,
    });
    await s.run(job.id);
    await q.drain(mainSession);
    expect(mainLog).toEqual(["start", "end"]);
  });

  it("cron_list / cron_run / cron_remove API", async () => {
    const s = new CronScheduler({ stateDir: dir, log: () => {} });
    setDefaultCronScheduler(s);
    const job = cron_add({
      name: "api-job",
      schedule: { kind: "cron", expr: "every 30 minutes" },
      payload: "ping",
    });
    expect(cron_list().some((j) => j.id === job.id)).toBe(true);
    const run = await cron_run(job.id);
    expect(run.accepted).toBe(true);
    expect(cron_remove(job.id)).toBe(true);
    expect(cron_list()).toHaveLength(0);
  });
});
