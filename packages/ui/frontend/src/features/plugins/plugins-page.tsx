import {
  IconActivityHeartbeat,
  IconArrowLeft,
  IconAtom,
  IconBroadcast,
  IconChevronRight,
  IconCircleX,
  IconClock,
  IconDatabase,
  IconLoader2,
  IconPuzzle,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconTool,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { type SupportedChannel, getChannelsCatalog } from "@/api/channels"
import { getGatewayLogs, restartGateway } from "@/api/gateway"
import {
  type ModelInfo,
  type ModelProviderOption,
  getModels,
} from "@/api/models"
import {
  type PluginHealth,
  type PluginManifest,
  getPluginHealth,
  getPluginManifests,
} from "@/api/plugins"
import { type FullHealthReport, getFullHealthReport } from "@/api/safety"
import { type SkillSupportItem, getSkills } from "@/api/skills"
import { type ToolSupportItem, getTools, setToolEnabled } from "@/api/tools"
import { PageHeader } from "@/app/layout/page-header"
import { cn } from "@/lib/utils"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"
import { Switch } from "@/shared/ui/switch"

export type PluginPageSection =
  "catalog" | "provider" | "core" | "channel" | "capability" | "health"

const NAVIGATION = [
  {
    label: "Catalog",
    description: "Browse available plugins",
    to: "/plugins/catalog",
    section: "catalog" as const,
    icon: IconDatabase,
  },
  {
    label: "Providers & Models",
    description: "AI providers and models",
    to: "/plugins/providers",
    section: "provider" as const,
    icon: IconAtom,
  },
  {
    label: "Core Services",
    description: "System runtime services",
    to: "/plugins/core",
    section: "core" as const,
    icon: IconSettings,
  },
  {
    label: "Channels",
    description: "Messaging connections",
    to: "/plugins/channels",
    section: "channel" as const,
    icon: IconBroadcast,
  },
  {
    label: "Skills & Tools",
    description: "Agent skills and tools",
    to: "/plugins/capabilities",
    section: "capability" as const,
    icon: IconTool,
  },
  {
    label: "Health & Logs",
    description: "Runtime health and logs",
    to: "/plugins/health",
    section: "health" as const,
    icon: IconActivityHeartbeat,
  },
]

const PAGE_META: Record<
  PluginPageSection,
  { title: string; description: string }
> = {
  catalog: {
    title: "Catalog",
    description: "Available runtime plugins and their current status.",
  },
  provider: {
    title: "Providers & Models",
    description: "Connected providers and configured models.",
  },
  core: {
    title: "Core Services",
    description: "System services that keep the runtime operational.",
  },
  channel: {
    title: "Channels",
    description: "Messaging connections and their configuration state.",
  },
  capability: {
    title: "Skills & Tools",
    description: "Installed skills and tools available to the agent.",
  },
  health: {
    title: "Health & Logs",
    description: "Plugin health, service health, and recent runtime logs.",
  },
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
  const tone = statusTone(status)
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
      {statusLabel(status)}
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
          <span>Retry</span>
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
  return (
    <div
      data-page-section="true"
      className="flex flex-wrap items-end justify-between gap-3 border-b pb-3"
    >
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p
          data-text-role="supporting"
          className="text-muted-foreground mt-1 text-sm"
        >
          {description}
        </p>
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
            <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">
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

export function PluginHomePage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Plugins" titleLevel={1} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
        <div className="mx-auto w-full max-w-2xl pt-2">
          <p
            data-text-role="supporting"
            className="text-muted-foreground mb-5 text-sm"
          >
            Manage runtime plugins and services.
          </p>
          <div className="divide-border divide-y border-y">
            {NAVIGATION.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                data-page-row="true"
                className="group flex items-center gap-3 py-4"
              >
                <span className="bg-muted text-muted-foreground group-hover:bg-accent group-hover:text-accent-foreground flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors">
                  <item.icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {item.label}
                  </span>
                  <span
                    data-text-role="supporting"
                    className="text-muted-foreground mt-1 block text-xs"
                  >
                    {item.description}
                  </span>
                </span>
                <IconChevronRight className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function CatalogPage() {
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
        title="Available plugins"
        description="Browse the runtime catalog. Configuration actions open the existing management surface."
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search plugins</span>
          <IconSearch className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search plugins"
            className="pl-9"
          />
        </label>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="all">All categories</option>
          <option value="provider">Providers</option>
          <option value="channel">Channels</option>
          <option value="capability">Skills & tools</option>
        </select>
      </div>
      {manifestsQuery.isLoading || healthQuery.isLoading ? (
        <StateMessage kind="loading" message="Loading plugin catalog…" />
      ) : manifestsQuery.isError || healthQuery.isError ? (
        <StateMessage
          kind="error"
          message="The plugin catalog is unavailable."
          onRetry={() => {
            void manifestsQuery.refetch()
            void healthQuery.refetch()
          }}
        />
      ) : visible.length === 0 ? (
        <StateMessage
          kind="empty"
          message="No plugins match the current filter."
        />
      ) : (
        <div className="divide-border divide-y border-t">
          {visible.map((manifest) => {
            const pluginHealth = health[manifest.id]
            const family = familyForManifest(manifest)
            const target =
              family === "provider"
                ? "/plugins/providers"
                : family === "channel"
                  ? "/plugins/channels"
                  : "/plugins/capabilities"
            return (
              <Row
                key={manifest.id}
                title={manifest.displayName}
                description={manifest.description || manifest.id}
                status={pluginHealth?.status ?? manifest.runtimeStatus}
                icon={<IconPuzzle className="size-4" />}
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link to={target}>
                      Open <IconChevronRight className="size-3.5" />
                    </Link>
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

function ProvidersPage() {
  const modelsQuery = useQuery({
    queryKey: ["plugins", "models"],
    queryFn: getModels,
  })
  const models = useMemo(
    () => modelsQuery.data?.models ?? [],
    [modelsQuery.data?.models],
  )
  const providers = modelsQuery.data?.provider_options ?? []
  const byProvider = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>()
    for (const model of models)
      groups.set(model.provider || "unknown", [
        ...(groups.get(model.provider || "unknown") ?? []),
        model,
      ])
    return groups
  }, [models])
  return (
    <div className="space-y-4">
      <SectionHeading
        title="Providers & Models"
        description="Connected providers and configured models from the existing model configuration API."
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/models">Manage models</Link>
          </Button>
        }
      />
      {modelsQuery.isLoading ? (
        <StateMessage kind="loading" message="Loading providers and models…" />
      ) : modelsQuery.isError ? (
        <StateMessage
          kind="error"
          message="Provider data is unavailable."
          onRetry={() => {
            void modelsQuery.refetch()
          }}
        />
      ) : providers.length === 0 && models.length === 0 ? (
        <StateMessage kind="empty" message="No providers are configured yet." />
      ) : (
        <div className="divide-border divide-y border-t">
          {providers.map((provider: ModelProviderOption) => {
            const providerModels = byProvider.get(provider.id) ?? []
            return (
              <Row
                key={provider.id}
                title={provider.display_name || provider.id}
                description={
                  providerModels.length
                    ? `${providerModels.length} configured model${providerModels.length === 1 ? "" : "s"}`
                    : "Available provider · no model configured"
                }
                status={
                  providerModels.some((model) => model.available)
                    ? "connected"
                    : "available"
                }
                icon={<IconAtom className="size-4" />}
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link to="/models">Configure</Link>
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
  "authentication.core": "Authentication",
  "memory.temporal-knowledge-graph": "Memory",
  "scheduler.core": "Automation",
  "observability.core": "Observability",
  "storage.core": "Storage",
  "security.policy-kernel": "Security",
  "workflow.project": "Workflow",
  "notifications.core": "Notifications",
}

function CorePage() {
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
        title="Core Services"
        description="Core-owned services are reported by the runtime; configuration opens the relevant existing page."
      />
      {manifestsQuery.isLoading || healthQuery.isLoading ? (
        <StateMessage kind="loading" message="Loading core services…" />
      ) : manifestsQuery.isError || healthQuery.isError ? (
        <StateMessage
          kind="error"
          message="Core service data is unavailable."
          onRetry={() => {
            void manifestsQuery.refetch()
            void healthQuery.refetch()
          }}
        />
      ) : core.length === 0 ? (
        <StateMessage
          kind="empty"
          message="No core service metadata is available."
        />
      ) : (
        <div className="divide-border divide-y border-t">
          {core.map((manifest) => (
            <Row
              key={manifest.id}
              title={CORE_SERVICE_LABELS[manifest.id]}
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

function ChannelsPage() {
  const channelsQuery = useQuery({
    queryKey: ["plugins", "channels"],
    queryFn: getChannelsCatalog,
  })
  const channels = channelsQuery.data?.channels ?? []
  return (
    <div className="space-y-4">
      <SectionHeading
        title="Channels"
        description="Connection status and configuration are handled by the existing channel editor."
      />
      {channelsQuery.isLoading ? (
        <StateMessage kind="loading" message="Loading channels…" />
      ) : channelsQuery.isError ? (
        <StateMessage
          kind="error"
          message="Channel catalog is unavailable."
          onRetry={() => {
            void channelsQuery.refetch()
          }}
        />
      ) : channels.length === 0 ? (
        <StateMessage
          kind="empty"
          message="No channel integrations are available."
        />
      ) : (
        <div className="divide-border divide-y border-t">
          {channels.map((channel: SupportedChannel) => (
            <Row
              key={channel.name}
              title={channel.display_name || channel.name}
              description={
                channel.runtime_note ||
                "Connection and credentials can be configured."
              }
              status={channel.runtime_status}
              icon={<IconBroadcast className="size-4" />}
              action={
                <Button asChild size="sm" variant="outline">
                  <Link to="/channels/$name" params={{ name: channel.name }}>
                    Configure
                  </Link>
                </Button>
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CapabilitiesPage() {
  const queryClient = useQueryClient()
  const skillsQuery = useQuery({
    queryKey: ["plugins", "skills"],
    queryFn: getSkills,
  })
  const toolsQuery = useQuery({
    queryKey: ["plugins", "tools"],
    queryFn: getTools,
  })
  const toolMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setToolEnabled(name, enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugins", "tools"] })
      toast.success("Tool state updated")
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not update tool",
      ),
  })
  const skills = skillsQuery.data?.skills ?? []
  const tools = toolsQuery.data?.tools ?? []
  return (
    <div className="space-y-6">
      <SectionHeading
        title="Skills & Tools"
        description="Installed skills are read-only here; tool enable/disable uses the existing runtime configuration API."
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/agent/skills">Manage skills</Link>
          </Button>
        }
      />
      {skillsQuery.isLoading || toolsQuery.isLoading ? (
        <StateMessage kind="loading" message="Loading skills and tools…" />
      ) : skillsQuery.isError || toolsQuery.isError ? (
        <StateMessage
          kind="error"
          message="Skills or tools data is unavailable."
          onRetry={() => {
            void skillsQuery.refetch()
            void toolsQuery.refetch()
          }}
        />
      ) : (
        <>
          <section>
            <div className="mb-2 flex items-center gap-2">
              <IconPuzzle className="text-muted-foreground size-4" />
              <h3 className="text-sm font-semibold">Installed skills</h3>
            </div>
            {skills.length === 0 ? (
              <div className="text-muted-foreground border border-dashed px-4 py-6 text-sm">
                No installed skills.
              </div>
            ) : (
              <div className="divide-border divide-y border-t">
                {skills.map((skill: SkillSupportItem) => (
                  <Row
                    key={`${skill.source}:${skill.name}`}
                    title={skill.name}
                    description={skill.description || skill.path}
                    status="installed"
                  />
                ))}
              </div>
            )}
          </section>
          <section>
            <div className="mb-2 flex items-center gap-2">
              <IconTool className="text-muted-foreground size-4" />
              <h3 className="text-sm font-semibold">Tools</h3>
            </div>
            {tools.length === 0 ? (
              <div className="text-muted-foreground border border-dashed px-4 py-6 text-sm">
                No tools reported.
              </div>
            ) : (
              <div className="divide-border divide-y border-t">
                {tools.map((tool: ToolSupportItem) => (
                  <Row
                    key={tool.name}
                    title={tool.name}
                    description={tool.description}
                    status={tool.status}
                    action={
                      tool.status !== "blocked" ? (
                        <Switch
                          checked={tool.status === "enabled"}
                          disabled={toolMutation.isPending}
                          onCheckedChange={(enabled) =>
                            toolMutation.mutate({ name: tool.name, enabled })
                          }
                          aria-label={`Enable ${tool.name}`}
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          Blocked
                        </span>
                      )
                    }
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function HealthPage() {
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
    onSuccess: () => toast.success("Restart requested"),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Restart failed"),
  })
  const health = healthQuery.data?.health ?? {}
  const report = reportQuery.data
  const loading =
    healthQuery.isLoading || reportQuery.isLoading || logsQuery.isLoading
  const error = healthQuery.isError || reportQuery.isError || logsQuery.isError
  return (
    <div className="space-y-6">
      <SectionHeading
        title="Health & Logs"
        description="Live plugin health, core service health, and recent gateway logs."
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
              Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => restartMutation.mutate()}
              disabled={restartMutation.isPending}
            >
              <IconRefresh className="size-3.5" />
              Restart
            </Button>
          </div>
        }
      />
      {loading ? (
        <StateMessage kind="loading" message="Loading health and logs…" />
      ) : error ? (
        <StateMessage
          kind="error"
          message="Health data is unavailable."
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
              <h3 className="text-sm font-semibold">Plugins</h3>
            </div>
            <div className="divide-border divide-y border-t">
              {Object.entries(health).length === 0 ? (
                <div className="text-muted-foreground border border-dashed px-4 py-6 text-sm">
                  No plugin health checks reported.
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
              <h3 className="text-sm font-semibold">Services</h3>
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
                  No service health reported.
                </div>
              )}
            </div>
          </section>
          <section>
            <div className="mb-2 flex items-center gap-2">
              <IconClock className="text-muted-foreground size-4" />
              <h3 className="text-sm font-semibold">Recent logs</h3>
            </div>
            <pre className="bg-muted/30 max-h-72 overflow-auto border p-3 font-mono text-xs leading-5">
              {logsQuery.data?.logs?.length
                ? logsQuery.data.logs.slice(-80).join("\n")
                : "No recent logs."}
            </pre>
          </section>
        </>
      )}
    </div>
  )
}

export function PluginsPage({
  section = "catalog",
}: {
  section?: PluginPageSection
}) {
  const meta = PAGE_META[section]
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={`Plugins · ${meta.title}`} titleLevel={1} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
        <div className="mx-auto w-full max-w-5xl space-y-6 pt-2">
          <Link
            to="/plugins"
            className="text-muted-foreground hover:text-foreground mb-5 inline-flex items-center gap-1.5 text-sm"
          >
            <IconArrowLeft className="size-3.5" />
            Plugins
          </Link>
          <div className="pt-1">
            {section === "catalog" && <CatalogPage />}
            {section === "provider" && <ProvidersPage />}
            {section === "core" && <CorePage />}
            {section === "channel" && <ChannelsPage />}
            {section === "capability" && <CapabilitiesPage />}
            {section === "health" && <HealthPage />}
          </div>
        </div>
      </div>
    </div>
  )
}
