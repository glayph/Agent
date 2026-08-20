import { Router, type Request, type Response } from "express";
import * as path from "path";
import {
  validateRuntimeConfig,
  type ConfigValidationResult,
} from "@miki/config";
import { SqliteAuditLog, type AuditEventType } from "../audit-log.js";
import {
  AgentRunRecorder,
  SqliteAgentRunStore,
  exportAgentRunBundle,
  isTaskGraphStepStatus,
  isVerificationEvidenceKind,
  type AgentRunStepPatch,
  type VerificationEvidence,
} from "../agent-run.js";
import { PersistentJobQueue } from "../persistent-job-queue.js";
import { PersistentJobRunner } from "../persistent-job-runner.js";
import { DeliveryQueue } from "../delivery-queue.js";
import {
  createDefaultChannelRegistry,
  type ChannelName,
} from "../event-envelope.js";
import { WatcherRegistry } from "../watcher-registry.js";
import { PersistentTimerScheduler } from "../timer-scheduler.js";
import { globalStartupTimer } from "../performance-budgets.js";
import { createBackupManager } from "../safety/backup.js";
import { runDoctor } from "../safety/doctor.js";
import {
  buildHealthComponents,
  summarizeFullHealth,
} from "../safety/full-health.js";
import { createMigrationManager } from "../safety/migrations.js";
import { createSafeModeManager } from "../safety/safe-mode.js";
import { type RuntimePaths } from "../paths.js";
import { scanSecrets } from "../safety/secret-scan.js";
import { Watchdog } from "../safety/watchdog.js";
import { parseCronToNextRun } from "../scheduler.js";

interface EnhancementRouterOptions {
  runtimePaths: RuntimePaths;
  /** Shared queue used by both HTTP enqueue routes and the persistent worker. */
  jobQueue?: PersistentJobQueue;
  /** Optional worker status source for the runtime dashboard. */
  jobRunner?: PersistentJobRunner;
  /** @deprecated */
  workspaceDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getLimit(req: Request, fallback = 100): number {
  const raw = Number(req.query["limit"]);
  return Number.isFinite(raw) ? Math.max(1, Math.min(500, raw)) : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendJsonError(res: Response, err: unknown, status = 500): void {
  res.status(status).json({ error: errorMessage(err) });
}

const AUDIT_EVENT_TYPES = new Set<AuditEventType>([
  "auth.login",
  "auth.logout",
  "config.update",
  "secret.write",
  "secret.delete",
  "model.change",
  "tool.execute",
  "plugin.execute",
  "plugin.channel_runtime",
  "channel.message",
  "agent.run",
  "system.event",
]);

function asAuditEventType(value: unknown): AuditEventType | undefined {
  return typeof value === "string" &&
    AUDIT_EVENT_TYPES.has(value as AuditEventType)
    ? (value as AuditEventType)
    : undefined;
}

function validationSummary(result: ConfigValidationResult) {
  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
  };
}

function recordJobLifecycle(
  audit: SqliteAuditLog,
  action: string,
  details: Record<string, unknown>,
): void {
  audit.record({
    type: "system.event",
    actor: "runtime.jobs",
    subject: action,
    details: { action, ...details },
  });
}

function parseEvidence(value: unknown): VerificationEvidence | null {
  if (!isRecord(value)) return null;
  if (
    !isVerificationEvidenceKind(value.kind) ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    typeof value.ok !== "boolean"
  ) {
    return null;
  }
  return {
    kind: value.kind,
    summary: value.summary,
    ok: value.ok,
    source:
      typeof value.source === "string"
        ? (value.source as VerificationEvidence["source"])
        : undefined,
    phase:
      typeof value.phase === "string"
        ? (value.phase as VerificationEvidence["phase"])
        : undefined,
    capturedAt:
      typeof value.capturedAt === "string" ? value.capturedAt : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
    modelCall: isRecord(value.modelCall)
      ? (value.modelCall as VerificationEvidence["modelCall"])
      : undefined,
    toolCall: isRecord(value.toolCall)
      ? (value.toolCall as unknown as VerificationEvidence["toolCall"])
      : undefined,
    permission: isRecord(value.permission)
      ? (value.permission as unknown as VerificationEvidence["permission"])
      : undefined,
    data: isRecord(value.data) ? value.data : undefined,
  };
}

export function createEnhancementRouter({
  runtimePaths,
  jobQueue,
  jobRunner,
}: EnhancementRouterOptions): Router {
  const router = Router();
  const audit = new SqliteAuditLog(path.join(runtimePaths.dataDir, "audit.db"));
  const runRecorder = new AgentRunRecorder(
    new SqliteAgentRunStore(path.join(runtimePaths.dataDir, "agent-runs.db")),
  );
  const jobs =
    jobQueue ??
    new PersistentJobQueue(
      path.join(runtimePaths.dataDir, "runtime-jobs.json"),
    );
  const channels = createDefaultChannelRegistry();
  const deliveries = new DeliveryQueue(
    path.join(runtimePaths.dataDir, "delivery-receipts.json"),
  );
  const watchers = new WatcherRegistry(
    path.join(runtimePaths.dataDir, "watcher-state.json"),
  );
  const timers = new PersistentTimerScheduler(
    path.join(runtimePaths.dataDir, "timers.json"),
    jobs,
  );
  timers.start();
  const backups = createBackupManager(runtimePaths);
  const migrations = createMigrationManager(runtimePaths);
  const safeMode = createSafeModeManager(runtimePaths);
  const watchdog = new Watchdog(safeMode, audit);

  router.post("/config/validate", (req: Request, res: Response) => {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: "JSON object expected" });
      return;
    }
    res.json(validationSummary(validateRuntimeConfig(req.body)));
  });

  router.get("/observability/audit", (req: Request, res: Response) => {
    res.json({
      events: audit.list({
        type: asAuditEventType(req.query["type"]),
        actor:
          typeof req.query["actor"] === "string"
            ? req.query["actor"]
            : undefined,
        subject:
          typeof req.query["subject"] === "string"
            ? req.query["subject"]
            : undefined,
        limit: getLimit(req),
      }),
    });
  });

  router.post("/observability/audit", (req: Request, res: Response) => {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: "JSON object expected" });
      return;
    }
    const type = typeof req.body.type === "string" ? req.body.type : "";
    const auditType = asAuditEventType(type);
    if (!auditType) {
      res.status(400).json({ error: "valid audit type is required" });
      return;
    }
    const event = audit.record({
      type: auditType,
      actor: typeof req.body.actor === "string" ? req.body.actor : "dashboard",
      subject:
        typeof req.body.subject === "string" ? req.body.subject : "manual",
      requestId:
        typeof req.body.requestId === "string" ? req.body.requestId : undefined,
      runId: typeof req.body.runId === "string" ? req.body.runId : undefined,
      details: isRecord(req.body.details) ? req.body.details : {},
    });
    res.status(201).json({ event });
  });

  router.get("/agent/runs", (req: Request, res: Response) => {
    res.json({ runs: runRecorder.list(getLimit(req, 50)) });
  });

  router.post("/agent/runs", (req: Request, res: Response) => {
    if (
      !isRecord(req.body) ||
      typeof req.body.objective !== "string" ||
      !req.body.objective.trim()
    ) {
      res.status(400).json({ error: "objective is required" });
      return;
    }
    const rawSteps = req.body.steps;
    const requestedSteps = Array.isArray(rawSteps);
    const steps = requestedSteps
      ? rawSteps
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined;
    if (requestedSteps && steps?.length === 0) {
      res.status(400).json({ error: "at least one step is required" });
      return;
    }
    const run = runRecorder.create(req.body.objective, steps);
    audit.record({
      type: "agent.run",
      actor: "dashboard",
      subject: run.objective,
      runId: run.id,
      details: { step_count: run.steps.length },
    });
    res.status(201).json({ run });
  });

  router.get("/agent/runs/:runId", (req: Request, res: Response) => {
    const run = runRecorder.get(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "Agent run not found" });
      return;
    }
    res.json({ run });
  });

  router.patch(
    "/agent/runs/:runId/steps/:stepId",
    (req: Request, res: Response) => {
      if (!isRecord(req.body)) {
        res.status(400).json({ error: "JSON object expected" });
        return;
      }
      const patch: AgentRunStepPatch = {};
      if (typeof req.body.title === "string") {
        patch.title = req.body.title;
      }
      if (req.body.status !== undefined) {
        if (!isTaskGraphStepStatus(req.body.status)) {
          res.status(400).json({ error: "valid step status is required" });
          return;
        }
        patch.status = req.body.status;
      }
      if (req.body.evidence !== undefined) {
        const evidence = parseEvidence(req.body.evidence);
        if (!evidence) {
          res.status(400).json({ error: "valid evidence is required" });
          return;
        }
        patch.evidence = evidence;
      }
      if (req.body.error !== undefined) {
        patch.error = req.body.error;
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: "step patch is required" });
        return;
      }
      try {
        const run = runRecorder.patchStep(
          req.params.runId,
          req.params.stepId,
          patch,
        );
        audit.record({
          type: "agent.run",
          actor: "dashboard",
          subject: run.objective,
          runId: run.id,
          details: {
            action: "step.patch",
            stepId: req.params.stepId,
            status: patch.status,
          },
        });
        res.json({ run });
      } catch (err: unknown) {
        sendJsonError(res, err, 404);
      }
    },
  );

  router.post("/agent/runs/:runId/evidence", (req: Request, res: Response) => {
    if (!isRecord(req.body) || typeof req.body.stepId !== "string") {
      res.status(400).json({ error: "stepId is required" });
      return;
    }
    const evidence = parseEvidence(req.body.evidence ?? req.body);
    if (!evidence) {
      res.status(400).json({ error: "valid evidence is required" });
      return;
    }
    try {
      const run = runRecorder.recordEvidence(
        req.params.runId,
        req.body.stepId,
        evidence,
      );
      audit.record({
        type: "agent.run",
        actor: "dashboard",
        subject: run.objective,
        runId: run.id,
        details: {
          action: "evidence.record",
          stepId: req.body.stepId,
          kind: evidence.kind,
          ok: evidence.ok,
        },
      });
      res.status(201).json({ run });
    } catch (err: unknown) {
      sendJsonError(res, err, 404);
    }
  });

  router.get("/agent/runs/:runId/export", (req: Request, res: Response) => {
    const run = runRecorder.get(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "Agent run not found" });
      return;
    }
    audit.record({
      type: "agent.run",
      actor: "dashboard",
      subject: run.objective,
      runId: run.id,
      details: { action: "run.export" },
    });
    res.json(exportAgentRunBundle(run));
  });

  router.get("/runtime/performance", (_req: Request, res: Response) => {
    res.json({ timings: globalStartupTimer.report() });
  });

  router.get("/runtime/channels", (_req: Request, res: Response) => {
    res.json({ channels: channels.list() });
  });

  router.post("/events/inbound", (req: Request, res: Response) => {
    if (!isRecord(req.body) || typeof req.body.channel !== "string") {
      res.status(400).json({ error: "channel is required" });
      return;
    }
    try {
      const idempotencyHeader = req.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(idempotencyHeader)
        ? idempotencyHeader[0]
        : idempotencyHeader;
      const normalizedInput = idempotencyKey
        ? { ...req.body, idempotencyKey }
        : req.body;
      const event = channels.normalize(req.body.channel, normalizedInput, {
        senderId: typeof req.body.senderId === "string" ? req.body.senderId : undefined,
      });
      const payload = event.payload;
      const message =
        (typeof payload.message === "string" && payload.message) ||
        (typeof payload.text === "string" && payload.text) ||
        JSON.stringify(payload);
      const job = jobs.enqueue(
        "agent.message",
        { message, sessionId: event.sessionId, event },
        { idempotencyKey: event.idempotencyKey },
      );
      recordJobLifecycle(audit, "event.inbound", {
        eventId: event.eventId,
        channel: event.channel,
        jobId: job.id,
        idempotencyKey: event.idempotencyKey,
      });
      res.status(202).json({ event, job });
    } catch (error: unknown) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.get("/runtime/channels/:channel", (req: Request, res: Response) => {
    const channel = req.params.channel as ChannelName;
    if (!channels.has(channel)) {
      res.status(404).json({ error: "Unsupported channel" });
      return;
    }
    res.json({ channel, enabled: true, mode: "normalized-event-adapter" });
  });

  router.get("/runtime/deliveries", (req: Request, res: Response) => {
    const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
    res.json({
      receipts: deliveries.list(status as Parameters<DeliveryQueue["list"]>[0]),
      stats: deliveries.stats(),
    });
  });

  router.post("/runtime/deliveries", (req: Request, res: Response) => {
    if (
      !isRecord(req.body) ||
      typeof req.body.channel !== "string" ||
      typeof req.body.destination !== "string" ||
      typeof req.body.body !== "string" ||
      typeof req.body.idempotencyKey !== "string"
    ) {
      res.status(400).json({
        error: "channel, destination, body and idempotencyKey are required",
      });
      return;
    }
    try {
      const channel = req.body.channel as ChannelName;
      if (!channels.has(channel)) throw new Error(`Unsupported channel: ${channel}`);
      const receipt = deliveries.enqueue({
        channel,
        destination: req.body.destination,
        body: req.body.body,
        idempotencyKey: req.body.idempotencyKey,
        runId: typeof req.body.runId === "string" ? req.body.runId : undefined,
        eventId: typeof req.body.eventId === "string" ? req.body.eventId : undefined,
        maxAttempts: typeof req.body.maxAttempts === "number" ? req.body.maxAttempts : undefined,
      });
      recordJobLifecycle(audit, "delivery.enqueue", {
        deliveryId: receipt.id,
        channel: receipt.channel,
        status: receipt.status,
        idempotencyKey: receipt.idempotencyKey,
      });
      res.status(202).json({ receipt });
    } catch (error: unknown) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.get("/runtime/watchers", (_req: Request, res: Response) => {
    res.json({ watchers: watchers.list(), health: watchers.health() });
  });

  router.get("/runtime/timers", (_req: Request, res: Response) => {
    res.json({ timers: timers.list() });
  });

  router.post("/runtime/timers", (req: Request, res: Response) => {
    if (
      !isRecord(req.body) ||
      typeof req.body.sessionId !== "string" ||
      typeof req.body.message !== "string" ||
      typeof req.body.schedule !== "string"
    ) {
      res.status(400).json({ error: "sessionId, message and schedule are required" });
      return;
    }
    try {
      const timer = timers.create({
        sessionId: req.body.sessionId,
        message: req.body.message,
        schedule: req.body.schedule,
      });
      recordJobLifecycle(audit, "timer.create", {
        timerId: timer.id,
        schedule: timer.schedule,
        sessionId: timer.sessionId,
      });
      res.status(201).json({ timer });
    } catch (error: unknown) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.delete("/runtime/timers/:id", (req: Request, res: Response) => {
    const cancelled = timers.cancel(req.params.id);
    if (!cancelled) {
      res.status(404).json({ error: "Timer not found" });
      return;
    }
    recordJobLifecycle(audit, "timer.cancel", { timerId: req.params.id });
    res.json({ ok: true, timerId: req.params.id });
  });

  router.get("/runtime/jobs", (_req: Request, res: Response) => {
    res.json({
      jobs: jobs.list(),
      stats: jobs.stats(),
      worker: jobRunner?.getStatus() ?? null,
    });
  });

  router.get("/runtime/worker", (_req: Request, res: Response) => {
    res.json({
      worker: jobRunner?.getStatus() ?? { running: false, activeJobs: 0 },
    });
  });

  router.get("/runtime/jobs/dead-letter", (_req: Request, res: Response) => {
    const items = jobs.deadLetters();
    res.json({ jobs: items, count: items.length });
  });

  router.post("/runtime/jobs", (req: Request, res: Response) => {
    if (!isRecord(req.body) || typeof req.body.type !== "string") {
      res.status(400).json({ error: "type is required" });
      return;
    }
    const job = jobs.enqueue(
      req.body.type,
      isRecord(req.body.payload) ? req.body.payload : {},
      {
        priority:
          typeof req.body.priority === "number" ? req.body.priority : undefined,
        maxAttempts:
          typeof req.body.maxAttempts === "number"
            ? req.body.maxAttempts
            : undefined,
                delayMs:
          typeof req.body.delayMs === "number"
            ? req.body.delayMs
            : undefined,
        idempotencyKey:
          typeof req.body.idempotencyKey === "string"
            ? req.body.idempotencyKey
            : undefined,
      },
    );
    recordJobLifecycle(audit, "job.enqueue", {
      jobId: job.id,
      type: job.type,
      status: job.status,
      priority: job.priority,
      maxAttempts: job.maxAttempts,
      runAfter: job.runAfter,
    });
    res.status(202).json({ job });
  });

  router.patch(
    "/runtime/jobs/:jobId/progress",
    (req: Request, res: Response) => {
      const progress = Number((req.body || {}).progress);
      if (!Number.isFinite(progress)) {
        res.status(400).json({ error: "progress is required" });
        return;
      }
      const job = jobs.updateProgress(req.params.jobId, progress);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      recordJobLifecycle(audit, "job.progress", {
        jobId: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
      });
      res.json({ job });
    },
  );

  router.patch(
    "/runtime/jobs/:jobId/checkpoint",
    (req: Request, res: Response) => {
      if (
        !isRecord(req.body) ||
        typeof req.body.id !== "string" ||
        typeof req.body.step !== "string" ||
        !["started", "completed", "failed"].includes(String(req.body.status))
      ) {
        res.status(400).json({
          error: "id, step and status (started|completed|failed) are required",
        });
        return;
      }
      const job = jobs.checkpoint(req.params.jobId, {
        id: req.body.id,
        step: req.body.step,
        status: req.body.status as "started" | "completed" | "failed",
        data: isRecord(req.body.data) ? req.body.data : undefined,
      });
      if (!job) {
        res.status(404).json({ error: "Job not found or not owned" });
        return;
      }
      recordJobLifecycle(audit, "job.checkpoint", {
        jobId: job.id,
        type: job.type,
        checkpoint: job.checkpoint,
      });
      res.json({ job });
    },
  );
  router.post("/runtime/jobs/:jobId/retry", (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    const job = jobs.retry(
      req.params.jobId,
      typeof body.delayMs === "number" ? body.delayMs : 0,
    );
    if (!job) {
      res.status(404).json({
        error: "Job not found or not retryable",
        retryableStatuses: ["failed", "cancelled", "dead_letter"],
      });
      return;
    }
    recordJobLifecycle(audit, "job.retry", {
      jobId: job.id,
      type: job.type,
      status: job.status,
      runAfter: job.runAfter,
    });
    res.json({ job });
  });

  router.delete("/runtime/jobs/:jobId", (req: Request, res: Response) => {
    const cancelled = jobs.cancel(req.params.jobId);
    recordJobLifecycle(audit, "job.cancel", {
      jobId: req.params.jobId,
      cancelled,
    });
    res.json({ cancelled });
  });

  router.post(
    "/runtime/scheduled-tasks/validate",
    (req: Request, res: Response) => {
      const body = isRecord(req.body) ? req.body : {};
      if (typeof body.cronExpression !== "string") {
        res.status(400).json({ error: "cronExpression is required" });
        return;
      }
      const fromTime =
        typeof body.fromTime === "number" && Number.isFinite(body.fromTime)
          ? body.fromTime
          : Date.now();
      const nextRunAt = parseCronToNextRun(body.cronExpression, fromTime);
      const valid = nextRunAt !== null;
      res.status(valid ? 200 : 400).json({
        valid,
        cronExpression: body.cronExpression,
        fromTime,
        nextRunAt,
        nextRunAtIso: nextRunAt ? new Date(nextRunAt).toISOString() : null,
      });
    },
  );

  // Cache full health reports with a 5-second TTL to avoid blocking the event loop
  // on every page load with sync filesystem scans.
  let cachedHealthReport: { json: object; cachedAt: number } | null = null;
  const HEALTH_CACHE_TTL = 5_000;

  router.get("/health/full", async (_req: Request, res: Response) => {
    if (
      cachedHealthReport &&
      Date.now() - cachedHealthReport.cachedAt < HEALTH_CACHE_TTL
    ) {
      res.json(cachedHealthReport.json);
      return;
    }
    try {
      const doctor = await runDoctor(runtimePaths, {
        includeExternalChecks: false,
        includeMigrations: true,
        includeSecretScan: false,
      });
      watchdog.recordProbe({
        name: "core-api",
        healthy: true,
        message: "Core API is serving health reports.",
        restartable: false,
      });
      watchdog.recordProbe({
        name: "runtime-jobs",
        healthy: !jobs.list().some((job) => job.status === "dead_letter"),
        message: "Persistent job queue checked.",
      });
      const secretScan = scanSecrets(runtimePaths);
      const partialReport = {
        doctor,
        safeMode: safeMode.getState(),
        jobs: { items: jobs.list(), stats: jobs.stats() },
        secretScan,
        watchdog: watchdog.status(),
      };
      const components = buildHealthComponents(runtimePaths, partialReport);
      const json = {
        status: summarizeFullHealth(components),
        checkedAt: new Date().toISOString(),
        doctor,
        safeMode: partialReport.safeMode,
        backups: backups.listBackups().slice(0, 10),
        migrations: migrations.run({ dryRun: true }),
        watchdog: partialReport.watchdog,
        jobs: partialReport.jobs,
        performance: globalStartupTimer.report(),
        audit: audit.list({ limit: 20 }),
        secretScan,
        components,
      };
      cachedHealthReport = { json, cachedAt: Date.now() };
      res.json(json);
    } catch (err: unknown) {
      sendJsonError(res, err);
    }
  });

  router.post("/doctor/run", async (req: Request, res: Response) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const report = await runDoctor(runtimePaths, {
        strict: body.strict === true,
        includeExternalChecks: body.includeExternalChecks !== false,
        includeMigrations: body.includeMigrations === true,
        includeSecretScan: body.includeSecretScan === true,
      });
      res.json({ report });
    } catch (err: unknown) {
      sendJsonError(res, err);
    }
  });

  router.get("/safety/backups", (_req: Request, res: Response) => {
    res.json({ backups: backups.listBackups() });
  });

  router.post("/safety/backups", (req: Request, res: Response) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const manifest = backups.createBackup(
        typeof body.reason === "string" ? body.reason : "api",
      );
      audit.record({
        type: "system.event",
        actor: "dashboard",
        subject: "backup:create",
        details: { backupId: manifest.id, entries: manifest.entries.length },
      });
      res.status(201).json({ backup: manifest });
    } catch (err: unknown) {
      sendJsonError(res, err);
    }
  });

  router.post("/safety/rollback", (req: Request, res: Response) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      if (typeof body.backupId !== "string") {
        res.status(400).json({ error: "backupId is required" });
        return;
      }
      const result = backups.rollback(body.backupId);
      audit.record({
        type: "system.event",
        actor: "dashboard",
        subject: "backup:rollback",
        details: { ...result },
      });
      res.json({ rollback: result });
    } catch (err: unknown) {
      sendJsonError(res, err, 400);
    }
  });

  router.get("/safety/migrations", (_req: Request, res: Response) => {
    res.json({ migrations: migrations.list() });
  });

  router.post("/safety/migrations/run", (req: Request, res: Response) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const results = migrations.run({ dryRun: body.dryRun === true });
      const failed = results.find((item) => item.status === "failed");
      if (failed) {
        safeMode.enter({
          module: "migrations",
          reason: failed.error || "Migration failed.",
          severity: "critical",
          recommendation: "Inspect migration output and consider rollback.",
        });
      }
      res.json({ migrations: results, safeMode: safeMode.getState() });
    } catch (err: unknown) {
      sendJsonError(res, err);
    }
  });

  router.post("/safety/secret-scan", (req: Request, res: Response) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const report = scanSecrets(runtimePaths, { fix: body.fix === true });
      res.json({ report });
    } catch (err: unknown) {
      sendJsonError(res, err);
    }
  });

  router.get("/safety/watchdog", (_req: Request, res: Response) => {
    res.json({ watchdog: watchdog.status() });
  });

  router.post("/safety/watchdog/restart", (_req: Request, res: Response) => {
    res.json({ watchdog: watchdog.restart() });
  });

  router.post("/safety/safe-mode/clear", (req: Request, res: Response) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const moduleName =
        typeof body.module === "string" ? body.module : undefined;
      const result = safeMode.clear(moduleName);
      audit.record({
        type: "system.event",
        actor: "dashboard",
        subject: "safe-mode:clear",
        details: { module: moduleName, ...result },
      });
      res.json({ safeMode: result });
    } catch (err: unknown) {
      sendJsonError(res, err);
    }
  });

  return router;
}
