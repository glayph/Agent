import {
  IconActivity,
  IconAlertTriangle,
  IconCircleCheck,
  IconClockBolt,
  IconLoader2,
  IconPackage,
  IconShieldCheck,
} from "@tabler/icons-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import type {
  PluginMarketplaceIssueSeverity,
  PluginMarketplaceReadinessReport,
  PluginMarketplaceReadinessResponse,
  PluginMarketplaceReadinessStatus,
} from "@/api/skills"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

interface PluginReadinessPanelProps {
  readiness?: PluginMarketplaceReadinessResponse
  isLoading: boolean
  error: unknown
}

const statusTone: Record<PluginMarketplaceReadinessStatus, string> = {
  ready:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  metadata_only:
    "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  needs_policy:
    "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  incomplete:
    "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  blocked: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
}

const issueTone: Record<PluginMarketplaceIssueSeverity, string> = {
  error: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  warning:
    "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
}

function statusLabel(
  status: PluginMarketplaceReadinessStatus,
  t: ReturnType<typeof useTranslation>["t"],
) {
  return t(`pages.agent.skills.plugin_readiness.status.${status}`, {
    defaultValue: status.replaceAll("_", " "),
  })
}

function formatGeneratedAt(value?: string) {
  return value ? formatDateTime(value) : ""
}

function formatAuditLabel(value?: string) {
  if (!value) return "none"
  return value.replaceAll("_", " ")
}

function formatAuditTime(value?: string) {
  return value ? formatDateTime(value) : ""
}

function PluginCandidateCard({
  report,
}: {
  report: PluginMarketplaceReadinessReport
}) {
  const { t } = useTranslation()
  const actionableIssues = report.issues.filter(
    (issue) => issue.severity !== "info",
  )
  const previewIssues = actionableIssues.slice(0, 3)
  const hiddenIssues = Math.max(
    0,
    actionableIssues.length - previewIssues.length,
  )

  return (
    <Card
      size="sm"
      className="border-border/40 bg-card/40 hover:bg-card transition-[background-color,box-shadow] hover:shadow-md"
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <CardTitle className="truncate text-base">
              {report.plugin.name}
            </CardTitle>
            <CardDescription className="line-clamp-2">
              {report.plugin.description ||
                t("pages.agent.skills.no_description")}
            </CardDescription>
          </div>
          <Badge
            variant="outline"
            className={cn("capitalize", statusTone[report.status])}
          >
            {statusLabel(report.status, t)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <ReadinessMetric
            label={t("pages.agent.skills.plugin_readiness.score", {
              defaultValue: "Score",
            })}
            value={`${report.score}`}
          />
          <ReadinessMetric
            label={t("pages.agent.skills.plugin_readiness.contracts", {
              defaultValue: "Contracts",
            })}
            value={`${report.summary.total}`}
          />
          <ReadinessMetric
            label={t("pages.agent.skills.plugin_readiness.risk", {
              defaultValue: "Risk",
            })}
            value={report.summary.risk}
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {Object.entries(report.summary.byKind)
            .filter(([, count]) => count > 0)
            .map(([kind, count]) => (
              <span
                key={kind}
                className="bg-muted/60 text-muted-foreground rounded-md px-2 py-0.5 text-[11px] font-medium"
              >
                {kind}: {count}
              </span>
            ))}
        </div>

        <div className="border-border/40 bg-background/35 rounded-xl border p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
              <IconActivity className="text-muted-foreground size-4" />
              {t("pages.agent.skills.plugin_readiness.audit_title", {
                defaultValue: "Runtime Evidence",
              })}
            </div>
            <span className="text-muted-foreground text-xs">
              {report.audit.total}{" "}
              {t("pages.agent.skills.plugin_readiness.audit_events", {
                defaultValue: "events",
              })}
            </span>
          </div>
          {report.audit.total > 0 ? (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <ReadinessMetric
                  label={t(
                    "pages.agent.skills.plugin_readiness.audit_success",
                    {
                      defaultValue: "Success",
                    },
                  )}
                  value={`${report.audit.succeeded}`}
                />
                <ReadinessMetric
                  label={t("pages.agent.skills.plugin_readiness.audit_failed", {
                    defaultValue: "Failed",
                  })}
                  value={`${report.audit.failed}`}
                />
                <ReadinessMetric
                  label={t(
                    "pages.agent.skills.plugin_readiness.audit_blocked",
                    {
                      defaultValue: "Blocked",
                    },
                  )}
                  value={`${report.audit.blocked}`}
                />
              </div>
              <div className="text-muted-foreground text-xs leading-5">
                {t("pages.agent.skills.plugin_readiness.audit_last", {
                  action: formatAuditLabel(report.audit.lastAction),
                  status: formatAuditLabel(report.audit.lastStatus),
                  defaultValue: "Last: {{action}} / {{status}}",
                })}
                {report.audit.lastEventAt ? (
                  <span> · {formatAuditTime(report.audit.lastEventAt)}</span>
                ) : null}
              </div>
              {report.audit.recent[0] ? (
                <div className="border-border/40 bg-muted/20 rounded-lg border px-3 py-2 text-xs leading-5">
                  <div className="font-semibold">
                    {formatAuditLabel(report.audit.recent[0].action)} ·{" "}
                    {report.audit.recent[0].contractName ||
                      report.audit.recent[0].subject}
                  </div>
                  {report.audit.recent[0].error ? (
                    <div className="text-muted-foreground line-clamp-2">
                      {report.audit.recent[0].error}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-muted-foreground text-xs leading-5">
              {t("pages.agent.skills.plugin_readiness.audit_empty", {
                defaultValue:
                  "No runtime audit events recorded for this plugin yet.",
              })}
            </div>
          )}
        </div>

        {previewIssues.length ? (
          <div className="space-y-2">
            {previewIssues.map((issue) => (
              <div
                key={`${issue.code}:${issue.contract?.kind ?? ""}:${issue.contract?.name ?? ""}:${issue.permission ?? ""}`}
                className={cn(
                  "rounded-lg border px-3 py-2 text-xs leading-5",
                  issueTone[issue.severity],
                )}
              >
                <div className="font-semibold">
                  {issue.contract
                    ? `${issue.contract.kind}:${issue.contract.name}`
                    : issue.code}
                </div>
                <div>{issue.message}</div>
              </div>
            ))}
            {hiddenIssues > 0 ? (
              <div className="text-muted-foreground text-xs">
                {t("pages.agent.skills.plugin_readiness.more_issues", {
                  count: hiddenIssues,
                  defaultValue: "+{{count}} more issue(s)",
                })}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            {t("pages.agent.skills.plugin_readiness.no_action_needed", {
              defaultValue: "No actionable onboarding issues detected.",
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ReadinessMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/30 rounded-lg px-2.5 py-2">
      <div className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
        {label}
      </div>
      <div className="text-foreground mt-1 font-semibold capitalize">
        {value}
      </div>
    </div>
  )
}

function SummaryTile({
  label,
  value,
  tone,
  icon,
}: {
  label: string
  value: number
  tone: string
  icon: ReactNode
}) {
  return (
    <div className="border-border/40 bg-background/40 flex items-center justify-between rounded-xl border px-4 py-3">
      <div>
        <div className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
          {label}
        </div>
        <div className="text-2xl font-bold tracking-tight">{value}</div>
      </div>
      <div className={cn("rounded-xl p-2.5", tone)}>{icon}</div>
    </div>
  )
}

export function PluginReadinessPanel({
  readiness,
  isLoading,
  error,
}: PluginReadinessPanelProps) {
  const { t } = useTranslation()
  const reports = readiness?.data ?? []
  const readyCount = readiness?.summary.ready ?? 0
  const metadataOnlyCount = readiness?.summary.metadata_only ?? 0
  const needsPolicyCount = readiness?.summary.needs_policy ?? 0
  const blockedCount =
    (readiness?.summary.blocked ?? 0) + (readiness?.summary.incomplete ?? 0)
  const generatedAt = formatGeneratedAt(readiness?.generatedAt)

  if (isLoading) {
    return (
      <Card className="border-border/40 bg-card/40 shadow-sm">
        <CardContent className="flex items-center gap-3 py-5">
          <IconLoader2 className="text-muted-foreground size-4 animate-spin" />
          <span className="text-muted-foreground text-sm">
            {t("pages.agent.skills.plugin_readiness.loading", {
              defaultValue: "Checking plugin marketplace readiness…",
            })}
          </span>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="border-destructive/30 bg-destructive/5 shadow-sm">
        <CardContent className="text-destructive flex items-start gap-3 py-5 text-sm">
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {t("pages.agent.skills.plugin_readiness.load_error", {
              defaultValue: "Failed to load plugin marketplace readiness.",
            })}
          </span>
        </CardContent>
      </Card>
    )
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {t("pages.agent.skills.plugin_readiness.title", {
              defaultValue: "Plugin Marketplace Readiness",
            })}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("pages.agent.skills.plugin_readiness.description", {
              defaultValue:
                "Verify installed plugin contracts, metadata, runtime policy, and onboarding gaps before publishing.",
            })}
          </p>
        </div>
        {generatedAt ? (
          <div className="text-muted-foreground text-xs">
            {t("pages.agent.skills.plugin_readiness.generated_at", {
              value: generatedAt,
              defaultValue: "Generated {{value}}",
            })}
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <SummaryTile
          label={t("pages.agent.skills.plugin_readiness.candidates", {
            defaultValue: "Candidates",
          })}
          value={readiness?.total ?? 0}
          tone="bg-slate-500/10 text-slate-700 dark:text-slate-300"
          icon={<IconPackage className="size-5" />}
        />
        <SummaryTile
          label={t("pages.agent.skills.plugin_readiness.ready", {
            defaultValue: "Ready",
          })}
          value={readyCount}
          tone="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          icon={<IconCircleCheck className="size-5" />}
        />
        <SummaryTile
          label={t("pages.agent.skills.plugin_readiness.metadata_only", {
            defaultValue: "Publishable",
          })}
          value={metadataOnlyCount}
          tone="bg-sky-500/10 text-sky-700 dark:text-sky-300"
          icon={<IconCircleCheck className="size-5" />}
        />
        <SummaryTile
          label={t("pages.agent.skills.plugin_readiness.needs_policy", {
            defaultValue: "Needs Policy",
          })}
          value={needsPolicyCount}
          tone="bg-amber-500/10 text-amber-800 dark:text-amber-300"
          icon={<IconClockBolt className="size-5" />}
        />
        <SummaryTile
          label={t("pages.agent.skills.plugin_readiness.blocked", {
            defaultValue: "Blocked",
          })}
          value={blockedCount}
          tone="bg-red-500/10 text-red-700 dark:text-red-300"
          icon={<IconShieldCheck className="size-5" />}
        />
      </div>

      {reports.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {reports.map((report) => (
            <PluginCandidateCard key={report.plugin.name} report={report} />
          ))}
        </div>
      ) : (
        <Card className="border-border/40 bg-muted/10 border-dashed shadow-sm">
          <CardContent className="text-muted-foreground py-6 text-sm">
            {t("pages.agent.skills.plugin_readiness.empty", {
              defaultValue:
                "No installed plugin contracts are registered yet. Install a plugin manifest with contracts to generate marketplace readiness evidence.",
            })}
          </CardContent>
        </Card>
      )}
    </section>
  )
}
