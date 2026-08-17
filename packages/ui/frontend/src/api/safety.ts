import { launcherFetch } from "@/api/http"

export type SafetyStatus = "pass" | "warn" | "fail"
export type HealthStatus = "healthy" | "degraded" | "failed" | "unknown"

export interface DoctorCheckResult {
  id: string
  label: string
  status: SafetyStatus
  message: string
  details?: Record<string, unknown>
}

export interface DoctorReport {
  status: SafetyStatus
  checkedAt: string
  workspaceDir: string
  checks: DoctorCheckResult[]
}

export interface BackupManifest {
  id: string
  createdAt: string
  entries: Array<{
    source: string
    kind: "file" | "directory"
    sizeBytes: number
  }>
}

export interface SafeModeState {
  enabled: boolean
  reasons: Array<{
    module: string
    reason: string
    severity: "info" | "warning" | "critical"
    recommendation: string
    createdAt: string
  }>
}

export interface SecretScanReport {
  scannedFiles: number
  fixedFiles: string[]
  findings: Array<{
    file: string
    line: number
    pattern: string
    redactedPreview: string
  }>
}

export interface WatchdogStatus {
  enabled: boolean
  services: Array<{
    name: string
    healthy: boolean
    failures: number
    lastMessage: string
    lastCheckedAt: string
    nextRetryAt?: string
  }>
}

export interface RuntimeJob {
  id: string
  type: string
  status: string
  priority: number
  attempts: number
  maxAttempts: number
  progress: number
  updatedAt: string
  runAfter: number
  error?: {
    code: string
    message: string
    retryable: boolean
  }
}

export interface FullHealthReport {
  status: "healthy" | "degraded" | "failed"
  checkedAt: string
  doctor: DoctorReport
  safeMode: SafeModeState
  backups: BackupManifest[]
  migrations: Array<{
    id: string
    status: "applied" | "skipped" | "failed" | "dry_run"
    changedPaths: string[]
    error?: string
  }>
  watchdog: WatchdogStatus
  jobs: {
    items: RuntimeJob[]
    stats: Record<string, number>
  }
  performance: Array<{ name: string; durationMs: number }>
  audit: Array<{ id: number; type: string; subject: string; createdAt: string }>
  secretScan: SecretScanReport
  components: Array<{ name: string; status: HealthStatus; message: string }>
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await launcherFetch(path, options)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `API error: ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function getFullHealthReport(): Promise<FullHealthReport> {
  return request<FullHealthReport>("/api/enhancements/health/full")
}

export function runDoctor(): Promise<{ report: DoctorReport }> {
  return request<{ report: DoctorReport }>("/api/enhancements/doctor/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      includeExternalChecks: false,
      includeMigrations: true,
      includeSecretScan: true,
    }),
  })
}

export function createBackup(): Promise<{ backup: BackupManifest }> {
  return request<{ backup: BackupManifest }>(
    "/api/enhancements/safety/backups",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "dashboard" }),
    },
  )
}

export function rollbackBackup(
  backupId: string,
): Promise<{
  rollback: { restoredBackupId: string; restoredEntries: number }
}> {
  return request("/api/enhancements/safety/rollback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backupId }),
  })
}

export function runSecretScan(
  fix = false,
): Promise<{ report: SecretScanReport }> {
  return request("/api/enhancements/safety/secret-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fix }),
  })
}

export function restartWatchdog(): Promise<{ watchdog: WatchdogStatus }> {
  return request("/api/enhancements/safety/watchdog/restart", {
    method: "POST",
  })
}

export function clearSafeMode(moduleName?: string): Promise<{
  safeMode: { enabled: boolean; reasons: unknown[]; updatedAt: string }
}> {
  return request("/api/enhancements/safety/safe-mode/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ module: moduleName }),
  })
}

export function cancelRuntimeJob(
  jobId: string,
): Promise<{ cancelled: boolean }> {
  return request(
    `/api/enhancements/runtime/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "DELETE",
    },
  )
}

export function retryRuntimeJob(jobId: string): Promise<{ job: RuntimeJob }> {
  return request(
    `/api/enhancements/runtime/jobs/${encodeURIComponent(jobId)}/retry`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delayMs: 0 }),
    },
  )
}

export function getDeadLetterJobs(): Promise<{
  jobs: RuntimeJob[]
  count: number
}> {
  return request("/api/enhancements/runtime/jobs/dead-letter")
}
