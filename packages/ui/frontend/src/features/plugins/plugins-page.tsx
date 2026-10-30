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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { notify } from "@/lib/notify"
import { getGatewayLogs, restartGateway } from "@/api/gateway"
import {
  type PluginHealth,
  type PluginManifest,
  type InstalledPlugin,
  type PluginPermission,
  getPluginHealth,
  getPluginManifests,
  getTrustedPluginMarketplace,
  installTrustedPluginPackage,
  getInstalledPlugins,
  installPluginArchive,
  updateInstalledPlugin,
  uninstallInstalledPlugin,
  probeInstalledPluginHealth,
} from "@/api/plugins"
import { type FullHealthReport, getFullHealthReport } from "@/api/safety"
import { PageHeader } from "@/app/layout/page-header"
import { cn } from "@/lib/utils"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

export type PluginPageSection = "catalog" | "installed" | "core" | "health"

const NAVIGATION = [
  {
    labelKey: "pages.plugins.catalog",
    to: "/plugins?section=catalog",
    section: "catalog" as const,
    icon: IconDatabase,
  },
  {
    labelKey: "pages.plugins.installed",
    to: "/plugins?section=installed",
    section: "installed" as const,
    icon: IconPuzzle,
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
  installed: { titleKey: "pages.plugins.installed" },
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
  const queryClient = useQueryClient()
  const marketplaceQuery = useQuery({
    queryKey: ["plugins", "trusted-marketplace"],
    queryFn: getTrustedPluginMarketplace,
    retry: false,
  })
  const installTrustedMutation = useMutation({
    mutationFn: (id: string) => installTrustedPluginPackage(id),
    onSuccess: () => {
      notify.success(t("pages.plugins.installSucceeded", { defaultValue: "Plugin package installed. It has not been enabled yet." }), { id: "plugins:trusted-install:success" })
      void queryClient.invalidateQueries({ queryKey: ["plugins", "installed"] })
      void queryClient.invalidateQueries({ queryKey: ["plugins", "trusted-marketplace"] })
    },
    onError: (error) => notify.error(error instanceof Error ? error.message : t("pages.plugins.installFailed", { defaultValue: "Could not install the trusted package." }), { id: "plugins:trusted-install:error" }),
  })
  const manifestsQuery = useQuery({
    queryKey: ["plugins", "manifests"],
    queryFn: getPluginManifests,
  })
  const healthQuery = useQuery({
    queryKey: ["plugins", "health"],
    queryFn: getPluginHealth,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
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
      {manifestsQuery.isLoading ? (
        <StateMessage kind="loading" message={t("pages.plugins.loadingCatalog", { defaultValue: "Loading plugin catalog…" })} />
      ) : manifestsQuery.isError ? (
        <StateMessage
          kind="error"
          message={t("pages.plugins.catalogUnavailable", { defaultValue: "The plugin catalog is unavailable." })}
          onRetry={() => { void manifestsQuery.refetch() }}
        />
      ) : visible.length === 0 ? (
        <StateMessage
          kind="empty"
          message={t("pages.plugins.noPluginsMatch", { defaultValue: "No plugins match the current filter." })}
        />
      ) : (
        <>
        {healthQuery.isError && <p role="status" className="text-muted-foreground text-xs">{t("pages.plugins.healthUnavailable", { defaultValue: "Health status is temporarily unavailable; showing declared status." })}</p>}
        <div className="divide-border divide-y border-t">
          {visible.map((manifest) => {
            const pluginHealth = health[manifest.id]
            const target = pluginManagementRoute(manifest)
            return (
              <Row
                key={manifest.id}
                title={manifest.displayName}
                description={[
                  manifest.description,
                  pluginHealth?.source === "manifest_only"
                    ? t("pages.plugins.manifestOnly", { defaultValue: "Manifest status only; not live-probed." })
                    : undefined,
                ].filter(Boolean).join(" · ") || manifest.id}
                status={pluginHealth?.source === "manifest_only" ? "metadata_only" : pluginHealth?.status ?? manifest.runtimeStatus}
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
        </>
      )}
      <section className="space-y-3 border-t pt-4" aria-label={t("pages.plugins.trustedExtensions", { defaultValue: "Trusted extensions" })}>
        <div>
          <h3 className="text-sm font-semibold">{t("pages.plugins.trustedExtensions", { defaultValue: "Trusted extensions" })}</h3>
          <p className="text-muted-foreground mt-1 text-xs">{t("pages.plugins.trustedExtensionsDescription", { defaultValue: "Packages are listed only after their archive checksum and Ed25519 signature match the locally configured trust key." })}</p>
        </div>
        {marketplaceQuery.isLoading ? <StateMessage kind="loading" message={t("pages.plugins.loadingTrustedMarketplace", { defaultValue: "Checking trusted packages…" })} /> : marketplaceQuery.isError ? <StateMessage kind="error" message={t("pages.plugins.trustedMarketplaceUnavailable", { defaultValue: "The trusted package registry is unavailable." })} onRetry={() => { void marketplaceQuery.refetch() }} /> : (marketplaceQuery.data?.packages.length ?? 0) === 0 ? <StateMessage kind="empty" message={t("pages.plugins.noTrustedPackages", { defaultValue: "No verified packages are currently available in the trusted registry." })} /> : <div className="divide-border divide-y border-t">
          {marketplaceQuery.data?.packages.map((item) => <div key={item.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{item.manifest.displayName}</span><Badge variant="outline">v{item.manifest.version}</Badge><Badge variant="outline">{t("pages.plugins.signatureVerified", { defaultValue: "Signature verified" })}</Badge></div><p className="text-muted-foreground mt-1 text-xs">{item.id} · {item.description || item.manifest.description || ""}</p></div>
            {item.installed ? <StatusBadge status="installed" /> : <Button size="sm" disabled={installTrustedMutation.isPending} onClick={() => installTrustedMutation.mutate(item.id)}>{installTrustedMutation.isPending ? t("pages.plugins.installing", { defaultValue: "Installing…" }) : t("pages.plugins.install", { defaultValue: "Install" })}</Button>}
          </div>)}
        </div>}
      </section>
    </div>
  )
}

const UNSUPPORTED_RUNTIME_PERMISSIONS = new Set<PluginPermission>(["network", "secrets", "shell", "browser", "computer-use", "mcp", "agent-delegation"])

function InstalledPluginsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedGrants, setSelectedGrants] = useState<Record<string, PluginPermission[]>>({})
  const installedQuery = useQuery({ queryKey: ["plugins", "installed"], queryFn: getInstalledPlugins, refetchInterval: 15_000, refetchIntervalInBackground: false })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["plugins", "installed"] })
  const installMutation = useMutation({
    mutationFn: (file: File) => installPluginArchive(file),
    onSuccess: (plugin) => { notify.success(t("pages.plugins.installSucceeded", { defaultValue: "Plugin package installed. It has not been enabled yet." }), { id: "plugins:install:success" }); setSelectedGrants((prev) => ({ ...prev, [plugin.id]: [] })); void refresh() },
    onError: (error) => notify.error(error instanceof Error ? error.message : t("pages.plugins.installFailed", { defaultValue: "Plugin install failed." }), { id: "plugins:install:error" }),
  })
  const lifecycleMutation = useMutation({
    mutationFn: ({ id, enabled, grants }: { id: string; enabled?: boolean; grants: PluginPermission[] }) => updateInstalledPlugin(id, { ...(enabled !== undefined ? { enabled } : {}), granted_permissions: grants }),
    onSuccess: (plugin) => { notify.success(plugin.enabled ? t("pages.plugins.enableSucceeded", { defaultValue: "Plugin runtime is healthy." }) : t("pages.plugins.lifecycleUpdated", { defaultValue: "Plugin settings updated." }), { id: "plugins:lifecycle:success" }); void refresh() },
    onError: (error, variables) => {
      setSelectedGrants((prev) => { const next = { ...prev }; delete next[variables.id]; return next })
      void refresh()
      notify.error(error instanceof Error ? error.message : t("pages.plugins.lifecycleFailed", { defaultValue: "Plugin lifecycle action failed." }), { id: "plugins:lifecycle:error" })
    },
  })
  const uninstallMutation = useMutation({
    mutationFn: (id: string) => uninstallInstalledPlugin(id),
    onSuccess: () => { notify.success(t("pages.plugins.uninstallSucceeded", { defaultValue: "Plugin uninstalled." }), { id: "plugins:uninstall:success" }); void refresh() },
    onError: (error) => notify.error(error instanceof Error ? error.message : t("pages.plugins.uninstallFailed", { defaultValue: "Plugin uninstall failed." }), { id: "plugins:uninstall:error" }),
  })
  const healthMutation = useMutation({
    mutationFn: (id: string) => probeInstalledPluginHealth(id),
    onSuccess: (health) => { notify.success(`${t("pages.plugins.healthChecked", { defaultValue: "Health checked" })}: ${health.status ?? (health.ok ? "healthy" : "unknown")}`, { id: "plugins:health:success" }); void refresh() },
    onError: (error) => notify.error(error instanceof Error ? error.message : t("pages.plugins.healthUnavailable", { defaultValue: "Health is unavailable." }), { id: "plugins:health:error" }),
  })
  const onArchiveChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (file) installMutation.mutate(file)
  }
  const plugins = installedQuery.data?.plugins ?? []

  return (
    <div className="space-y-4">
      <SectionHeading
        title={t("pages.plugins.installed", { defaultValue: "Installed extensions" })}
        description={t("pages.plugins.installedDescription", { defaultValue: "Install a selected local ZIP package, review requested permissions, and manage its isolated runtime lifecycle. Built-ins remain immutable." })}
        action={<label className={cn("inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium", installMutation.isPending && "pointer-events-none opacity-50")}>
          <IconPuzzle className="size-4" />
          {installMutation.isPending ? t("pages.plugins.installing", { defaultValue: "Installing…" }) : t("pages.plugins.installArchive", { defaultValue: "Install ZIP" })}
          <input type="file" accept=".zip,application/zip" className="sr-only" aria-label={t("pages.plugins.installArchive", { defaultValue: "Install ZIP" })} disabled={installMutation.isPending} onChange={onArchiveChange} />
        </label>}
      />
      <p className="text-muted-foreground text-xs leading-5">{t("pages.plugins.runtimeIsolationNote", { defaultValue: "Executable extensions run only when the OS sandbox is available and all requested permissions are supported and explicitly granted. A successful install does not imply that code is running." })}</p>
      {installedQuery.isLoading ? <StateMessage kind="loading" message={t("pages.plugins.loadingInstalled", { defaultValue: "Loading installed extensions…" })} /> : installedQuery.isError ? <StateMessage kind="error" message={t("pages.plugins.installedUnavailable", { defaultValue: "Installed extension state is unavailable." })} onRetry={() => { void installedQuery.refetch() }} /> : plugins.length === 0 ? <StateMessage kind="empty" message={t("pages.plugins.noInstalled", { defaultValue: "No external extensions installed. Built-in capabilities are listed in Catalog." })} /> : (
        <div className="divide-border divide-y border-t">
          {plugins.map((plugin: InstalledPlugin) => {
            const grants = selectedGrants[plugin.id] ?? plugin.granted_permissions
            const unsupported = plugin.requested_permissions.filter((permission) => UNSUPPORTED_RUNTIME_PERMISSIONS.has(permission))
            const canEnable = plugin.sandbox_supported && unsupported.length === 0 && plugin.requested_permissions.every((permission) => grants.includes(permission))
            return <div key={plugin.id} className="space-y-3 border-b py-4 last:border-b-0" data-plugin-id={plugin.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{plugin.manifest.displayName}</span><Badge variant="outline">v{plugin.version}</Badge><StatusBadge status={plugin.runtime_status} /></div>
                  <p className="text-muted-foreground mt-1 text-xs">{plugin.id} · {plugin.source} · {plugin.lifecycle_state}</p>
                  {plugin.manifest.description && <p className="text-muted-foreground mt-1 text-sm">{plugin.manifest.description}</p>}
                  {plugin.last_error_code && <p className="text-destructive mt-1 text-xs" role="status">{t("pages.plugins.lastFailure", { defaultValue: "Last lifecycle error" })}: {plugin.last_error_code}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={healthMutation.isPending} onClick={() => healthMutation.mutate(plugin.id)}>{t("pages.plugins.checkHealth", { defaultValue: "Check health" })}</Button>
                  {plugin.enabled ? <Button size="sm" variant="outline" disabled={lifecycleMutation.isPending} onClick={() => lifecycleMutation.mutate({ id: plugin.id, enabled: false, grants })}>{t("pages.plugins.disable", { defaultValue: "Disable" })}</Button> : <Button size="sm" disabled={!canEnable || lifecycleMutation.isPending} title={!plugin.sandbox_supported ? t("pages.plugins.sandboxUnavailable", { defaultValue: "OS sandbox unavailable" }) : unsupported.length ? `${t("pages.plugins.unsupportedPermissions", { defaultValue: "Unsupported permissions" })}: ${unsupported.join(", ")}` : undefined} onClick={() => lifecycleMutation.mutate({ id: plugin.id, enabled: true, grants })}>{t("pages.plugins.enable", { defaultValue: "Enable" })}</Button>}
                  <Button size="sm" variant="destructive" disabled={uninstallMutation.isPending} onClick={() => { const detail = `${plugin.manifest.displayName} v${plugin.version}
${t("pages.plugins.requestedPermissions", { defaultValue: "Requested permissions" })}: ${plugin.requested_permissions.join(", ") || t("pages.plugins.none", { defaultValue: "none" })}
${t("pages.plugins.dependencies", { defaultValue: "Dependencies" })}: ${plugin.manifest.dependencies?.join(", ") || t("pages.plugins.none", { defaultValue: "none" })}

${t("pages.plugins.confirmUninstall", { defaultValue: "Uninstall this extension and remove its granted permissions?" })}`; if (window.confirm(detail)) uninstallMutation.mutate(plugin.id) }}>{t("pages.plugins.uninstall", { defaultValue: "Uninstall" })}</Button>
                </div>
              </div>
              {plugin.requested_permissions.length > 0 && <fieldset className="rounded-md border p-3"><legend className="px-1 text-xs font-medium">{t("pages.plugins.permissionGrants", { defaultValue: "Permission grants" })}</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{plugin.requested_permissions.map((permission) => <label key={permission} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={grants.includes(permission)} disabled={plugin.enabled || lifecycleMutation.isPending} onChange={(event) => { const next = event.target.checked ? [...new Set([...grants, permission])] : grants.filter((item) => item !== permission); setSelectedGrants((prev) => ({ ...prev, [plugin.id]: next })); lifecycleMutation.mutate({ id: plugin.id, grants: next }) }} />{permission}</label>)}</div><p className="text-muted-foreground mt-2 text-xs">{t("pages.plugins.permissionGrantNotice", { defaultValue: "Filesystem access, when granted, is confined to this package directory. Unsupported high-impact capabilities remain blocked by the runtime sandbox." })}</p></fieldset>}
            </div>
          })}
        </div>
      )}
    </div>
  )
}

const CORE_SERVICE_LABELS: Record<string, string> = {
  "tools.core-registry": "pages.plugins.tools",
  "workflow.agent-loop": "pages.plugins.workflow",
  "storage.local": "pages.plugins.storage",
  "memory.temporal-knowledge-graph": "navigation.memory",
  "authentication.core": "pages.plugins.authentication",
  "security.workspace-policy": "pages.plugins.security",
  "scheduler.cron": "pages.plugins.automation",
  "notification.approvals": "pages.plugins.notifications",
  "observability.audit-log": "pages.plugins.observability",
  "model-router.registry": "pages.plugins.modelRouter",
  "guardrail.safety": "pages.plugins.security",
  "code-execution.runtime-fetch": "pages.plugins.codeExecution",
  "mcp.server": "pages.plugins.mcp",
  "search.web": "pages.plugins.search",
  "browser.playwright": "pages.plugins.browser",
  "computer-use.native": "pages.plugins.computerUse",
  "knowledge.documents": "pages.plugins.knowledge",
  "integration.platform-connections": "pages.plugins.integrations",
  "agent-to-agent.swarm": "pages.plugins.agentSwarm",
}

function pluginManagementRoute(manifest: PluginManifest): string {
  if (manifest.id.startsWith("provider.")) return "/models"
  if (manifest.id.startsWith("channel.")) return "/channels"
  const routes: Record<string, string> = {
    "memory.temporal-knowledge-graph": "/memory",
    "tools.core-registry": "/agent/tools",
    "workflow.agent-loop": "/agent/monitor",
    "storage.local": "/drive",
    "scheduler.cron": "/agent/activity",
    "notification.approvals": "/agent/monitor",
    "authentication.core": "/config",
    "security.workspace-policy": "/config",
    "observability.audit-log": "/health",
    "model-router.registry": "/models",
    "guardrail.safety": "/health",
    "code-execution.runtime-fetch": "/agent/tools",
    "mcp.server": "/agent/tools",
    "search.web": "/agent/tools",
    "browser.playwright": "/agent/tools",
    "computer-use.native": "/agent/activity",
    "knowledge.documents": "/drive",
    "integration.platform-connections": "/config",
    "agent-to-agent.swarm": "/agent/monitor",
  }
  return routes[manifest.id] ?? "/agent/tools"
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
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
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
      {manifestsQuery.isLoading ? (
        <StateMessage kind="loading" message={t("pages.plugins.loadingCore", { defaultValue: "Loading core services…" })} />
      ) : manifestsQuery.isError ? (
        <StateMessage
          kind="error"
          message={t("pages.plugins.coreUnavailable", { defaultValue: "Core service data is unavailable." })}
          onRetry={() => { void manifestsQuery.refetch() }}
        />
      ) : core.length === 0 ? (
        <StateMessage
          kind="empty"
          message={t("pages.plugins.noCoreMetadata", { defaultValue: "No core service metadata is available." })}
        />
      ) : (
        <>
        {healthQuery.isError && <p role="status" className="text-muted-foreground text-xs">{t("pages.plugins.healthUnavailable", { defaultValue: "Health status is temporarily unavailable; showing declared status." })}</p>}
        <div className="divide-border divide-y border-t">
          {core.map((manifest) => (
            <Row
              key={manifest.id}
              title={t(CORE_SERVICE_LABELS[manifest.id], { defaultValue: manifest.id })}
              description={[
                manifest.description || manifest.id,
                health[manifest.id]?.source === "manifest_only"
                  ? t("pages.plugins.manifestOnly", { defaultValue: "Manifest status only; not live-probed." })
                  : undefined,
              ].filter(Boolean).join(" · ")}
              status={health[manifest.id]?.source === "manifest_only" ? "metadata_only" : health[manifest.id]?.status ?? manifest.runtimeStatus}
              icon={<IconSettings className="size-4" />}
            />
          ))}
        </div>
        </>
      )}
    </div>
  )
}

function HealthPage() {
  const { t } = useTranslation()
  const healthQuery = useQuery({
    queryKey: ["plugins", "health"],
    queryFn: getPluginHealth,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
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
      ) : (
        <>
          {(healthQuery.isError || reportQuery.isError || logsQuery.isError) && (
            <div role="status" className="border border-amber-500/30 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              {t("pages.plugins.partialHealthError", { defaultValue: "Some health sections could not be loaded. Other available sections are still shown." })}
              <Button size="sm" variant="outline" className="ml-2" onClick={() => { void healthQuery.refetch(); void reportQuery.refetch(); void logsQuery.refetch() }}>{t("pages.plugins.retry", { defaultValue: "Retry" })}</Button>
            </div>
          )}
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
                      description={[
                        item.message,
                        item.latencyMs != null ? `${item.latencyMs} ms` : undefined,
                        item.source === "manifest_only" ? t("pages.plugins.manifestOnly", { defaultValue: "Manifest status only; not live-probed." }) : undefined,
                        item.checkedAt ? t("pages.plugins.checkedAt", { at: new Date(item.checkedAt).toLocaleTimeString(), defaultValue: "Checked at {{at}}" }) : undefined,
                      ].filter(Boolean).join(" · ") || t("pages.plugins.notMeasured", { defaultValue: "Not measured" })}
                      status={item.source === "manifest_only" ? "metadata_only" : item.status}
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
    requested === "installed" || requested === "core" || requested === "health" ? requested : "catalog"
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
            {section === "installed" && <InstalledPluginsPage />}
            {section === "core" && <CorePage />}
            {section === "health" && <HealthPage />}
          </div>
        </div>
      </div>
    </div>
  )
}
