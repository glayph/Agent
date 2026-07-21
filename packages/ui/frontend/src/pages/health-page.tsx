import {
  IconActivityHeartbeat,
  IconCircleX,
  IconDatabaseExport,
  IconRefresh,
  IconRotateClockwise,
  IconSearch,
  IconShieldCheck,
} from "@tabler/icons-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  type FullHealthReport,
  type HealthStatus,
  type SafetyStatus,
  cancelRuntimeJob,
  clearSafeMode,
  createBackup,
  getFullHealthReport,
  restartWatchdog,
  retryRuntimeJob,
  rollbackBackup,
  runDoctor,
  runSecretScan,
} from "@/api/safety"
import { FlowStatusPanel } from "@/features/health/components/flow-status-panel"
import {
  CompactActionRow,
  SectionPanel,
  StatusDot,
} from "@/shared/ui/minimal-primitives"
import { PageHeader } from "@/app/layout/page-header"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"
import { Separator } from "@/shared/ui/separator"
import { Skeleton } from "@/shared/ui/skeleton"
import { formatDateTime } from "@/lib/format"

function statusVariant(status: SafetyStatus | HealthStatus) {
  if (status === "pass" || status === "healthy") return "default" as const
  if (status === "warn" || status === "degraded" || status === "unknown") {
    return "secondary" as const
  }
  return "destructive" as const
}

function statusTone(status: SafetyStatus | HealthStatus) {
  if (status === "pass" || status === "healthy") return "success" as const
  if (status === "warn" || status === "degraded" || status === "unknown") {
    return "warning" as const
  }
  return "danger" as const
}

function StatCard({
  label,
  value,
  status,
}: {
  label: string
  value: string | number
  status: SafetyStatus | HealthStatus
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="truncate">{label}</span>
          <Badge variant={statusVariant(status)}>{status}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}

export function HealthPage() {
  const { t } = useTranslation()
  const [report, setReport] = useState<FullHealthReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{
    kind: "success" | "error"
    text: string
  } | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<
    FullHealthReport["backups"][number] | null
  >(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setReport(await getFullHealthReport())
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("pages.health.load_error")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const jobCount = useMemo(
    () =>
      report
        ? Object.values(report.jobs.stats).reduce(
            (sum, value) => sum + value,
            0,
          )
        : 0,
    [report],
  )
  const deadLetterJobs = useMemo(
    () =>
      report
        ? report.jobs.items.filter((job) => job.status === "dead_letter")
        : [],
    [report],
  )

  const runAction = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name)
    try {
      await action()
      const message = t("pages.health.completed")
      setStatusMessage({ kind: "success", text: message })
      toast.success(message)
      await load()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("pages.health.action_failed")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    } finally {
      setBusy(null)
    }
  }

  const confirmRollback = () => {
    if (!rollbackTarget) {
      return
    }

    const backupId = rollbackTarget.id
    setRollbackTarget(null)
    void runAction("rollback", () => rollbackBackup(backupId))
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("pages.health.title")}
        titleExtra={
          report && (
            <Badge variant={statusVariant(report.status)}>
              {report.status}
            </Badge>
          )
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
        >
          <IconRefresh data-icon="inline-start" />
          {t("pages.health.refresh")}
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {statusMessage && (
          <div
            className={
              statusMessage.kind === "error"
                ? "border-border bg-destructive/10 text-destructive mb-4 rounded-lg border px-3 py-2 text-sm"
                : "border-border bg-muted/60 text-foreground mb-4 rounded-lg border px-3 py-2 text-sm"
            }
            role={statusMessage.kind === "error" ? "alert" : "status"}
            aria-live={statusMessage.kind === "error" ? "assertive" : "polite"}
          >
            {statusMessage.text}
          </div>
        )}
        {loading && !report ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-28 rounded-lg" />
            ))}
          </div>
        ) : report ? (
          <div className="flex flex-col gap-5">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label={t("pages.health.stats.doctor")}
                value={report.doctor.status}
                status={report.doctor.status}
              />
              <StatCard
                label={t("pages.health.stats.safe_mode")}
                value={
                  report.safeMode.enabled
                    ? t("pages.health.stats.active")
                    : t("pages.health.stats.off")
                }
                status={report.safeMode.enabled ? "degraded" : "healthy"}
              />
              <StatCard
                label={t("pages.health.stats.backups")}
                value={report.backups.length}
                status="healthy"
              />
              <StatCard
                label={t("pages.health.stats.secret_findings")}
                value={report.secretScan.findings.length}
                status={
                  report.secretScan.findings.length > 0 ? "degraded" : "healthy"
                }
              />
            </div>

            <SectionPanel
              title={t("pages.health.actions.title")}
              description={t("pages.health.actions.description")}
            >
              <CompactActionRow className="justify-start border-t-0 bg-transparent p-0">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void runAction("doctor", runDoctor)}
                >
                  <IconShieldCheck data-icon="inline-start" />
                  {t("pages.health.actions.doctor")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void runAction("backup", createBackup)}
                >
                  <IconDatabaseExport data-icon="inline-start" />
                  {t("pages.health.actions.backup")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void runAction("scan", () => runSecretScan(false))
                  }
                >
                  <IconSearch data-icon="inline-start" />
                  {t("pages.health.actions.scan")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void runAction("watchdog", restartWatchdog)}
                >
                  <IconActivityHeartbeat data-icon="inline-start" />
                  {t("pages.health.actions.watchdog")}
                </Button>
                {report.safeMode.enabled && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void runAction("clear-safe-mode", () =>
                        clearSafeMode(),
                      )
                    }
                  >
                    <IconShieldCheck data-icon="inline-start" />
                    {t("pages.health.actions.clear_safe_mode", {
                      defaultValue: "Clear Safe Mode",
                    })}
                  </Button>
                )}
              </CompactActionRow>
            </SectionPanel>

            <FlowStatusPanel />

            <div className="grid gap-4 xl:grid-cols-2">
              <SectionPanel
                title={t("pages.health.sections.components")}
                description={formatDateTime(report.checkedAt)}
              >
                <div className="divide-border flex flex-col divide-y">
                  {report.components.map((component) => (
                    <div
                      key={component.name}
                      className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {component.name}
                        </div>
                        <div className="text-muted-foreground text-sm">
                          {component.message}
                        </div>
                      </div>
                      <Badge variant={statusVariant(component.status)}>
                        {component.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </SectionPanel>

              <SectionPanel
                title={t("pages.health.sections.doctor_checks")}
                description={t("pages.health.checks_count", {
                  count: report.doctor.checks.length,
                })}
              >
                <div className="divide-border flex flex-col divide-y">
                  {report.doctor.checks.map((check) => (
                    <div
                      key={check.id}
                      className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <StatusDot tone={statusTone(check.status)} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {check.label}
                        </div>
                        <div className="text-muted-foreground text-sm">
                          {check.message}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionPanel>
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
              <SectionPanel
                title={t("pages.health.sections.backups")}
                description={t("pages.health.backups_description")}
              >
                <div className="flex flex-col gap-3">
                  {report.backups.length === 0 ? (
                    <div className="text-muted-foreground text-sm">
                      {t("pages.health.no_backups")}
                    </div>
                  ) : (
                    report.backups.map((backup) => (
                      <div key={backup.id} className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {backup.id}
                          </div>
                          <div className="text-muted-foreground text-xs">
                            {t("pages.health.backup_entries", {
                              count: backup.entries.length,
                              date: formatDateTime(backup.createdAt),
                            })}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={busy !== null}
                          onClick={() => setRollbackTarget(backup)}
                        >
                          <IconRotateClockwise data-icon="inline-start" />
                          {t("pages.health.rollback")}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </SectionPanel>

              <SectionPanel
                title={t("pages.health.sections.watchdog")}
                description={t("pages.health.probes_count", {
                  count: report.watchdog.services.length,
                })}
              >
                <div className="flex flex-col gap-3">
                  {report.watchdog.services.length === 0 ? (
                    <div className="text-muted-foreground text-sm">
                      {t("pages.health.no_probes")}
                    </div>
                  ) : (
                    report.watchdog.services.map((service) => (
                      <div
                        key={service.name}
                        className="flex items-start gap-3"
                      >
                        <StatusDot
                          tone={service.healthy ? "success" : "danger"}
                          label={service.healthy ? "healthy" : "failed"}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {service.name}
                          </div>
                          <div className="text-muted-foreground text-sm">
                            {service.lastMessage}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </SectionPanel>

              <SectionPanel
                title={t("pages.health.sections.queue_scan")}
                description={t("pages.health.jobs_total", { count: jobCount })}
              >
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(report.jobs.stats).map(([key, value]) => (
                      <Badge key={key} variant="outline">
                        {key}: {value}
                      </Badge>
                    ))}
                    <Badge
                      variant={
                        deadLetterJobs.length > 0 ? "destructive" : "outline"
                      }
                    >
                      {t("pages.health.dead_letters", {
                        count: deadLetterJobs.length,
                        defaultValue: "Dead letters: {{count}}",
                      })}
                    </Badge>
                  </div>
                  <div className="flex flex-col gap-2">
                    {report.jobs.items.length === 0 ? (
                      <div className="text-muted-foreground text-sm">
                        {t("pages.health.no_jobs", {
                          defaultValue: "No runtime jobs recorded.",
                        })}
                      </div>
                    ) : (
                      report.jobs.items.map((job) => {
                        const retryable = [
                          "failed",
                          "cancelled",
                          "dead_letter",
                        ].includes(job.status)
                        const cancellable = ![
                          "completed",
                          "cancelled",
                          "dead_letter",
                        ].includes(job.status)
                        return (
                          <div
                            key={job.id}
                            className="border-border/70 flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate text-sm font-medium">
                                  {job.type}
                                </span>
                                <Badge variant="outline">{job.status}</Badge>
                                <span className="text-muted-foreground text-xs">
                                  {job.progress}% ·{" "}
                                  {formatDateTime(job.updatedAt)}
                                </span>
                              </div>
                              {job.error?.message && (
                                <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                                  {job.error.message}
                                </div>
                              )}
                            </div>
                            <div className="flex shrink-0 gap-2">
                              <Button
                                variant="outline"
                                size="icon-sm"
                                title={t("pages.health.retry_job", {
                                  defaultValue: "Retry job",
                                })}
                                disabled={!retryable || busy !== null}
                                onClick={() =>
                                  void runAction(`retry-${job.id}`, () =>
                                    retryRuntimeJob(job.id),
                                  )
                                }
                              >
                                <IconRotateClockwise />
                              </Button>
                              <Button
                                variant="outline"
                                size="icon-sm"
                                title={t("pages.health.cancel_job", {
                                  defaultValue: "Cancel job",
                                })}
                                disabled={!cancellable || busy !== null}
                                onClick={() =>
                                  void runAction(`cancel-${job.id}`, () =>
                                    cancelRuntimeJob(job.id),
                                  )
                                }
                              >
                                <IconCircleX />
                              </Button>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                  <Separator />
                  <div className="text-muted-foreground text-sm">
                    {t("pages.health.scan_summary", {
                      files: report.secretScan.scannedFiles,
                      findings: report.secretScan.findings.length,
                    })}
                  </div>
                  {report.secretScan.findings.map((finding) => (
                    <div
                      key={`${finding.file}:${finding.line}:${finding.pattern}`}
                    >
                      <div className="truncate text-sm font-medium">
                        {finding.file}:{finding.line}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {finding.pattern} - {finding.redactedPreview}
                      </div>
                    </div>
                  ))}
                </div>
              </SectionPanel>
            </div>
          </div>
        ) : null}
      </div>
      <AlertDialog
        open={Boolean(rollbackTarget)}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setRollbackTarget(null)
          }
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {rollbackTarget
                ? t("pages.health.rollback_confirm", {
                    id: rollbackTarget.id,
                  })
                : t("pages.health.rollback")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.health.rollback_confirm_desc", {
                defaultValue:
                  "This will restore the selected backup and may overwrite current runtime state.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmRollback}>
              {t("pages.health.rollback")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
