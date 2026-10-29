import {
  IconActivityHeartbeat,
  IconChevronRight,
  IconCircleX,
  IconClock,
  IconDatabase,
  IconLoader2,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconInfoCircle,
  IconPuzzle,
} from "@tabler/icons-react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { notify } from "@/lib/notify"
import { getGatewayLogs, restartGateway } from "@/api/gateway"
import {
  type PluginHealth,
  type PluginManifest,
  getPluginHealth,
  getPluginManifests,
} from "@/api/plugins"
import { type FullHealthReport, getFullHealthReport } from "@/api/safety"
import { PageHeader } from "@/app/layout/page-header"
import { cn } from "@/lib/utils"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

export type PluginPageSection = "catalog" | "core" | "health"

const NAVIGATION = [
  {
    labelKey: "pages.plugins.catalog",
    to: "/plugins?section=catalog",
    section: "catalog" as const,
    icon: IconDatabase,
  },
  {
    labelKey: "pages.plugins.coreServices",
    to: "/plugins?section=core",
    section: "core" as const,
    icon: IconSettings,
  },
  {
    labelKey: "pages.plugins.healthLogs",
    to: "/plugins?section=health",
    section: "health" as const,
    icon: IconActivityHeartbeat,
  },
]

const PAGE_META: Record<PluginPageSection, { titleKey: string }> = {
  catalog: { titleKey: "pages.plugins.catalog" },
  core: { titleKey: "pages.plugins.coreServices" },
  health: { titleKey: "pages.plugins.healthLogs" },
}

function familyForManifest(manifest: PluginManifest) {
  if (manifest.id.startsWith("provider.")) return "provider"
  if (manifest.id.startsWith("channel.")) return "channel"
  return "capability"
}

function statusLabel(status?: string) {
  return (status ?? "unknown").replaceAll("_", " ")
}

function statusTone(status?: string) {
  if (
    ["functional", "enabled", "ready", "healthy", "pass"].includes(status ?? "")
  ) {
    return "success"
  }
  if (
    ["partial", "config_only", "degraded", "warn", "needs_config"].includes(
      status ?? "",
    )
  ) {
    return "warning"
  }
  if (
    ["failed", "error", "blocked", "auth_failed", "runtime_error"].includes(
      status ?? "",
    )
  ) {
    return "danger"
  }
  return "neutral"
}

function StatusBadge({ status }: { status?: string }) {
  const { t } = useTranslation()
  const tone = statusTone(status)
  const statusKey = (status ?? "unknown").toLowerCase().replaceAll("-", "_")
  const label = t(`pages.plugins.status.${statusKey}`, {
    defaultValue: statusLabel(status),
  })
  return (
    <Badge
      variant={
        tone === "danger"
          ? "destructive"
          : tone === "success"
            ? "default"
            : "outline"
      }
      className={cn(
        "capitalize",
        tone === "success" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      {label}
    </Badge>
  )
}

function StateMessage({
  kind,
  message,
  onRetry,
}: {
  kind: "loading" | "error" | "empty"
  message: string
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        "flex min-h-32 flex-col items-center justify-center gap-2 border border-dashed px-4 text-center text-sm",
        kind === "error" && "border-destructive/40 text-destructive",
        kind !== "error" && "text-muted-foreground",
      )}
      role={kind === "error" ? "alert" : "status"}
    >
      {kind === "loading" && <IconLoader2 className="size-4 animate-spin" />}
      {kind === "error" && <IconCircleX className="size-4" />}
      <span>{message}</span>
      {kind === "error" && onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <IconRefresh className="size-3.5" aria-hidden="true" />
          <span>{t("pages.plugins.retry", { defaultValue: "Retry" })}</span>
        </Button>
      )}
    </div>
  )
}

function SectionHeading({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div
      data-page-section="true"
      className="flex flex-wrap items-end justify-between gap-3 border-b pb-3"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <h2 className="text-base font-semibold tracking-[-0.015em]">{title}</h2>
        <Tooltip delayDuration={350}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("pages.plugins.moreInformation", {
                defaultValue: "More information",
              })}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <IconInfoCircle className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="start" className="max-w-[20rem] whitespace-normal">
            {description}
          </TooltipContent>
        </Tooltip>
      </div>
      {action}
    </div>
  )
}

function Row({
  title,
  description,
  status,
  action,
  icon,
}: {
  title: string
  description?: string
  status?: string
  action?: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <div
      data-page-row="true"
      className="flex flex-col gap-3 border-b py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          {description && (
            <div className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5 sm:line-clamp-1">
              {description}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:pl-4">
        {status && <StatusBadge status={status} />}
        {action}
      </div>
    </div>
  )
}


function CatalogPage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState("all")
  const manifestsQuery = useQuery({
    queryKey: ["plugins", "manifests"],
    queryFn: getPluginManifests,
  })
  const healthQuery = useQuery({
    queryKey: ["plugins", "health"],
    queryFn: getPluginHealth,
  })
  const manifests = useMemo(
    () => manifestsQuery.data?.manifests ?? [],
    [manifestsQuery.data?.manifests],
  )
  const health = healthQuery.data?.health ?? {}
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    return manifests.filter((manifest) => {
      const matchesCategory =
        category === "all" || familyForManifest(manifest) === category
      const matchesSearch =
        !query ||
        [manifest.displayName, manifest.id, manifest.description].some(
          (value) => value?.toLowerCase().includes(query),
        )
      return matchesCategory && matchesSearch
    })
  }, [category, manifests, search])

  return (
    <div className="space-y-4">
      <SectionHeading
        title={t("pages.plugins.availablePlugins", { defaultValue: "Available plugins" })}
        description={t("pages.plugins.availablePluginsDescription", { defaultValue: "Browse the runtime catalog. Configuration actions open the existing management surface." })}
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t("pages.plugins.searchPlugins", { defaultValue: "Search plugins" })}</span>
          <IconSearch className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("pages.plugins.searchPlugins", { defaultValue: "Search plugins" })}
            className="pl-9"
          />
        </label>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          aria-label={t("pages.plugins.allCategories", { defaultValue: "Filter plugins by category" })}
          className="border-input bg-background h-9 min-w-0 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <option value="all">{t("pages.plugins.allCategories", { defaultValue: "All categories" })}</option>
          <option value="provider">{t("pages.plugins.providers", { defaultValue: "Providers" })}</option>
          <option value="channel">{t("pages.plugins.channels", { defaultValue: "Channels" })}</option>
          <option value="capability">{t("pages.plugins.skillsTools", { defaultValue: "Skills & tools" })}</option>
        </select>
      </div>
      {manifestsQuery.isLoading || healthQuery.isLoading ? (
        <StateMessage kind="loading" message={t("pages.plugins.loadingCatalog", { defaultValue: "Loading plugin catalog…" })} />
      ) : manifestsQuery.isError || healthQuery.isError ? (
        <StateMessage
          kind="error"
          message={t("pages.plugins.catalogUnavailable", { defaultValue: "The plugin catalog is unavailable." })}
          onRetry={() => {
            void manifestsQuery.refetch()
            void healthQuery.refetch()
          }}
        />
      ) : visible.length === 0 ? (
        <StateMessage
          kind="empty"
          message={t("pages.plugins.noPluginsMatch", { defaultValue: "No plugins match the current filter." })}
        />
      ) : (
        <div className="divide-border divide-y border-t">
          {visible.map((manifest) => {
            const pluginHealth = health[manifest.id]
            const family = familyForManifest(manifest)
            const target =
              family === "provider"
                ? "/models"
                : family === "channel"
                  ? "/channels"
                  : manifest.id.toLowerCase().includes("skill")
                    ? "/agent/skills"
                    : "/agent/tools"
            return (
              <Row
                key={manifest.id}
                title={manifest.displayName}
                description={manifest.description || manifest.id}
                status={pluginHealth?.status ?? manifest.runtimeStatus}
                icon={<IconPuzzle className="size-4" />}
                action={
                  <Button asChild size="sm" variant="outline">
                    <a href={target}>
                      {t("pages.plugins.open", { defaultValue: "Open" })} <IconChevronRight className="size-3.5" />
                    </a>
                  </Button>
                }
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

const CORE_SERVICE_LABELS: Record<string, string> = {
  "authentication.core": "pages.plugins.authentication",
  "memory.temporal-knowledge-graph": "navigation.memory",
  "scheduler.core": "pages.plugins.automation",
  "observability.core": "pages.plugins.observability",
  "storage.core": "pages.plugins.storage",
  "security.policy-kernel": "pages.plugins.security",
  "workflow.project": "pages.plugins.workflow",
  "notifications.core": "pages.plugins.notifications",
}

function CorePage() {
  const { t } = useTranslation()
  const manifestsQuery = useQuery({
    queryKey: ["plugins", "manifests"],
    queryFn: getPluginManifests,
  })
  const healthQuery = useQuery({
    queryKey: ["plugins", "health"],
    queryFn: getPluginHealth,
  })
  const core = (manifestsQuery.data?.manifests ?? []).filter(
    (manifest) => manifest.id in CORE_SERVICE_LABELS,
  )
  const health = healthQuery.data?.health ?? {}
  return (
    <div className="space-y-4">
      <SectionHeading
        title={t("pages.plugins.coreServices", { defaultValue: "Core Services" })}
        description={t("pages.plugins.coreServicesDescription", { defaultValue: "Core service status is reported by the runtime." })}
      />
      {manifestsQuery.isLoading || healthQuery.isLoading ? (
        <StateMessage kind="loading" message={t("pages.plugins.loadingCore", { defaultValue: "Loading core services…" })} />
      ) : manifestsQuery.isError || healthQuery.isError ? (
        <StateMessage
          kind="error"
          message={t("pages.plugins.coreUnavailable", { defaultValue: "Core service data is unavailable." })}
          onRetry={() => {
            void manifestsQuery.refetch()
            void healthQuery.refetch()
          }}
        />
      ) : core.length === 0 ? (
        <StateMessage
          kind="empty"
          message={t("pages.plugins.noCoreMetadata", { defaultValue: "No core service metadata is available." })}
        />
      ) : (
        <div className="divide-border divide-y border-t">
          {core.map((manifest) => (
            <Row
              key={manifest.id}
              title={t(CORE_SERVICE_LABELS[manifest.id], { defaultValue: manifest.id })}
              description={manifest.description || manifest.id}
              status={health[manifest.id]?.status ?? manifest.runtimeStatus}
              icon={<IconSettings className="size-4" />}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function HealthPage() {
  const { t } = useTranslation()
  const healthQuery = useQuery({
    queryKey: ["plugins", "health"],
    queryFn: getPluginHealth,
  })
  const reportQuery = useQuery({
    queryKey: ["plugins", "full-health"],
    queryFn: getFullHealthReport,
  })
  const logsQuery = useQuery({
    queryKey: ["plugins", "logs"],
    queryFn: () => getGatewayLogs(),
  })
  const restartMutation = useMutation({
    mutationFn: restartGateway,
    onSuccess: () => notify.success(t("pages.plugins.restartRequested", { defaultValue: "Restart requested" }), { id: "plugins-page:success:restart-requested" }),
    onError: (error) =>
      notify.error(error instanceof Error ? error.message : t("pages.plugins.restartFailed", { defaultValue: "Restart failed" }), { id: "plugins-page:error:restartMutation" }),
  })
  const health = healthQuery.data?.health ?? {}
  const report = reportQuery.data
  const loading =
    healthQuery.isLoading || reportQuery.isLoading || logsQuery.isLoading
  const error = healthQuery.isError || reportQuery.isError || logsQuery.isError
  return (
    <div className="space-y-6">
      <SectionHeading
        title={t("pages.plugins.healthLogs", { defaultValue: "Health & Logs" })}
        description={t("pages.plugins.healthLogsDescription", { defaultValue: "Live plugin health, core service health, and recent gateway logs." })}
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void healthQuery.refetch()
                void reportQuery.refetch()
                void logsQuery.refetch()
              }}
              disabled={loading}
            >
              <IconRefresh className="size-3.5" />
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => restartMutation.mutate()}
              disabled={restartMutation.isPending}
            >
              <IconRefresh className="size-3.5" />
              {t("pages.plugins.restart", { defaultValue: "Restart" })}
            </Button>
          </div>
        }
      />
      {loading ? (
        <StateMessage kind="loading" message={t("pages.plugins.loadingHealth", { defaultValue: "Loading health and logs…" })} />
      ) : error ? (
        <StateMessage
          kind="error"
          message={t("pages.plugins.healthUnavailable", { defaultValue: "Health data is unavailable." })}
          onRetry={() => {
            void healthQuery.refetch()
            void reportQuery.refetch()
            void logsQuery.refetch()
          }}
        />
      ) : (
        <>
          <section>
            <div className="mb-2 flex items-center gap-2">
              <IconActivityHeartbeat className="text-muted-foreground size-4" />
              <h3 className="text-sm font-semibold">{t("navigation.plugins", { defaultValue: "Plugins" })}</h3>
            </div>
            <div className="divide-border divide-y border-t">
              {Object.entries(health).length === 0 ? (
                <div className="text-muted-foreground border border-dashed px-4 py-6 text-sm">
                  {t("pages.plugins.noPluginHealth", { defaultValue: "No plugin health checks reported." })}
                </div>
              ) : (
                Object.entries(health).map(
                  ([id, item]: [string, PluginHealth]) => (
                    <Row
                      key={id}
                      title={id}
                      description={item.message || `${item.latencyMs ?? 0} ms`}
                      status={item.status}
                    />
                  ),
                )
              )}
            </div>
          </section>
          <section>
            <div className="mb-2 flex items-center gap-2">
              <IconDatabase className="text-muted-foreground size-4" />
              <h3 className="text-sm font-semibold">{t("pages.plugins.services", { defaultValue: "Services" })}</h3>
            </div>
            <div className="divide-border divide-y border-t">
              {report?.components?.map(
                (component: FullHealthReport["components"][number]) => (
                  <Row
                    key={component.name}
                    title={component.name}
                    description={component.message}
                    status={component.status}
                  />
                ),
              ) ?? (
                <div className="text-muted-foreground px-4 py-6 text-sm">
                  {t("pages.plugins.noServiceHealth", { defaultValue: "No service health reported." })}
                </div>
              )}
            </div>
          </section>
          <section>
            <div className="mb-2 flex items-center gap-2">
              <IconClock className="text-muted-foreground size-4" />
              <h3 className="text-sm font-semibold">{t("pages.plugins.recentLogs", { defaultValue: "Recent logs" })}</h3>
            </div>
            <pre className="bg-muted/30 max-h-72 overflow-auto border p-3 font-mono text-xs leading-5">
              {logsQuery.data?.logs?.length
                ? logsQuery.data.logs.slice(-80).join("\n")
                : t("pages.plugins.noRecentLogs", { defaultValue: "No recent logs." })}
            </pre>
          </section>
        </>
      )}
    </div>
  )
}

export function PluginsPage() {
  const { t } = useTranslation()
  const requested = new URLSearchParams(globalThis.location.search).get("section")
  const section: PluginPageSection =
    requested === "core" || requested === "health" ? requested : "catalog"
  const meta = PAGE_META[section]
  return (
    <div className="flex h-full min-h-0 flex-col" data-miki-page="plugins">
      <PageHeader title={`${t("navigation.plugins", { defaultValue: "Plugins" })} · ${t(meta.titleKey, { defaultValue: meta.titleKey })}`} titleLevel={1} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6" data-miki-page-body="true">
        <div className="mx-auto w-full max-w-5xl space-y-6 pt-2">
          <nav
            aria-label={t("pages.plugins.sectionNavigation", {
              defaultValue: "Plugin sections",
            })}
            className="border-border flex flex-wrap gap-2 border-b pb-3"
          >
            {NAVIGATION.map((item) => (
              <Link
                key={item.section}
                to="/plugins"
                search={{ section: item.section }}
                aria-current={section === item.section ? "page" : undefined}
                data-active={section === item.section ? "true" : "false"}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  section === item.section
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                {t(item.labelKey, { defaultValue: item.labelKey })}
              </Link>
            ))}
          </nav>
          <div className="pt-1">
            {section === "catalog" && <CatalogPage />}
            {section === "core" && <CorePage />}
            {section === "health" && <HealthPage />}
          </div>
        </div>
      </div>
    </div>
  )
}
