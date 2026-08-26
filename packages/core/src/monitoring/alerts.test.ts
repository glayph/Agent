import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateHealthAlerts, OperationalAlertSink } from "./alerts.js";

describe("operational alerts", () => {
  it("writes redacted alerts and suppresses duplicate codes during cooldown", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-alerts-"));
    const filePath = path.join(root, "alerts.jsonl");
    const sink = new OperationalAlertSink({ filePath, cooldownMs: 60_000 });

    const first = await sink.emit(
      "critical",
      "provider.unavailable",
      "Provider down",
      {
        apiKey: "do-not-write",
        provider: "test",
      },
    );
    const second = await sink.emit(
      "critical",
      "provider.unavailable",
      "Provider down",
      {
        provider: "test",
      },
    );

    expect(first.emitted).toBe(true);
    expect(second.emitted).toBe(false);
    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain("[redacted]");
    expect(raw).not.toContain("do-not-write");
  });

  it("emits health, memory, disk and dead-letter alerts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-alerts-health-"));
    const sink = new OperationalAlertSink({
      filePath: path.join(root, "alerts.jsonl"),
      cooldownMs: 0,
    });
    const alerts = await evaluateHealthAlerts(sink, {
      status: "degraded",
      memoryPercentage: 95,
      diskPercentage: 96,
      deadLetterJobs: 2,
      providerReady: false,
    });

    expect(alerts.map((item) => item.code)).toEqual([
      "health.degraded",
      "memory.high",
      "disk.high",
      "jobs.dead_letter",
      "provider.unavailable",
    ]);
  });
});
