import { IconSearch, IconSettings } from "@tabler/icons-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import type { ToolSupportItem } from "@/api/tools"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

import { ToolStatusBadge } from "./tool-status-badge"
import type { GroupedTools, ToolStatusFilter } from "./types"

const TOOL_LIST_PAGE_SIZE = 80

interface ToolLibraryTabProps {
  allTools: ToolSupportItem[]
  groupedTools: GroupedTools
  totalFilteredCount: number
  searchQuery: string
  statusFilter: ToolStatusFilter
  isLoading: boolean
  hasError: boolean
  pendingToolName: string | null
  onSearchQueryChange: (value: string) => void
  onStatusFilterChange: (value: ToolStatusFilter) => void
  onOpenWebSearchSettings: () => void
  onToggleTool: (name: string, enabled: boolean) => void
}

export function ToolLibraryTab({
  allTools,
  groupedTools,
  totalFilteredCount,
  searchQuery,
  statusFilter,
  isLoading,
  hasError,
  pendingToolName,
  onSearchQueryChange,
  onStatusFilterChange,
  onOpenWebSearchSettings,
  onToggleTool,
}: ToolLibraryTabProps) {
  const { t } = useTranslation()
  const [visibleToolCount, setVisibleToolCount] = useState(TOOL_LIST_PAGE_SIZE)
  const visibleGroupedTools = useMemo<GroupedTools>(() => {
    let remaining = visibleToolCount
    const nextGroups: GroupedTools = []

    for (const [category, items] of groupedTools) {
      if (remaining <= 0) break
      const visibleItems = items.slice(0, remaining)
      if (visibleItems.length) {
        nextGroups.push([category, visibleItems])
        remaining -= visibleItems.length
      }
    }

    return nextGroups
  }, [groupedTools, visibleToolCount])
  const visibleToolTotal = visibleGroupedTools.reduce(
    (total, [, items]) => total + items.length,
    0,
  )
  const hiddenToolCount = Math.max(0, totalFilteredCount - visibleToolTotal)

  useEffect(() => {
    setVisibleToolCount(TOOL_LIST_PAGE_SIZE)
  }, [searchQuery, statusFilter, totalFilteredCount])

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-12 duration-500">
      <div className="flex flex-col gap-6 pt-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="hidden max-w-sm space-y-2 md:block">
          <h1 className="text-foreground/90 text-2xl font-semibold tracking-tight">
            {t("pages.agent.tools.library_title", "Tool Library")}
          </h1>
          <p className="text-muted-foreground/80 text-[14px] leading-relaxed">
            {t(
              "pages.agent.tools.library_description",
              "Browse and manage the toolset available to your AI agents.",
            )}
          </p>
        </div>

        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center md:w-auto">
          <div className="group relative flex-1 md:w-80">
            <IconSearch className="text-muted-foreground/60 group-focus-within:text-foreground/80 absolute top-1/2 left-3.5 size-4 -translate-y-1/2 transition-colors" />
            <Input
              type="text"
              aria-label={t(
                "pages.agent.tools.search_placeholder",
                "Search tools…",
              )}
              name="tool_library_search"
              autoComplete="off"
              placeholder={t(
                "pages.agent.tools.search_placeholder",
                "Search tools…",
              )}
              className="bg-muted/40 hover:bg-muted/60 focus-visible:bg-background focus-visible:border-border/80 focus-visible:ring-foreground/5 h-11 w-full rounded-xl border-transparent pl-10 shadow-none transition-[background-color,border-color,box-shadow] duration-300"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
            />
          </div>

          <Select
            value={statusFilter}
            onValueChange={(value) =>
              onStatusFilterChange(value as ToolStatusFilter)
            }
          >
            <SelectTrigger className="bg-muted/40 hover:bg-muted/60 focus:ring-foreground/5 focus:border-border/80 h-11 w-full rounded-xl border-transparent shadow-none transition-[background-color,border-color,box-shadow] duration-300 sm:w-36">
              <SelectValue
                placeholder={t("pages.agent.tools.filter.all", "All Status")}
              />
            </SelectTrigger>
            <SelectContent className="border-border/40 rounded-xl shadow-lg">
              <SelectItem value="all">
                {t("pages.agent.tools.filter.all", "All Status")}
              </SelectItem>
              <SelectItem value="enabled">
                {t("pages.agent.tools.filter.enabled", "Enabled")}
              </SelectItem>
              <SelectItem value="disabled">
                {t("pages.agent.tools.filter.disabled", "Disabled")}
              </SelectItem>
              <SelectItem value="blocked">
                {t("pages.agent.tools.filter.blocked", "Blocked")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {hasError ? (
        <div className="py-20 text-center">
          <p className="text-destructive font-medium">
            {t("pages.agent.load_error", "Failed to load tools")}
          </p>
        </div>
      ) : isLoading ? (
        <LibraryLoadingState />
      ) : totalFilteredCount === 0 ? (
        <LibraryEmptyState allToolsCount={allTools.length} />
      ) : (
        <div className="space-y-12">
          {visibleGroupedTools.map(([category, items]) => (
            <section key={category} className="space-y-6">
              <div className="flex items-center">
                <h3 className="text-foreground/90 text-lg font-semibold tracking-tight capitalize">
                  {t(`pages.agent.tools.categories.${category}`, category)}
                </h3>
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                {items.map((tool) => (
                  <ToolCard
                    key={tool.name}
                    tool={tool}
                    isPending={pendingToolName === tool.name}
                    onOpenWebSearchSettings={onOpenWebSearchSettings}
                    onToggleTool={onToggleTool}
                  />
                ))}
              </div>
            </section>
          ))}
          {hiddenToolCount > 0 && (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setVisibleToolCount((current) =>
                    Math.min(totalFilteredCount, current + TOOL_LIST_PAGE_SIZE),
                  )
                }
              >
                {t("common.showMore", { count: hiddenToolCount })}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ToolCard({
  tool,
  isPending,
  onOpenWebSearchSettings,
  onToggleTool,
}: {
  tool: ToolSupportItem
  isPending: boolean
  onOpenWebSearchSettings: () => void
  onToggleTool: (name: string, enabled: boolean) => void
}) {
  const { t } = useTranslation()
  const reasonText = tool.reason_code
    ? t(`pages.agent.tools.reasons.${tool.reason_code}`)
    : ""
  const isEnabled = tool.status === "enabled"
  const isConfiguredOn = tool.config_enabled ?? tool.status !== "disabled"
  const isDisabled = tool.status === "disabled"
  const isBlocked = tool.status === "blocked"
  const isWebSearchTool = tool.name === "web_search"
  const switchLabel = isConfiguredOn
    ? t("pages.agent.tools.disable_tool_label", {
        defaultValue: "Disable {{name}}",
        name: tool.name,
      })
    : t("pages.agent.tools.enable_tool_label", {
        defaultValue: "Enable {{name}}",
        name: tool.name,
      })
  const switchTitle =
    isBlocked && reasonText
      ? t("pages.agent.tools.blocked_switch_title", {
          defaultValue: "{{name}} is configured on but blocked: {{reason}}",
          name: tool.name,
          reason: reasonText,
        })
      : switchLabel

  return (
    <Card
      className={cn(
        "group bg-card border-border/40 flex flex-col shadow-none transition-[background-color,border-color,box-shadow,opacity,transform] duration-300 sm:rounded-2xl",
        isBlocked
          ? "border-amber-500/30 bg-amber-50/20 dark:border-amber-900/40 dark:bg-amber-950/20"
          : "hover:border-border/80 hover:-translate-y-[2px] hover:shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] dark:hover:shadow-[0_4px_20px_-4px_rgba(255,255,255,0.02)]",
        isDisabled && "opacity-[0.80] hover:opacity-100",
      )}
    >
      <CardContent className="flex h-full flex-col px-5 py-1">
        <div className="mb-0.5 flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <h4 className="text-foreground/90 min-w-0 font-mono text-sm font-semibold tracking-tight break-all">
              {tool.name}
            </h4>
            <ToolStatusBadge status={tool.status} />
            {tool.risk && (
              <Badge
                variant={tool.risk.level === "high" ? "destructive" : "outline"}
                title={tool.risk.reason}
              >
                {tool.risk.label}
              </Badge>
            )}
          </div>
          <div className="flex h-8 shrink-0 items-center gap-2">
            {isWebSearchTool && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onOpenWebSearchSettings}
                className="text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 rounded-lg"
                aria-label={t(
                  "pages.agent.tools.web_search.open_settings",
                  "Open Settings",
                )}
              >
                <IconSettings className="size-4" />
              </Button>
            )}
            <Switch
              checked={isConfiguredOn}
              disabled={isPending}
              onCheckedChange={(checked) => onToggleTool(tool.name, checked)}
              aria-label={switchLabel}
              title={switchTitle}
              className={cn(
                "shrink-0",
                isEnabled && "shadow-xs ring-1 ring-emerald-500/20",
                isBlocked &&
                  isConfiguredOn &&
                  "shadow-xs ring-1 ring-amber-500/30 data-checked:bg-amber-500",
              )}
            />
          </div>
        </div>

        <p className="text-muted-foreground/80 flex-1 text-[14px] leading-relaxed">
          {tool.description}
        </p>

        {reasonText && (
          <div className="border-border/40 mt-4 border-t pt-4">
            <div className="inline-flex rounded-lg border border-amber-200/50 bg-amber-50/80 px-3 py-2 text-[13px] font-medium text-amber-600 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400">
              {reasonText}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function LibraryLoadingState() {
  return (
    <div className="space-y-12">
      {[1, 2].map((groupIndex) => (
        <div key={groupIndex} className="space-y-6">
          <Skeleton className="h-6 w-32 rounded-md" />
          <div className="grid gap-5 lg:grid-cols-2">
            {[1, 2].map((itemIndex) => (
              <Skeleton key={itemIndex} className="h-36 rounded-2xl" />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function LibraryEmptyState({ allToolsCount }: { allToolsCount: number }) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center py-32 text-center">
      <div className="bg-muted/30 ring-border/10 mb-6 rounded-full p-6 shadow-xs ring-1">
        <IconSearch className="text-muted-foreground/60 size-10" />
      </div>
      <h3 className="text-foreground/80 mb-2 text-xl font-semibold tracking-tight">
        {allToolsCount === 0
          ? t("pages.agent.tools.empty", "No tools found")
          : t("pages.agent.tools.no_results", "No matching tools")}
      </h3>
      {allToolsCount !== 0 && (
        <p className="text-muted-foreground text-sm">
          Try adjusting your search criteria or status filters.
        </p>
      )}
    </div>
  )
}
