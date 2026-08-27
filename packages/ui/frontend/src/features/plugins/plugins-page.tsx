import { IconSearch, IconSparkles } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  type PluginFamily,
  type PluginManifest,
  type PluginRuntimeStatus,
  getPluginHealth,
  getPluginManifests,
} from "@/api/plugins"
import { PageHeader } from "@/app/layout/page-header"
import { Badge } from "@/shared/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"
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

const FAMILY_DESCRIPTIONS: Record<PluginFamily, string> = {
  provider:
    "AI model and inference adapters, including cloud and local runtimes.",
  channel:
    "Messaging and transport adapters that connect Miki to external platforms.",
  capability:
    "Optional runtime capabilities exposed through the canonical Plugin SDK.",
}

const CORE_SERVICES = [
  ["Authentication", "Dashboard and gateway identity are core-owned."],
  [
    "Memory",
    "Durable conversation memory and learning persistence are core-owned.",
  ],
  [
    "Automation",
    "Scheduler, workflow state, retries, and idempotency are core-owned.",
  ],
  [
    "Observability",
    "Internal logs, metrics, tracing, and health reporting are core-owned.",
  ],
  [
    "Configuration",
    "The core configuration service owns validation and persistence.",
  ],
  [
    "Plugin Management",
    "Discovery, policy, install, update, and lifecycle control are core-owned.",
  ],
] as const

function isCoreOwned(manifest: PluginManifest): boolean {
  return CORE_OWNED_IDS.has(manifest.id)
}

function familyForManifest(manifest: PluginManifest): PluginFamily {
  if (manifest.id.startsWith("provider.")) return "provider"
  if (manifest.id.startsWith("channel.")) return "channel"
  return "capability"
}

function statusLabel(status: PluginRuntimeStatus): string {
  return status.replace("_", " ")
}

function statusVariant(
  status: PluginRuntimeStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "functional") return "default"
  if (status === "partial" || status === "config_only") return "secondary"
  if (status === "disabled" || status === "unsupported") return "destructive"
  return "outline"
}

function PluginCard({
  manifest,
  health,
}: {
  manifest: PluginManifest
  health?: { ok: boolean; status: PluginRuntimeStatus; message?: string }
}) {
  const effectiveStatus = health?.status ?? manifest.runtimeStatus
  const coreOwned = isCoreOwned(manifest)
  const requirements = manifest.requiredConfig?.length ?? 0
  const permissions = manifest.permissions?.length ?? 0

  return (
    <Card className="border-border/70 bg-card/80 hover:border-primary/40 flex h-full flex-col shadow-none transition-colors">
      <CardHeader className="gap-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">
              {manifest.displayName}
            </CardTitle>
            <p className="text-muted-foreground mt-1 truncate font-mono text-[11px]">
              {manifest.id}
            </p>
          </div>
          <Badge
            variant={statusVariant(effectiveStatus)}
            className="shrink-0 capitalize"
          >
            {statusLabel(effectiveStatus)}
          </Badge>
        </div>
        <p className="text-muted-foreground min-h-10 text-sm leading-5">
          {manifest.description ||
            "No description provided by this Plugin manifest."}
        </p>
      </CardHeader>
      <CardContent className="mt-auto space-y-3 pt-0">
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span>v{manifest.version}</span>
          <span>{coreOwned ? "Core-owned" : "Installable adapter"}</span>
          {requirements > 0 && (
            <span>
              {requirements} config field{requirements === 1 ? "" : "s"}
            </span>
          )}
          {permissions > 0 && (
            <span>
              {permissions} permission{permissions === 1 ? "" : "s"}
            </span>
          )}
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
      </CardContent>
    </Card>
  )
}

export function PluginsPage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState("")
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

  const counts = useMemo(() => {
    const result = {
      total: manifests.length,
      functional: 0,
      partial: 0,
      core: 0,
    }
    for (const manifest of manifests) {
      if (isCoreOwned(manifest)) result.core += 1
      const status = health[manifest.id]?.status ?? manifest.runtimeStatus
      if (status === "functional") result.functional += 1
      if (status === "partial") result.partial += 1
    }
    return result
  }, [health, manifests])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={t("navigation.plugins")}>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <IconSparkles className="size-4" />
          <span>Canonical Plugin catalog</span>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto w-full max-w-7xl space-y-6">
          <section
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            aria-label="Plugin summary"
          >
            {[
              ["Catalog", counts.total, "Built-in manifests"],
              ["Functional", counts.functional, "Runtime-ready"],
              ["Partial", counts.partial, "Needs configuration or probe"],
              ["Core-owned", counts.core, "Managed by Miki core"],
            ].map(([label, value, description]) => (
              <Card
                key={label}
                className="border-border/70 bg-card/70 shadow-none"
              >
                <CardContent className="p-4">
                  <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    {label}
                  </p>
                  <p className="text-foreground mt-2 text-2xl font-semibold">
                    {value}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </section>

          <section className="border-border/70 bg-muted/20 rounded-xl border p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-sm font-semibold">Plugin catalog</h2>
                <p className="text-muted-foreground mt-1 text-sm">
                  Providers, channels, and optional capabilities use the
                  existing Plugin SDK contract.
                </p>
              </div>
              <label className="relative block w-full md:w-72">
                <span className="sr-only">Search plugins</span>
                <IconSearch className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search plugins…"
                  className="pl-9"
                />
              </label>
            </div>
          </section>

          {manifestsQuery.isLoading ? (
            <div className="text-muted-foreground py-10 text-center text-sm">
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
            <div className="text-muted-foreground py-10 text-center text-sm">
              No plugins match the current search.
            </div>
          ) : (
            (Object.keys(FAMILY_LABELS) as PluginFamily[]).map((family) => {
              const familyManifests = visibleManifests.filter(
                (manifest) => familyForManifest(manifest) === family,
              )
              if (familyManifests.length === 0) return null
              return (
                <section key={family} className="space-y-3">
                  <div>
                    <h2 className="text-base font-semibold">
                      {FAMILY_LABELS[family]}
                    </h2>
                    <p className="text-muted-foreground text-sm">
                      {FAMILY_DESCRIPTIONS[family]}
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {familyManifests.map((manifest) => (
                      <PluginCard
                        key={manifest.id}
                        manifest={manifest}
                        health={health[manifest.id]}
                      />
                    ))}
                  </div>
                </section>
              )
            })
          )}

          <section className="space-y-3 pb-8">
            <div>
              <h2 className="text-base font-semibold">Core services</h2>
              <p className="text-muted-foreground text-sm">
                These services are intentionally not independently installable
                Plugins.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {CORE_SERVICES.map(([label, description]) => (
                <Card
                  key={label}
                  className="border-border/60 bg-muted/10 shadow-none"
                >
                  <CardContent className="flex items-start gap-3 p-4">
                    <div className="bg-primary/10 text-primary mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md">
                      <IconSparkles className="size-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-muted-foreground mt-1 text-xs leading-5">
                        {description}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
