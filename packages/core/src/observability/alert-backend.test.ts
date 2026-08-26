import { describe, expect, test, vi } from "vitest";
import { AlertBackend } from "./alert-backend.js";
import type { ResourceAlert } from "./resource-monitor.js";

const alert: ResourceAlert = {
  code: "rss_threshold",
  severity: "warning",
  message: "Process RSS exceeded the warning threshold.",
  snapshot: {
    timestamp: "2026-08-26T00:00:00.000Z",
    uptimeSeconds: 10,
    rssBytes: 600,
    heapUsedBytes: 300,
    heapTotalBytes: 400,
    externalBytes: 10,
    arrayBuffersBytes: 0,
    openFileDescriptors: 12,
    activeResources: 2,
  },
  threshold: 500,
  dedupeKey: "rss_threshold",
};

describe("AlertBackend", () => {
  test("requires HTTPS webhook URLs", () => {
    expect(
      () => new AlertBackend({ webhookUrl: "http://alerts.example.test" }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new AlertBackend({
          webhookUrl: "https://alerts.example.test/hook?token=secret",
        }),
    ).toThrow(/query parameters/);
  });

  test("does not call a webhook when it is not configured", async () => {
    const fetchImpl = vi.fn();
    await new AlertBackend({ fetchImpl }).notify(alert);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("delivers a bounded, authenticated JSON alert", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const backend = new AlertBackend({
      webhookUrl: "https://alerts.example.test/hook",
      webhookToken: "test-only-token",
      fetchImpl,
      minIntervalMs: 0,
    });

    await backend.notify(alert);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer test-only-token",
    );
    expect(String(init.body)).toContain('"source":"agent-miki"');
    expect(String(init.body)).not.toContain("test-only-token");
  });

  test("retries transient webhook failures at most maxAttempts times", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response(null, { status: 503 });
      return new Response(null, { status: 204 });
    });
    const backend = new AlertBackend({
      webhookUrl: "https://alerts.example.test/hook",
      fetchImpl,
      maxAttempts: 3,
      minIntervalMs: 0,
    });

    await backend.notify(alert);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("suppresses duplicate alert delivery within the configured interval", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const backend = new AlertBackend({
      webhookUrl: "https://alerts.example.test/hook",
      fetchImpl,
      minIntervalMs: 60_000,
      now: () => 1000,
    });

    await backend.notify(alert);
    await backend.notify(alert);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
