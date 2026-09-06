import {
  IconActivityHeartbeat,
  IconAtom,
  IconBrain,
  IconBroadcast,
  IconClockPlay,
  IconDatabase,
  IconKey,
  IconListDetails,
  IconLoader2,
  IconMessageCircle,
  IconPuzzle,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTools,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ComponentType, createElement, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  type PluginFamily,
  type PluginHealth,
  type PluginManifest,
  type PluginRuntimeStatus,
  getPluginHealth,
  getPluginManifests,
} from "@/api/plugins"
import { PageHeader } from "@/app/layout/page-header"
import { Badge } from "@/shared/ui/badge"
import { Card, CardContent } from "@/shared/ui/card"
import { Input } from "@/shared/ui/input"

const CORE_OWNED_IDS = new Set([
  "authentication.core",
  "mcp.server",
  "memory.temporal-knowledge-graph",
  "search.local-first",
  "storage.core",
  "security.policy-kernel",
  "scheduler.core",
  "workflow.project",
  "integrations.platform",
  "notifications.core",
  "observability.core",
  "guardrails.core",
])

const FAMILY_LABELS: Record<PluginFamily, string> = {
  provider: "Providers",
  channel: "Channels",
  capability: "Capabilities",
}

const FAMILY_ICONS: Record<
  PluginFamily,
  ComponentType<{ className?: string }>
> = {
  provider: IconAtom,
  channel: IconBroadcast,
  capability: IconSparkles,
}

const FAMILY_DESCRIPTIONS: Record<PluginFamily, string> = {
  provider: "Model and inference adapters",
  channel: "Messaging and transport adapters",
  capability: "Optional runtime capabilities",
}

const CORE_SERVICES = [
  ["Authentication", "Dashboard and gateway identity", IconKey],
  ["Memory", "Durable conversation memory", IconBrain],
  ["Automation", "Schedules, workflows, and retries", IconClockPlay],
  ["Observability", "Logs, metrics, and health", IconActivityHeartbeat],
  ["Configuration", "Validated runtime configuration", IconSettings],
  ["Plugin Management", "Discovery and lifecycle control", IconPuzzle],
] as const

const PLUGIN_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "provider.gemini": IconSparkles,
  "provider.llama.cpp": IconAtom,
  "channel.miki": IconMessageCircle,
  "browser.playwright": IconSearch,
  "computer-use.local": IconTools,
  "code-execution.runtime-fetch": IconDatabase,
  "mcp.server": IconPuzzle,
  "memory.temporal-knowledge-graph": IconBrain,
  "knowledge.memory-retrieval": IconSearch,
  "storage.core": IconDatabase,
  "security.policy-kernel": IconKey,
  "scheduler.core": IconClockPlay,
  "workflow.project": IconListDetails,
  "observability.core": IconActivityHeartbeat,
  "tools.core-registry": IconTools,
}

function isCoreOwned(manifest: PluginManifest): boolean {
  return CORE_OWNED_IDS.has(manifest.id)
}

function familyForManifest(manifest: PluginManifest): PluginFamily {
  if (manifest.id.startsWith("provider.")) return "provider"
  if (manifest.id.startsWith("channel.")) return "channel"
  return "capability"
}

function iconForManifest(manifest: PluginManifest) {
  return PLUGIN_ICONS[manifest.id] ?? FAMILY_ICONS[familyForManifest(manifest)]
}

function renderPluginIcon(manifest: PluginManifest, className: string) {
  return createElement(iconForManifest(manifest), { className })
}

function statusLabel(status: PluginRuntimeStatus): string {
  return status.replaceAll("_", " ")
}

function statusVariant(
  status: PluginRuntimeStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "functional") return "default"
  if (status === "partial" || status === "config_only") return "secondary"
  if (status === "disabled" || status === "unsupported") return "destructive"
  return "outline"
}

function actionForManifest(manifest: PluginManifest): {
  label: string
  to: string
} | null {
  const family = familyForManifest(manifest)
  if (family === "provider") return { label: "Open Models", to: "/models" }
  if (family === "channel") return { label: "Open Channels", to: "/channels" }
  if (manifest.id.includes("memory"))
    return { label: "Open Memory", to: "/memory" }
  if (manifest.id.includes("scheduler") || manifest.id.includes("workflow")) {
    return { label: "Open Automation", to: "/agent/automations" }
  }
  if (manifest.id.includes("observability")) {
    return { label: "Open Logs", to: "/logs" }
  }
  if (manifest.id.includes("configuration")) {
    return { label: "Open Configuration", to: "/config" }
  }
  if (manifest.id.includes("browser") || manifest.id.includes("tools")) {
    return { label: "Open Tools", to: "/agent/tools" }
  }
  return null
}

function PluginTile({
  manifest,
  health,
  selected,
  onSelect,
}: {
  manifest: PluginManifest
  health?: PluginHealth
  selected: boolean
  onSelect: () => void
}) {
  const status = health?.status ?? manifest.runtimeStatus

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={`${manifest.displayName}: ${statusLabel(status)}`}
      data-selected={selected}
      className="plugin-tile group w-full"
    >
      <span className="plugin-tile__icon flex size-8 items-center justify-center rounded-md transition-colors">
        {renderPluginIcon(manifest, "size-4")}
      </span>
      <span className="plugin-tile__name mt-1 line-clamp-2">
        {manifest.displayName}
      </span>
      <span className="plugin-tile__id mt-auto line-clamp-1 w-full">
        {manifest.id}
      </span>
      <span
        className={[
          "plugin-status-dot mt-2 shrink-0 rounded-full",
          status === "functional"
            ? "bg-emerald-500"
            : status === "partial" || status === "config_only"
              ? "bg-amber-500"
              : "bg-muted-foreground/50",
        ].join(" ")}
        aria-hidden="true"
      />
    </button>
  )
}

function PluginInspector({
  manifest,
  health,
}: {
  manifest: PluginManifest
  health?: PluginHealth
}) {
  const status = health?.status ?? manifest.runtimeStatus
  const action = actionForManifest(manifest)
  const capabilities = manifest.capabilities.filter(Boolean)
  const permissions = manifest.permissions?.filter(Boolean) ?? []
  const requirements = manifest.requiredConfig?.filter(Boolean) ?? []

  return (
    <Card className="plugin-inspector h-fit lg:sticky lg:top-5">
      <CardContent className="space-y-5 p-5">
        <div className="flex items-start gap-3">
          <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
            {renderPluginIcon(manifest, "size-5")}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold">
                {manifest.displayName}
              </h2>
              <Badge
                variant={statusVariant(status)}
                className="shrink-0 capitalize"
              >
                {statusLabel(status)}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1 truncate font-mono text-[11px]">
              {manifest.id}
            </p>
          </div>
        </div>

        <p className="text-muted-foreground text-sm leading-5">
          {manifest.description || "No description provided by this Plugin."}
        </p>

        <div className="space-y-3">
          <div>
            <p className="text-muted-foreground mb-2 text-[10px] font-semibold tracking-[0.16em] uppercase">
              Capabilities
            </p>
            <div className="flex flex-wrap gap-1.5">
              {capabilities.length > 0 ? (
                capabilities.map((capability) => (
                  <Badge
                    key={capability}
                    variant="secondary"
                    className="text-[11px]"
                  >
                    {capability.replaceAll("_", " ")}
                  </Badge>
                ))
              ) : (
                <span className="text-muted-foreground text-xs">
                  Not declared
                </span>
              )}
            </div>
          </div>

          {permissions.length > 0 && (
            <div>
              <p className="text-muted-foreground mb-2 text-[10px] font-semibold tracking-[0.16em] uppercase">
                Permissions
              </p>
              <div className="flex flex-wrap gap-1.5">
                {permissions.map((permission) => (
                  <Badge
                    key={permission}
                    variant="outline"
                    className="text-[11px]"
                  >
                    {permission}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="text-muted-foreground grid grid-cols-2 gap-2 text-xs">
            <span>Version</span>
            <span className="text-foreground text-right">
              v{manifest.version}
            </span>
            <span>Mode</span>
            <span className="text-foreground text-right">
              {isCoreOwned(manifest) ? "Core-owned" : "Installable"}
            </span>
            {requirements.length > 0 && (
              <>
                <span>Config</span>
                <span className="text-foreground text-right">
                  {requirements.length} field
                  {requirements.length === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
        </div>

        {health?.message && (
          <p
            className={
              health.ok
                ? "text-muted-foreground text-xs"
                : "text-destructive text-xs"
            }
          >
            {health.message}
          </p>
        )}

        {action && (
          <Link
            to={action.to}
            className="border-border/70 text-primary hover:bg-primary/5 inline-flex h-9 w-full items-center justify-center rounded-md border text-xs font-medium transition-colors"
          >
            {action.label}
          </Link>
        )}
      </CardContent>
    </Card>
  )
}

export function PluginsPage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState("")
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
  const health = useMemo(
    () => healthQuery.data?.health ?? {},
    [healthQuery.data?.health],
  )
  const normalizedSearch = search.trim().toLowerCase()
  const visibleManifests = useMemo(() => {
    if (!normalizedSearch) return manifests
    return manifests.filter((manifest) =>
      [manifest.id, manifest.displayName, manifest.description]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedSearch)),
    )
  }, [manifests, normalizedSearch])
  const selectedManifest =
    visibleManifests.find((manifest) => manifest.id === selectedId) ??
    visibleManifests[0]

  const counts = useMemo(() => {
    let functional = 0
    let partial = 0
    let core = 0
    for (const manifest of manifests) {
      if (isCoreOwned(manifest)) core += 1
      const status = health[manifest.id]?.status ?? manifest.runtimeStatus
      if (status === "functional") functional += 1
      if (status === "partial") partial += 1
    }
    return { functional, partial, core }
  }, [health, manifests])

  return (
    <div className="plugin-page flex h-full min-h-0 flex-col">
      <PageHeader
        title={t("navigation.plugins")}
        titleLevel={1}
        className="plugin-page__header"
        titleClassName="plugin-page__title"
        titleExtra={
          <span className="plugin-page__kicker hidden sm:inline">
            Modular runtime surface
          </span>
        }
      >
        <div className="flex items-center gap-4">
          <span className="plugin-stat">
            <strong className="plugin-stat__value">{counts.functional}</strong>
            <span className="plugin-stat__label">Ready</span>
          </span>
          <span className="plugin-stat">
            <strong className="plugin-stat__value">{counts.partial}</strong>
            <span className="plugin-stat__label">Partial</span>
          </span>
          <span className="plugin-stat hidden sm:block">
            <strong className="plugin-stat__value">{counts.core}</strong>
            <span className="plugin-stat__label">Core</span>
          </span>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-auto px-4 py-4 sm:px-6 sm:py-6">
        <div className="mx-auto w-full max-w-7xl space-y-5">
          <section className="plugin-catalog__toolbar flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <IconPuzzle className="text-muted-foreground size-4" />
              <div>
                <h2 className="text-sm font-semibold tracking-tight">
                  Plugin catalog
                </h2>
                <p className="plugin-page__lede">
                  Select a surface to inspect its runtime contract.
                </p>
              </div>
            </div>
            <label className="relative block w-full sm:w-64">
              <span className="sr-only">Search plugins</span>
              <IconSearch className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter plugins…"
                className="plugin-search h-9 pl-9 text-xs"
              />
            </label>
          </section>

          {manifestsQuery.isLoading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
              <IconLoader2 className="size-4 animate-spin" />
              Loading Plugin catalog…
            </div>
          ) : manifestsQuery.isError ? (
            <div
              className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm"
              role="alert"
            >
              Plugin catalog is unavailable. Check the gateway and core service,
              then refresh this page.
            </div>
          ) : visibleManifests.length === 0 ? (
            <div className="text-muted-foreground py-12 text-center text-sm">
              No plugins match the current search.
            </div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="space-y-6">
                {(Object.keys(FAMILY_LABELS) as PluginFamily[]).map(
                  (family) => {
                    const familyManifests = visibleManifests.filter(
                      (manifest) => familyForManifest(manifest) === family,
                    )
                    if (familyManifests.length === 0) return null
                    const FamilyIcon = FAMILY_ICONS[family]
                    return (
                      <section key={family} className="plugin-family space-y-3">
                        <div className="plugin-family__heading">
                          <FamilyIcon className="text-muted-foreground size-4" />
                          <h2 className="plugin-family__title">
                            {FAMILY_LABELS[family]}
                          </h2>
                          <p className="plugin-family__description">
                            {FAMILY_DESCRIPTIONS[family]}
                          </p>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                          {familyManifests.map((manifest) => (
                            <PluginTile
                              key={manifest.id}
                              manifest={manifest}
                              health={health[manifest.id]}
                              selected={selectedManifest?.id === manifest.id}
                              onSelect={() => setSelectedId(manifest.id)}
                            />
                          ))}
                        </div>
                      </section>
                    )
                  },
                )}

                <section className="plugin-family space-y-3 border-t pt-5">
                  <div className="flex items-center gap-2">
                    <IconSettings className="text-muted-foreground size-4" />
                    <div>
                      <h2 className="text-sm font-semibold">Core services</h2>
                      <p className="text-muted-foreground text-xs">
                        Always-on services managed by Miki core.
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {CORE_SERVICES.map(([label, description, Icon]) => (
                      <div
                        key={label}
                        title={`${label}: ${description}`}
                        className="plugin-tile flex min-h-20 flex-col items-start justify-center gap-2 p-3"
                      >
                        <Icon className="size-4" />
                        <span className="max-w-20 text-[10px] leading-tight">
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              {selectedManifest && (
                <PluginInspector
                  manifest={selectedManifest}
                  health={health[selectedManifest.id]}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
