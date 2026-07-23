import * as fs from "fs";
import * as path from "path";
import { type RuntimePaths } from "../paths.js";
import type { AuditEvent } from "../audit-log.js";
import type { TimingEntry } from "../performance-budgets.js";
import type { PersistentJob } from "../persistent-job-queue.js";
import type { BackupManifest } from "./backup.js";
import type { DoctorReport } from "./doctor.js";
import type { MigrationRunResult } from "./migrations.js";
import type { SafeModeState } from "./safe-mode.js";
import type { SecretScanReport } from "./secret-scan.js";
import type { WatchdogStatus } from "./watchdog.js";

export interface HealthComponent {
  name: string;
  status: "healthy" | "degraded" | "failed" | "unknown";
  message: string;
}

export interface FullHealthReport {
  status: "healthy" | "degraded" | "failed";
  checkedAt: string;
  doctor: DoctorReport;
  safeMode: SafeModeState;
  backups: BackupManifest[];
  migrations: MigrationRunResult[];
  watchdog: WatchdogStatus;
  jobs: {
    items: PersistentJob[];
    stats: Record<string, number>;
  };
  performance: TimingEntry[];
  audit: AuditEvent[];
  secretScan: SecretScanReport;
  components: HealthComponent[];
}

function fileExists(
  sourceDir: string | undefined,
  relativePath: string,
): boolean {
  return sourceDir ? fs.existsSync(path.join(sourceDir, relativePath)) : false;
}

export function buildHealthComponents(
  paths: RuntimePaths,
  report: Pick<
    FullHealthReport,
    "doctor" | "safeMode" | "jobs" | "secretScan" | "watchdog"
  >,
): HealthComponent[] {
  const stalledJobs = report.jobs.items.filter(
    (job) => job.status === "running" || job.status === "dead_letter",
  );
  return [
    {
      name: "Core API",
      status: "healthy",
      message: "Core API process is serving this report.",
    },
    {
      name: "Runtime files",
      status: fileExists(paths.sourceDir, "packages/core/dist/api/index.js")
        ? "healthy"
        : "degraded",
      message: "Core runtime artifact check.",
    },
    {
      name: "Safe mode",
      status: report.safeMode.enabled ? "degraded" : "healthy",
      message: report.safeMode.enabled
        ? `${report.safeMode.reasons.length} safe-mode reason(s) active.`
        : "Safe mode is not active.",
    },
    {
      name: "Doctor",
      status:
        report.doctor.status === "pass"
          ? "healthy"
          : report.doctor.status === "warn"
            ? "degraded"
            : "failed",
      message: `Doctor status: ${report.doctor.status}.`,
    },
    {
      name: "Job queue",
      status: stalledJobs.length > 0 ? "degraded" : "healthy",
      message:
        stalledJobs.length > 0
          ? `${stalledJobs.length} job(s) need attention.`
          : "No stalled jobs detected.",
    },
    {
      name: "Secret scan",
      status: report.secretScan.findings.length > 0 ? "degraded" : "healthy",
      message:
        report.secretScan.findings.length > 0
          ? `${report.secretScan.findings.length} possible secret leak(s).`
          : "No likely secret leaks found.",
    },
    {
      name: "Watchdog",
      status: report.watchdog.services.some((service) => !service.healthy)
        ? "degraded"
        : "healthy",
      message: `${report.watchdog.services.length} service probe(s) recorded.`,
    },
  ];
}

export function summarizeFullHealth(
  components: HealthComponent[],
): FullHealthReport["status"] {
  if (components.some((item) => item.status === "failed")) return "failed";
  if (components.some((item) => item.status === "degraded")) return "degraded";
  return "healthy";
}
