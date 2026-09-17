import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createEnhancementRouter } from "./enhancement-router.js";
import { normalizeRuntimePaths } from "../paths.js";

interface TestJsonResponse {
  valid?: boolean;
  events?: unknown[];
  timings?: unknown[];
  status?: string;
  components?: unknown[];
  migrations?: unknown[];
  run?: {
    id: string;
    status: string;
    steps: Array<{ id: string; status?: string; evidence?: unknown[] }>;
  };
  schemaVersion?: number;
  job?: { id?: string; status?: string; progress?: number };
  jobs?: unknown[];
  receipt?: {
    id?: string;
    status?: string;
    approvalRequestId?: string;
    replayOf?: string;
    replayAllowed?: boolean;
  };
  preview?: { externalSideEffect?: boolean; previewHash?: string };
  approval?: { id?: string; status?: string; consumedAt?: string };
  outcome?: { status?: string; runId?: string; correlationId?: string };
  observability?: {
    recovery?: { retryCount?: number };
    approval?: { required?: boolean; replayAllowed?: boolean };
  };
  approval?: { required?: boolean; replayAllowed?: boolean };
  cancelled?: boolean;
  nextRunAt?: number | null;
  report?: { checks?: unknown[]; findings?: unknown[] };
  backup?: { entries: unknown[] };
  backups?: unknown[];
  watchdog?: { enabled?: boolean };
  safeMode?: {
    enabled: boolean;
    reasons: Array<{
      module: string;
      reason: string;
      severity: string;
      recommendation: string;
      createdAt: string;
    }>;
    updatedAt: string;
  };
}

async function withServer<T>(
  handler: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-enh-"));
  fs.mkdirSync(path.join(tempDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "config", "agent.yaml"),
    "agent:\n  name: Test\n",
    "utf-8",
  );
  const app = express();
  app.use(express.json());
  app.use(
    "/enhancements",
    createEnhancementRouter({ runtimePaths: normalizeRuntimePaths(tempDir) }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }
  try {
    return await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

async function jsonFetch(
  baseUrl: string,
  pathName: string,
  init?: RequestInit,
) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return {
    response,
    body: (await response.json()) as TestJsonResponse,
  };
}

describe("enhancement router", () => {
  it("validates config and exposes run, job, audit, and timing endpoints", async () => {
    await withServer(async (baseUrl) => {
      const validation = await jsonFetch(
        baseUrl,
        "/enhancements/config/validate",
        {
          method: "POST",
          body: JSON.stringify({ concurrency: { maxConcurrentTasks: 2 } }),
        },
      );
      expect(validation.response.status).toBe(200);
      expect(validation.body.valid).toBe(true);

      const run = await jsonFetch(baseUrl, "/enhancements/agent/runs", {
        method: "POST",
        body: JSON.stringify({ objective: "verify enhancements" }),
      });
      expect(run.response.status).toBe(201);
      expect(run.body.run.steps.length).toBeGreaterThan(0);

      const patchedRun = await jsonFetch(
        baseUrl,
        `/enhancements/agent/runs/${run.body.run.id}/steps/${run.body.run.steps[0].id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "running",
            evidence: {
              kind: "manual",
              summary: "dashboard selected the first step",
              ok: true,
            },
          }),
        },
      );
      expect(patchedRun.response.status).toBe(200);
      expect(patchedRun.body.run.status).toBe("running");

      const evidenceRun = await jsonFetch(
        baseUrl,
        `/enhancements/agent/runs/${run.body.run.id}/evidence`,
        {
          method: "POST",
          body: JSON.stringify({
            stepId: run.body.run.steps[0].id,
            kind: "command",
            summary: "test command completed",
            ok: true,
            data: { api_key: ["sk", "test-secret-value-1234567890"].join("-") },
          }),
        },
      );
      expect(evidenceRun.response.status).toBe(201);
      expect(evidenceRun.body.run.steps[0].evidence.length).toBe(2);

      const exportedRun = await jsonFetch(
        baseUrl,
        `/enhancements/agent/runs/${run.body.run.id}/export`,
      );
      expect(exportedRun.response.status).toBe(200);
      expect(exportedRun.body.schemaVersion).toBe(2);
      expect(JSON.stringify(exportedRun.body)).not.toContain(
        ["sk", "test-secret-value-1234567890"].join("-"),
      );

      const jobs = await jsonFetch(baseUrl, "/enhancements/runtime/jobs", {
        method: "POST",
        body: JSON.stringify({
          type: "agent.run",
          payload: { objective: "verify enhancements" },
        }),
      });
      expect(jobs.response.status).toBe(202);
      expect(jobs.body.job.status).toBe("queued");

      const progress = await jsonFetch(
        baseUrl,
        `/enhancements/runtime/jobs/${jobs.body.job.id}/progress`,
        {
          method: "PATCH",
          body: JSON.stringify({ progress: 42 }),
        },
      );
      expect(progress.response.status).toBe(200);
      expect(progress.body.job.progress).toBe(42);

      const cancelled = await jsonFetch(
        baseUrl,
        `/enhancements/runtime/jobs/${jobs.body.job.id}`,
        { method: "DELETE" },
      );
      expect(cancelled.response.status).toBe(200);
      expect(cancelled.body.cancelled).toBe(true);

      const retried = await jsonFetch(
        baseUrl,
        `/enhancements/runtime/jobs/${jobs.body.job.id}/retry`,
        { method: "POST", body: JSON.stringify({ delayMs: 0 }) },
      );
      expect(retried.response.status).toBe(200);
      expect(retried.body.job.status).toBe("queued");

      const deadLetters = await jsonFetch(
        baseUrl,
        "/enhancements/runtime/jobs/dead-letter",
      );
      expect(deadLetters.response.status).toBe(200);
      expect(Array.isArray(deadLetters.body.jobs)).toBe(true);

      const schedule = await jsonFetch(
        baseUrl,
        "/enhancements/runtime/scheduled-tasks/validate",
        {
          method: "POST",
          body: JSON.stringify({
            cronExpression: "every 5 minutes",
            fromTime: 1_000,
          }),
        },
      );
      expect(schedule.response.status).toBe(200);
      expect(schedule.body.valid).toBe(true);
      expect(schedule.body.nextRunAt).toBe(301_000);

      const audit = await jsonFetch(
        baseUrl,
        "/enhancements/observability/audit",
      );
      expect(audit.response.status).toBe(200);
      expect(Array.isArray(audit.body.events)).toBe(true);

      const pluginAuditWrite = await jsonFetch(
        baseUrl,
        "/enhancements/observability/audit",
        {
          method: "POST",
          body: JSON.stringify({
            type: "plugin.execute",
            actor: "test",
            subject: "plugin:tools:review",
            details: { action: "succeeded" },
          }),
        },
      );
      expect(pluginAuditWrite.response.status).toBe(201);

      const pluginAudit = await jsonFetch(
        baseUrl,
        "/enhancements/observability/audit?type=plugin.execute",
      );
      expect(pluginAudit.response.status).toBe(200);
      expect(pluginAudit.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "plugin.execute" }),
        ]),
      );

      const perf = await jsonFetch(
        baseUrl,
        "/enhancements/runtime/performance",
      );
      expect(perf.response.status).toBe(200);
      expect(Array.isArray(perf.body.timings)).toBe(true);
    });
  });

  it("deduplicates inbound events by the Idempotency-Key header", async () => {
    await withServer(async (baseUrl) => {
      const payload = {
        channel: "webhook",
        senderId: "sender-1",
        sessionId: "session-1",
        text: "deduplicate me",
      };
      const headers = {
        "content-type": "application/json",
        "idempotency-key": "enhancement-router-idempotency-1",
      };
      const first = await jsonFetch(baseUrl, "/enhancements/events/inbound", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const second = await jsonFetch(baseUrl, "/enhancements/events/inbound", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      expect(first.response.status).toBe(202);
      expect(second.response.status).toBe(202);
      expect(first.body.job?.id).toBe(second.body.job?.id);
    });
  });

  it("rejects invalid agent run and evidence payloads", async () => {
    await withServer(async (baseUrl) => {
      const blankObjective = await jsonFetch(
        baseUrl,
        "/enhancements/agent/runs",
        {
          method: "POST",
          body: JSON.stringify({ objective: "   " }),
        },
      );
      expect(blankObjective.response.status).toBe(400);

      const blankSteps = await jsonFetch(baseUrl, "/enhancements/agent/runs", {
        method: "POST",
        body: JSON.stringify({ objective: "valid", steps: ["  "] }),
      });
      expect(blankSteps.response.status).toBe(400);

      const run = await jsonFetch(baseUrl, "/enhancements/agent/runs", {
        method: "POST",
        body: JSON.stringify({ objective: "valid", steps: ["inspect"] }),
      });
      const invalidEvidence = await jsonFetch(
        baseUrl,
        `/enhancements/agent/runs/${run.body.run.id}/evidence`,
        {
          method: "POST",
          body: JSON.stringify({
            stepId: run.body.run.steps[0].id,
            kind: "manual",
            summary: "   ",
            ok: true,
          }),
        },
      );

      expect(invalidEvidence.response.status).toBe(400);
    });
  });

  it("blocks replay of approval-required jobs and exposes recovery observability", async () => {
    await withServer(async (baseUrl) => {
      const created = await jsonFetch(baseUrl, "/enhancements/runtime/jobs", {
        method: "POST",
        body: JSON.stringify({
          type: "channel.send",
          payload: { requiresApproval: true, action: "external_write" },
        }),
      });
      expect(created.response.status).toBe(202);
      const jobId = created.body.job?.id;
      expect(jobId).toEqual(expect.any(String));

      const cancelled = await jsonFetch(
        baseUrl,
        `/enhancements/runtime/jobs/${jobId}`,
        { method: "DELETE" },
      );
      expect(cancelled.body.cancelled).toBe(true);

      const blocked = await jsonFetch(
        baseUrl,
        `/enhancements/runtime/jobs/${jobId}/retry`,
        { method: "POST", body: JSON.stringify({ delayMs: 0 }) },
      );
      expect(blocked.response.status).toBe(409);
      expect(blocked.body.approval).toMatchObject({
        required: true,
        replayAllowed: false,
      });

      const inspected = await jsonFetch(
        baseUrl,
        `/enhancements/runtime/jobs/${jobId}`,
      );
      expect(inspected.response.status).toBe(200);
      expect(inspected.body.observability).toMatchObject({
        recovery: { retryCount: 0 },
        approval: { required: true, replayAllowed: false },
      });
    });
  });

  it("runs an approval-bound mock delivery without external side effects", async () => {
    await withServer(async (baseUrl) => {
      const created = await jsonFetch(
        baseUrl,
        "/enhancements/runtime/deliveries/mock",
        {
          method: "POST",
          body: JSON.stringify({
            runId: "run-mock",
            stepId: "step-publish",
            action: "publish",
            risk: "high",
            target: "site:synthetic",
            body: "synthetic content",
            channel: "webhook",
            destination: "mock://delivery",
            idempotencyKey: "mock-delivery-1",
            correlationId: "corr-mock-1",
            maxAttempts: 1,
          }),
        },
      );
      expect(created.response.status).toBe(201);
      expect(created.body.preview?.externalSideEffect).toBe(false);
      expect(created.body.preview?.previewHash).toEqual(expect.any(String));
      expect(created.body.receipt).toMatchObject({
        status: "waiting_approval",
      });
      const deliveryId = created.body.receipt?.id;
      expect(deliveryId).toEqual(expect.any(String));

      const inspected = await jsonFetch(
        baseUrl,
        `/enhancements/runtime/deliveries/${deliveryId}`,
      );
      expect(inspected.body.receipt).toMatchObject({
        id: deliveryId,
        status: "waiting_approval",
        approvalRequestId: created.body.approval?.id,
      });
      expect(inspected.body.replayEligible).toBe(false);

      const approved = await jsonFetch(
        baseUrl,
        `/enhancements/runtime/deliveries/${deliveryId}/approve`,
        {
          method: "POST",
          body: JSON.stringify({ decidedBy: "test-operator" }),
        },
      );
      expect(approved.response.status).toBe(200);
      expect(approved.body.receipt?.status).toBe("pending");
      expect(approved.body.approval?.consumedAt).toEqual(expect.any(String));

      const unknown = await jsonFetch(
        baseUrl,
        `/enhancements/runtime/deliveries/${deliveryId}/mock-dispatch`,
        {
          method: "POST",
          body: JSON.stringify({ outcome: "unknown_outcome" }),
        },
      );
      expect(unknown.response.status).toBe(200);
      expect(unknown.body.receipt?.status).toBe("unknown_outcome");
      expect(unknown.body.outcome).toMatchObject({
        status: "reconciliation_required",
        runId: "run-mock",
        correlationId: "corr-mock-1",
      });

      const replay = await jsonFetch(
        baseUrl,
        `/enhancements/runtime/deliveries/${deliveryId}/replay`,
        {
          method: "POST",
          body: JSON.stringify({ idempotencyKey: "mock-delivery-1-replay" }),
        },
      );
      expect(replay.response.status).toBe(409);
    });
  });

  it("exposes safety health, doctor, backup, migration, scan, and watchdog APIs", async () => {
    await withServer(async (baseUrl) => {
      const health = await jsonFetch(baseUrl, "/enhancements/health/full");
      expect(health.response.status).toBe(200);
      expect(health.body.status).toEqual(expect.any(String));
      expect(Array.isArray(health.body.components)).toBe(true);

      const doctor = await jsonFetch(baseUrl, "/enhancements/doctor/run", {
        method: "POST",
        body: JSON.stringify({
          includeExternalChecks: false,
          includeMigrations: true,
          includeSecretScan: true,
        }),
      });
      expect(doctor.response.status).toBe(200);
      expect(doctor.body.report.checks.length).toBeGreaterThan(0);

      const backup = await jsonFetch(baseUrl, "/enhancements/safety/backups", {
        method: "POST",
        body: JSON.stringify({ reason: "test" }),
      });
      expect(backup.response.status).toBe(201);
      expect(backup.body.backup.entries.length).toBeGreaterThan(0);

      const backups = await jsonFetch(baseUrl, "/enhancements/safety/backups");
      expect(backups.response.status).toBe(200);
      expect(backups.body.backups.length).toBeGreaterThan(0);

      const migrations = await jsonFetch(
        baseUrl,
        "/enhancements/safety/migrations",
      );
      expect(migrations.response.status).toBe(200);
      expect(Array.isArray(migrations.body.migrations)).toBe(true);

      const migrationRun = await jsonFetch(
        baseUrl,
        "/enhancements/safety/migrations/run",
        {
          method: "POST",
          body: JSON.stringify({ dryRun: true }),
        },
      );
      expect(migrationRun.response.status).toBe(200);
      expect(Array.isArray(migrationRun.body.migrations)).toBe(true);

      const scan = await jsonFetch(
        baseUrl,
        "/enhancements/safety/secret-scan",
        {
          method: "POST",
          body: JSON.stringify({ fix: false }),
        },
      );
      expect(scan.response.status).toBe(200);
      expect(Array.isArray(scan.body.report.findings)).toBe(true);

      const watchdog = await jsonFetch(
        baseUrl,
        "/enhancements/safety/watchdog",
      );
      expect(watchdog.response.status).toBe(200);
      expect(watchdog.body.watchdog.enabled).toBe(true);

      const rollbackValidation = await jsonFetch(
        baseUrl,
        "/enhancements/safety/rollback",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      expect(rollbackValidation.response.status).toBe(400);
    });
  }, 20_000);
});

describe("safe mode clear (#85)", () => {
  // SafeModeManager persists to <dataDir>/safe-mode.json (packages/core/src/
  // safety/safe-mode.ts). Seeding that file directly lets us start the
  // router already in a degraded state, mirroring what a real watchdog or
  // migration failure would have written via safeMode.enter(...).
  async function withSeededSafeMode<T>(
    reasons: Array<{
      module: string;
      reason: string;
      severity: "info" | "warning" | "critical";
      recommendation: string;
    }>,
    handler: (baseUrl: string) => Promise<T>,
  ): Promise<T> {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-enh-safemode-"),
    );
    fs.mkdirSync(path.join(tempDir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "config", "agent.yaml"),
      "agent:\n  name: Test\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "data", "safe-mode.json"),
      JSON.stringify({
        enabled: true,
        reasons: reasons.map((r) => ({
          ...r,
          createdAt: new Date().toISOString(),
        })),
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const app = express();
    app.use(express.json());
    app.use(
      "/enhancements",
      createEnhancementRouter({ runtimePaths: normalizeRuntimePaths(tempDir) }),
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind test server");
    }
    try {
      return await handler(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  it("reports safe mode enabled with its reasons, then clears it via POST /safety/safe-mode/clear", async () => {
    await withSeededSafeMode(
      [
        {
          module: "watchdog",
          reason: "core did not respond to health probes",
          severity: "critical",
          recommendation: "check core logs and restart the process",
        },
      ],
      async (baseUrl) => {
        const status = await jsonFetch(baseUrl, "/enhancements/health/full");
        expect(status.response.status).toBe(200);
        expect(status.body.safeMode?.enabled).toBe(true);
        expect(status.body.safeMode?.reasons).toHaveLength(1);

        const clear = await jsonFetch(
          baseUrl,
          "/enhancements/safety/safe-mode/clear",
          { method: "POST", body: JSON.stringify({}) },
        );
        expect(clear.response.status).toBe(200);
        expect(clear.body.safeMode?.enabled).toBe(false);
        expect(clear.body.safeMode?.reasons).toEqual([]);
      },
    );
  });

  it("clears only the named module's reasons, leaving other modules in safe mode", async () => {
    await withSeededSafeMode(
      [
        {
          module: "watchdog",
          reason: "core did not respond",
          severity: "critical",
          recommendation: "restart core",
        },
        {
          module: "migrations",
          reason: "schema migration failed",
          severity: "critical",
          recommendation: "review migration logs",
        },
      ],
      async (baseUrl) => {
        const clear = await jsonFetch(
          baseUrl,
          "/enhancements/safety/safe-mode/clear",
          { method: "POST", body: JSON.stringify({ module: "watchdog" }) },
        );
        expect(clear.response.status).toBe(200);
        expect(clear.body.safeMode?.enabled).toBe(true);
        expect(clear.body.safeMode?.reasons.map((r) => r.module)).toEqual([
          "migrations",
        ]);
      },
    );
  });
});
