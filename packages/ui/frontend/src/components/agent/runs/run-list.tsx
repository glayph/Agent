import { IconSearch } from "@tabler/icons-react"
import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"

import type { AgentRun } from "@/api/agent-runs"
import { EmptyState } from "@/components/minimal-primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

import { formatRunDate } from "./date-format"
import { RunStatusBadge } from "./run-status-badge"
import {
  type AgentRunStatusFilter,
  filterAgentRuns,
  summarizeRun,
} from "./runs-page-model"

const RUNS_PAGE_SIZE = 50

export function RunList({
  runs,
  query,
  statusFilter,
  selectedRunId,
  page,
  onQueryChange,
  onStatusFilterChange,
  onSelectRun,
  onPageChange,
  className,
}: {
  runs: AgentRun[]
  query: string
  statusFilter: AgentRunStatusFilter
  selectedRunId: string | null
  page: number
  onQueryChange: (value: string) => void
  onStatusFilterChange: (value: AgentRunStatusFilter) => void
  onSelectRun: (runId: string) => void
  onPageChange: (page: number) => void
  className?: string
}) {
  const { t } = useTranslation()
  const filteredRuns = filterAgentRuns(runs, query, statusFilter)
  const totalPages = Math.max(
    1,
    Math.ceil(filteredRuns.length / RUNS_PAGE_SIZE),
  )
  const safePage = Math.min(Math.max(page, 1), totalPages)

  useEffect(() => {
    if (page !== safePage) onPageChange(safePage)
  }, [onPageChange, page, safePage])

  const visibleRuns = useMemo(() => {
    const start = (safePage - 1) * RUNS_PAGE_SIZE
    return filteredRuns.slice(start, start + RUNS_PAGE_SIZE)
  }, [filteredRuns, safePage])

  return (
    <aside
      className={cn(
        "border-border bg-card flex min-h-[18rem] flex-col overflow-hidden rounded-lg border xl:min-h-0",
        className,
      )}
    >
      <div className="border-border flex flex-col gap-3 border-b p-3">
        <div className="relative">
          <IconSearch className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("agentRuns.filters.searchPlaceholder")}
            className="h-9 pl-9 text-sm"
            aria-label={t("agentRuns.filters.searchPlaceholder")}
            name="agent_runs_search"
            autoComplete="off"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            onStatusFilterChange(value as AgentRunStatusFilter)
          }
        >
          <SelectTrigger
            size="sm"
            className="w-full"
            aria-label={t("agentRuns.filters.statusLabel")}
          >
            <SelectValue
              placeholder={t("agentRuns.filters.statusPlaceholder")}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">
                {t("agentRuns.filters.allStatuses")}
              </SelectItem>
              <SelectItem value="pending">
                {t("agentRuns.status.pending")}
              </SelectItem>
              <SelectItem value="running">
                {t("agentRuns.status.running")}
              </SelectItem>
              <SelectItem value="completed">
                {t("agentRuns.status.completed")}
              </SelectItem>
              <SelectItem value="failed">
                {t("agentRuns.status.failed")}
              </SelectItem>
              <SelectItem value="skipped">
                {t("agentRuns.status.skipped")}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {filteredRuns.length === 0 ? (
          <EmptyState
            title={t("agentRuns.empty.noMatchesTitle")}
            description={t("agentRuns.empty.noMatchesDescription")}
            className="min-h-[260px]"
          />
        ) : (
          <div className="flex flex-col gap-2">
            {visibleRuns.map((run) => {
              const summary = summarizeRun(run)
              const selected = run.id === selectedRunId
              const updatedAt = formatRunDate(run.updatedAt)
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => onSelectRun(run.id)}
                  data-selected={selected}
                  aria-current={selected ? "true" : undefined}
                  aria-label={t("agentRuns.card.openLabel", {
                    objective: run.objective,
                    status: t(`agentRuns.status.${run.status}`),
                    updated: updatedAt,
                  })}
                  className={cn(
                    "border-border hover:bg-accent flex w-full flex-col gap-2 rounded-md border p-3 text-left transition-colors",
                    selected && "bg-accent text-accent-foreground",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {run.objective}
                      </div>
                      <div className="text-muted-foreground mt-1 truncate text-xs">
                        {run.id}
                      </div>
                    </div>
                    <RunStatusBadge status={run.status} />
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
                    <Badge variant="outline">
                      {t("agentRuns.card.steps", {
                        completed: summary.completedSteps,
                        total: summary.totalSteps,
                      })}
                    </Badge>
                    <Badge variant="outline">
                      {t("agentRuns.card.evidence", {
                        count: summary.evidenceCount,
                      })}
                    </Badge>
                    <span>{updatedAt}</span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
      {filteredRuns.length > RUNS_PAGE_SIZE && (
        <div className="border-border flex items-center justify-between gap-3 border-t p-3">
          <span className="text-muted-foreground text-xs">
            {t("agentRuns.pagination.page", {
              page: safePage,
              total: totalPages,
            })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onPageChange(Math.max(1, safePage - 1))}
              disabled={safePage === 1}
            >
              {t("agentRuns.pagination.previous")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
              disabled={safePage === totalPages}
            >
              {t("agentRuns.pagination.next")}
            </Button>
          </div>
        </div>
      )}
    </aside>
  )
}
