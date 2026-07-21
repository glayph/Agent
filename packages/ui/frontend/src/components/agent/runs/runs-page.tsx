import {
  IconDatabaseExport,
  IconPlus,
  IconRefresh,
  IconRepeat,
  IconTimeline,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  type AgentRun,
  type CreateAgentRunPayload,
  createAgentRun,
  exportAgentRun,
  getAgentRun,
  listAgentRuns,
} from "@/api/agent-runs"
import { EmptyState } from "@/components/minimal-primitives"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

import { CreateRunDialog } from "./create-run-dialog"
import { formatRunDate } from "./date-format"
import { RunList } from "./run-list"
import { RunStatusBadge } from "./run-status-badge"
import {
  type AgentRunStatusFilter,
  type AgentRunsSearchState,
  buildReplayRunPayload,
  filterAgentRuns,
  resolveSelectedStep,
  summarizeRun,
} from "./runs-page-model"
import { StepEvidencePanel } from "./step-evidence-panel"
import { TaskGraph } from "./task-graph"

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function SummaryTile({
  label,
  value,
}: {
  label: string
  value: string | number
}) {
  return (
    <div className="border-border bg-card rounded-lg border p-4">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  )
}

function TraceSummaryPanel({ run }: { run: AgentRun }) {
  const { t } = useTranslation()
  const timeline = run.timeline?.slice(-6).reverse() ?? []
  const contextDetails = {
    ...(run.contextBudget ? { contextBudget: run.contextBudget } : {}),
    ...(run.retrievalDiagnostics
      ? { retrievalDiagnostics: run.retrievalDiagnostics }
      : {}),
  }

  if (timeline.length === 0 && Object.keys(contextDetails).length === 0) {
    return null
  }

  return (
    <section className="border-border bg-card rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t("agentRuns.trace.title")}</h3>
        <Badge variant="outline">
          {t("agentRuns.trace.events", { count: timeline.length })}
        </Badge>
      </div>
      {timeline.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {timeline.map((event) => (
            <div
              key={event.id}
              className="border-border flex items-start justify-between gap-3 rounded-md border p-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {event.phase && (
                    <Badge variant="secondary">{event.phase}</Badge>
                  )}
                  <Badge variant="outline">{event.source}</Badge>
                  {event.ok === false && (
                    <Badge variant="destructive">
                      {t("agentRuns.status.failed")}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-sm">{event.summary}</p>
              </div>
              <span className="text-muted-foreground shrink-0 text-xs">
                {formatRunDate(event.at)}
              </span>
            </div>
          ))}
        </div>
      )}
      {Object.keys(contextDetails).length > 0 && (
        <pre className="bg-muted text-muted-foreground mt-3 max-h-48 overflow-auto rounded-md p-3 text-xs leading-5">
          {JSON.stringify(contextDetails, null, 2)}
        </pre>
      )}
    </section>
  )
}

export function RunsPage({
  search,
  onSearchChange,
}: {
  search: AgentRunsSearchState
  onSearchChange: (patch: Partial<AgentRunsSearchState>) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{
    kind: "success" | "error"
    text: string
  } | null>(null)
  const query = search.q
  const statusFilter: AgentRunStatusFilter = search.status
  const selectedRunId = search.run || null
  const selectedStepId = search.step || null

  const runsQuery = useQuery({
    queryKey: ["agent-runs"],
    queryFn: () => listAgentRuns(100),
  })

  const runs = useMemo(() => runsQuery.data?.runs ?? [], [runsQuery.data?.runs])
  const filteredRuns = useMemo(
    () => filterAgentRuns(runs, query, statusFilter),
    [query, runs, statusFilter],
  )

  useEffect(() => {
    if (runsQuery.isLoading || runsQuery.isError) return

    const currentVisible =
      selectedRunId !== null &&
      filteredRuns.some((run) => run.id === selectedRunId)
    if (!currentVisible) {
      const nextRunId = filteredRuns[0]?.id ?? ""
      if (search.run !== nextRunId || search.step !== "") {
        onSearchChange({
          run: nextRunId,
          step: "",
        })
      }
    }
  }, [
    filteredRuns,
    onSearchChange,
    runsQuery.isError,
    runsQuery.isLoading,
    search.run,
    search.step,
    selectedRunId,
  ])

  const selectedRunQuery = useQuery({
    queryKey: ["agent-runs", selectedRunId],
    queryFn: () => getAgentRun(selectedRunId!),
    enabled: selectedRunId !== null,
  })

  const selectedRun =
    selectedRunQuery.data?.run ??
    runs.find((run) => run.id === selectedRunId) ??
    null
  const selectedStep = resolveSelectedStep(selectedRun, selectedStepId)
  const selectedSummary = selectedRun ? summarizeRun(selectedRun) : null

  useEffect(() => {
    if (!selectedRun && (runsQuery.isLoading || runsQuery.isError)) return

    const nextStepId = selectedStep?.id ?? null
    if (nextStepId !== selectedStepId) {
      onSearchChange({
        step: nextStepId ?? "",
      })
    }
  }, [
    onSearchChange,
    runsQuery.isError,
    runsQuery.isLoading,
    selectedRun,
    selectedStep,
    selectedStepId,
  ])

  const createRunMutation = useMutation({
    mutationFn: (payload: CreateAgentRunPayload) => createAgentRun(payload),
    onSuccess: async ({ run }) => {
      queryClient.setQueryData<{ runs: AgentRun[] }>(
        ["agent-runs"],
        (current) => ({
          runs: [
            run,
            ...(current?.runs.filter((item) => item.id !== run.id) ?? []),
          ],
        }),
      )
      queryClient.setQueryData(["agent-runs", run.id], { run })
      onSearchChange({
        q: "",
        status: "all",
        run: run.id,
        step: run.steps[0]?.id ?? "",
        page: 1,
      })
      setCreateDialogOpen(false)
      await queryClient.invalidateQueries({ queryKey: ["agent-runs"] })
      const message = t("agentRuns.toast.created")
      setStatusMessage({ kind: "success", text: message })
      toast.success(message)
    },
    onError: (error) => {
      const message =
        error instanceof Error
          ? error.message
          : t("agentRuns.toast.createFailed")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    },
  })

  const replayRunMutation = useMutation({
    mutationFn: (run: AgentRun) => createAgentRun(buildReplayRunPayload(run)),
    onSuccess: async ({ run }) => {
      queryClient.setQueryData<{ runs: AgentRun[] }>(
        ["agent-runs"],
        (current) => ({
          runs: [
            run,
            ...(current?.runs.filter((item) => item.id !== run.id) ?? []),
          ],
        }),
      )
      queryClient.setQueryData(["agent-runs", run.id], { run })
      onSearchChange({
        q: "",
        status: "all",
        run: run.id,
        step: run.steps[0]?.id ?? "",
        page: 1,
      })
      await queryClient.invalidateQueries({ queryKey: ["agent-runs"] })
      const message = t("agentRuns.toast.replayCreated")
      setStatusMessage({ kind: "success", text: message })
      toast.success(message)
    },
    onError: (error) => {
      const message =
        error instanceof Error
          ? error.message
          : t("agentRuns.toast.replayFailed")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    },
  })

  const exportRunMutation = useMutation({
    mutationFn: exportAgentRun,
    onSuccess: (bundle) => {
      downloadJson(`agent-run-${bundle.run.id}.json`, bundle)
      const message = t("agentRuns.toast.exported")
      setStatusMessage({ kind: "success", text: message })
      toast.success(message)
    },
    onError: (error) => {
      const message =
        error instanceof Error
          ? error.message
          : t("agentRuns.toast.exportFailed")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    },
  })

  const isLoading = runsQuery.isLoading && runs.length === 0

  return (
    <div className="bg-background flex h-full flex-col">
      <PageHeader
        title={t("navigation.runs", "Runs")}
        titleExtra={
          selectedRun && <RunStatusBadge status={selectedRun.status} />
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runsQuery.refetch()}
          disabled={runsQuery.isFetching}
          className="max-sm:size-8 max-sm:gap-0 max-sm:rounded-full max-sm:px-0"
          aria-label={t("agentRuns.actions.refresh")}
          title={t("agentRuns.actions.refresh")}
        >
          <IconRefresh data-icon="inline-start" />
          <span className="max-sm:hidden">{t("common.refresh")}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            selectedRunId && exportRunMutation.mutate(selectedRunId)
          }
          disabled={!selectedRunId || exportRunMutation.isPending}
          className="max-sm:size-8 max-sm:gap-0 max-sm:rounded-full max-sm:px-0"
          aria-label={t("agentRuns.actions.export")}
          title={t("agentRuns.actions.export")}
        >
          <IconDatabaseExport data-icon="inline-start" />
          <span className="max-sm:hidden">{t("common.export")}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => selectedRun && replayRunMutation.mutate(selectedRun)}
          disabled={!selectedRun || replayRunMutation.isPending}
          className="max-sm:size-8 max-sm:gap-0 max-sm:rounded-full max-sm:px-0"
          aria-label={t("agentRuns.actions.replay")}
          title={t("agentRuns.actions.replay")}
        >
          <IconRepeat data-icon="inline-start" />
          <span className="max-sm:hidden">
            {t("agentRuns.actions.replayShort")}
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCreateDialogOpen(true)}
          disabled={createRunMutation.isPending}
          className="max-sm:size-8 max-sm:gap-0 max-sm:rounded-full max-sm:px-0"
          aria-label={t("agentRuns.actions.create")}
          title={t("agentRuns.actions.create")}
        >
          <IconPlus data-icon="inline-start" />
          <span className="max-sm:hidden">{t("agentRuns.actions.newRun")}</span>
        </Button>
      </PageHeader>

      <CreateRunDialog
        open={createDialogOpen}
        isCreating={createRunMutation.isPending}
        onOpenChange={setCreateDialogOpen}
        onCreate={(payload) => createRunMutation.mutate(payload)}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 xl:overflow-hidden">
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

        {isLoading ? (
          <div className="grid h-full gap-4 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)_380px]">
            <Skeleton className="h-full min-h-[520px] rounded-lg" />
            <Skeleton className="h-full min-h-[520px] rounded-lg" />
            <Skeleton className="hidden h-full min-h-[520px] rounded-lg xl:block" />
          </div>
        ) : runsQuery.error ? (
          <EmptyState
            icon={<IconTimeline />}
            title={t("agentRuns.empty.loadFailedTitle")}
            description={
              runsQuery.error instanceof Error
                ? runsQuery.error.message
                : t("agentRuns.empty.loadFailedDescription")
            }
            action={
              <Button
                variant="outline"
                onClick={() => void runsQuery.refetch()}
              >
                <IconRefresh data-icon="inline-start" />
                {t("models.retry")}
              </Button>
            }
          />
        ) : runs.length === 0 ? (
          <EmptyState
            icon={<IconTimeline />}
            title={t("agentRuns.empty.noneTitle")}
            description={t("agentRuns.empty.noneDescription")}
            action={
              <Button
                variant="outline"
                onClick={() => setCreateDialogOpen(true)}
                disabled={createRunMutation.isPending}
              >
                <IconPlus data-icon="inline-start" />
                {t("agentRuns.actions.createManual")}
              </Button>
            }
          />
        ) : (
          <div className="flex min-h-full flex-col gap-4 xl:grid xl:h-full xl:min-h-0 xl:grid-cols-[340px_minmax(0,1fr)_380px]">
            <RunList
              runs={runs}
              query={query}
              statusFilter={statusFilter}
              selectedRunId={selectedRunId}
              page={search.page}
              onQueryChange={(value) =>
                onSearchChange({
                  q: value,
                  run: "",
                  step: "",
                  page: 1,
                })
              }
              onStatusFilterChange={(value) =>
                onSearchChange({
                  status: value,
                  run: "",
                  step: "",
                  page: 1,
                })
              }
              onSelectRun={(runId) => {
                onSearchChange({
                  run: runId,
                  step: "",
                })
              }}
              onPageChange={(page) => onSearchChange({ page })}
              className="max-h-[32rem] xl:h-full xl:max-h-none"
            />

            <main className="min-h-0 xl:overflow-y-auto">
              {selectedRun && selectedSummary ? (
                <div className="flex min-h-full flex-col gap-4">
                  <section className="border-border bg-card rounded-lg border p-4">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <h2 className="truncate text-base font-semibold">
                          {selectedRun.objective}
                        </h2>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {t("agentRuns.meta.createdUpdated", {
                            created: formatRunDate(selectedRun.createdAt),
                            updated: formatRunDate(selectedRun.updatedAt),
                          })}
                        </p>
                      </div>
                      <RunStatusBadge status={selectedRun.status} />
                    </div>
                  </section>

                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <SummaryTile
                      label={t("agentRuns.summary.completed")}
                      value={`${selectedSummary.completedSteps}/${selectedSummary.totalSteps}`}
                    />
                    <SummaryTile
                      label={t("agentRuns.summary.running")}
                      value={selectedSummary.runningSteps}
                    />
                    <SummaryTile
                      label={t("agentRuns.summary.failed")}
                      value={selectedSummary.failedSteps}
                    />
                    <SummaryTile
                      label={t("agentRuns.summary.evidence")}
                      value={selectedSummary.evidenceCount}
                    />
                  </div>

                  <TaskGraph
                    run={selectedRun}
                    selectedStepId={selectedStep?.id ?? null}
                    onSelectStep={(step) => onSearchChange({ step })}
                    className="xl:flex-1"
                  />

                  <TraceSummaryPanel run={selectedRun} />
                </div>
              ) : (
                <EmptyState
                  title={t("agentRuns.empty.noSelectionTitle")}
                  description={t("agentRuns.empty.noSelectionDescription")}
                />
              )}
            </main>

            <div className="hidden min-h-0 xl:block">
              <StepEvidencePanel step={selectedStep} className="h-full" />
            </div>
            <div className="xl:hidden">
              <StepEvidencePanel
                step={selectedStep}
                className="min-h-[22rem]"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
