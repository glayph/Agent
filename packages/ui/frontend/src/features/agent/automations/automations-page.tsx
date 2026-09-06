import {
  IconActivity,
  IconArrowRight,
  IconCalendarEvent,
  IconClock,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconShieldCheck,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useSearch } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"

import {
  type AutomationDefinition,
  type AutomationTarget,
  automationAction,
  listAutomationExecutions,
  listAutomations,
  runAutomationNow,
} from "@/api/automations"
import { PageHeader } from "@/app/layout/page-header"
import { cn } from "@/lib/utils"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card"

import {
  AutomationCenterNav,
  AutomationCenterSectionHeader,
} from "./automation-center-nav"

const targetLabels: Record<AutomationTarget, string> = {
  internal: "Internal task",
  research: "Research",
  facebook: "Facebook Page",
  youtube: "YouTube",
}

const statusStyles: Record<AutomationDefinition["status"], string> = {
  active:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  paused:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  disabled: "border-muted bg-muted text-muted-foreground",
}

function formatDate(value?: number): string {
  if (!value) return "Not scheduled"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function formatExecutionStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

export function AutomationsPage() {
  const queryClient = useQueryClient()
  const { automationId } = useSearch({ from: "/agent/automations/list" })
  const [selectedId, setSelectedId] = useState<string | null>(
    automationId ?? null,
  )
  const [error, setError] = useState<string | null>(null)

  const automationsQuery = useQuery({
    queryKey: ["automations"],
    queryFn: () => listAutomations(),
    refetchInterval: 15_000,
  })
  const automations = useMemo(
    () => automationsQuery.data?.automations ?? [],
    [automationsQuery.data?.automations],
  )
  const selected = useMemo(
    () =>
      automations.find((automation) => automation.id === selectedId) ??
      automations[0] ??
      null,
    [automations, selectedId],
  )
  const activeCount = automations.filter(
    (automation) => automation.status === "active",
  ).length
  const pausedCount = automations.filter(
    (automation) => automation.status === "paused",
  ).length

  const executionsQuery = useQuery({
    queryKey: ["automation-executions", selected?.id],
    queryFn: () => listAutomationExecutions(selected!.id),
    enabled: Boolean(selected?.id),
    refetchInterval: 10_000,
  })

  useEffect(() => {
    if (
      automationId &&
      automations.some((automation) => automation.id === automationId)
    ) {
      setSelectedId(automationId)
      return
    }
    if (!selectedId && automations[0]) setSelectedId(automations[0].id)
  }, [automationId, automations, selectedId])

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["automations"] })
    await queryClient.invalidateQueries({ queryKey: ["automation-executions"] })
  }

  const actionMutation = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string
      action: "pause" | "resume" | "cancel"
    }) => automationAction(id, action),
    onSuccess: invalidate,
    onError: (mutationError: Error) => setError(mutationError.message),
  })
  const runNowMutation = useMutation({
    mutationFn: runAutomationNow,
    onSuccess: invalidate,
    onError: (mutationError: Error) => setError(mutationError.message),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Automation Center"
        titleExtra={
          <Badge variant="outline" className="gap-1.5">
            <IconClock className="size-3" />
            {automations.length} configured
          </Badge>
        }
      >
        <Button asChild variant="outline" size="sm">
          <Link
            to="/agent/automations/history"
            search={{ automationId: undefined }}
          >
            <IconActivity className="size-4" />
            History
          </Link>
        </Button>
        <Button asChild size="sm">
          <Link
            to="/agent/automations/create"
            search={{ automationId: undefined }}
          >
            New automation
          </Link>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void invalidate()}
          disabled={automationsQuery.isFetching}
        >
          <IconRefresh
            className={cn(
              "size-4",
              automationsQuery.isFetching && "animate-spin",
            )}
          />
          Refresh
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-7xl space-y-6">
          <AutomationCenterNav />
          <AutomationCenterSectionHeader
            eyebrow="Automation workspace"
            title="See what Miki is running"
            description="Manage schedules from one place, then open history when you need evidence from a specific execution."
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-muted-foreground text-xs">Configured</p>
                <p className="mt-1 text-2xl font-semibold">
                  {automations.length}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  All saved workflows
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-muted-foreground text-xs">
                  Active schedules
                </p>
                <p className="mt-1 text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
                  {activeCount}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Ready to create linked Runs
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-muted-foreground text-xs">
                  Paused for review
                </p>
                <p className="mt-1 text-2xl font-semibold text-amber-600 dark:text-amber-400">
                  {pausedCount}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Needs operator attention
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(280px,0.72fr)_minmax(0,1.45fr)]">
            <Card className="overflow-hidden">
              <CardHeader className="border-b pb-4">
                <CardTitle className="text-base">Your automations</CardTitle>
                <CardDescription>
                  Choose a workflow to inspect its schedule and actions.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-2">
                {automationsQuery.isLoading ? (
                  <div className="text-muted-foreground p-6 text-sm">
                    Loading automations…
                  </div>
                ) : automations.length === 0 ? (
                  <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
                    <IconCalendarEvent className="text-muted-foreground mb-3 size-8" />
                    <p className="font-medium">No automations yet</p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      Create a repeatable research or agent workflow.
                    </p>
                    <Button asChild className="mt-4" size="sm">
                      <Link
                        to="/agent/automations/create"
                        search={{ automationId: undefined }}
                      >
                        Create one
                      </Link>
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {automations.map((automation) => (
                      <button
                        key={automation.id}
                        type="button"
                        onClick={() => setSelectedId(automation.id)}
                        className={cn(
                          "hover:bg-accent w-full rounded-lg border border-transparent p-3 text-left transition-colors",
                          selected?.id === automation.id &&
                            "border-border bg-accent",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="line-clamp-2 text-sm font-medium">
                            {automation.name}
                          </span>
                          <Badge
                            variant="outline"
                            className={cn(
                              "shrink-0 text-[10px]",
                              statusStyles[automation.status],
                            )}
                          >
                            {automation.status}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                          {automation.objective}
                        </p>
                        <div className="text-muted-foreground mt-3 flex items-center justify-between text-[11px]">
                          <span>{targetLabels[automation.target]}</span>
                          <span>{formatDate(automation.nextRunAt)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {selected ? (
              <Card>
                <CardHeader className="gap-4 border-b sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-xl">{selected.name}</CardTitle>
                      <Badge
                        variant="outline"
                        className={statusStyles[selected.status]}
                      >
                        {selected.status}
                      </Badge>
                      <Badge variant="secondary">
                        {targetLabels[selected.target]}
                      </Badge>
                    </div>
                    <CardDescription className="mt-2 max-w-2xl">
                      {selected.objective}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="outline">
                      <Link
                        to="/agent/automations/create"
                        search={{ automationId: selected.id }}
                      >
                        <IconPencil className="size-4" /> Edit
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => runNowMutation.mutate(selected.id)}
                      disabled={
                        runNowMutation.isPending ||
                        selected.status !== "active" ||
                        selected.target === "facebook" ||
                        selected.target === "youtube"
                      }
                    >
                      <IconPlayerPlay className="size-4" /> Run now
                    </Button>
                    {selected.status === "active" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          actionMutation.mutate({
                            id: selected.id,
                            action: "pause",
                          })
                        }
                      >
                        <IconPlayerPause className="size-4" /> Pause
                      </Button>
                    ) : selected.status === "paused" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          actionMutation.mutate({
                            id: selected.id,
                            action: "resume",
                          })
                        }
                      >
                        <IconPlayerPlay className="size-4" /> Resume
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() =>
                        actionMutation.mutate({
                          id: selected.id,
                          action: "cancel",
                        })
                      }
                      disabled={selected.status === "disabled"}
                    >
                      <IconTrash className="size-4" /> Disable
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="bg-muted/20 rounded-lg border p-3">
                      <p className="text-muted-foreground text-xs">Schedule</p>
                      <p className="mt-1 text-sm font-medium">
                        {selected.cronExpression || "One-time run"}
                      </p>
                    </div>
                    <div className="bg-muted/20 rounded-lg border p-3">
                      <p className="text-muted-foreground text-xs">Next run</p>
                      <p className="mt-1 text-sm font-medium">
                        {formatDate(selected.nextRunAt)}
                      </p>
                    </div>
                    <div className="bg-muted/20 rounded-lg border p-3">
                      <p className="text-muted-foreground text-xs">Approval</p>
                      <p className="mt-1 flex items-center gap-1.5 text-sm font-medium">
                        <IconShieldCheck className="text-primary size-4" />{" "}
                        {selected.approvalMode}
                      </p>
                    </div>
                  </div>

                  <div className="bg-muted/20 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                    <div>
                      <p className="text-sm font-medium">Need more evidence?</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        Open the dedicated history view for all linked
                        executions.
                      </p>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <Link
                        to="/agent/automations/history"
                        search={{ automationId: selected.id }}
                      >
                        <IconArrowRight className="size-4" /> View history
                      </Link>
                    </Button>
                  </div>

                  <div>
                    <h3 className="mb-2 text-sm font-semibold">
                      Execution steps
                    </h3>
                    <ol className="space-y-2">
                      {selected.steps.map((step, index) => (
                        <li
                          key={`${selected.id}-${index}`}
                          className="flex items-start gap-3 rounded-lg border p-3 text-sm"
                        >
                          <span className="bg-primary/10 text-primary flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                            {index + 1}
                          </span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>

                  {executionsQuery.data?.executions[0] && (
                    <div className="rounded-lg border p-4">
                      <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                        Latest execution
                      </p>
                      <p className="mt-1 text-sm font-medium">
                        {formatExecutionStatus(
                          executionsQuery.data.executions[0].status,
                        )}{" "}
                        · {executionsQuery.data.executions[0].trigger}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {formatDate(
                          executionsQuery.data.executions[0].createdAt,
                        )}{" "}
                        · Run{" "}
                        {executionsQuery.data.executions[0].runId.slice(0, 8)}
                      </p>
                    </div>
                  )}

                  {(selected.target === "facebook" ||
                    selected.target === "youtube") && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                      This target is currently metadata-only. Configure a real
                      platform adapter before running or publishing.
                    </div>
                  )}
                  {error && (
                    <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border p-3 text-sm">
                      <IconX className="size-4" /> {error}
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card className="flex min-h-[420px] items-center justify-center">
                <CardContent className="text-center">
                  <IconCalendarEvent className="text-muted-foreground mx-auto mb-3 size-10" />
                  <p className="font-medium">
                    Choose an automation to inspect it
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Schedules, approval rules, steps, and linked Runs will
                    appear here.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
