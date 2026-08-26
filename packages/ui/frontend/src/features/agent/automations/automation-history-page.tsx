import {
  IconArrowLeft,
  IconExternalLink,
  IconRefresh,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { Link, useSearch } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"

import { listAutomationExecutions, listAutomations } from "@/api/automations"
import { PageHeader } from "@/app/layout/page-header"
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

function formatDate(value?: number): string {
  if (!value) return "Not available"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function statusClass(status: string): string {
  if (status === "completed")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  if (status === "failed")
    return "border-destructive/30 bg-destructive/10 text-destructive"
  return "border-primary/30 bg-primary/10 text-primary"
}

export function AutomationHistoryPage() {
  const { automationId } = useSearch({ from: "/agent/automations/history" })
  const [selectedId, setSelectedId] = useState<string | null>(
    automationId ?? null,
  )
  const automationsQuery = useQuery({
    queryKey: ["automations"],
    queryFn: () => listAutomations(),
    refetchInterval: 15_000,
  })
  const automations = useMemo(
    () => automationsQuery.data?.automations ?? [],
    [automationsQuery.data?.automations],
  )
  const selected =
    automations.find((automation) => automation.id === selectedId) ??
    automations[0] ??
    null
  const executionsQuery = useQuery({
    queryKey: ["automation-executions", "history", selected?.id],
    queryFn: () => listAutomationExecutions(selected!.id, 100),
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Execution history">
        <Button asChild variant="outline" size="sm">
          <Link to="/agent/automations">
            <IconArrowLeft className="size-4" /> Overview
          </Link>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void executionsQuery.refetch()}
          disabled={executionsQuery.isFetching}
        >
          <IconRefresh
            className={
              executionsQuery.isFetching ? "size-4 animate-spin" : "size-4"
            }
          />
          Refresh
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <AutomationCenterNav />
          <AutomationCenterSectionHeader
            eyebrow="Evidence and Runs"
            title="Understand what happened"
            description="Review each linked execution independently from its schedule configuration."
          />

          <Card>
            <CardHeader className="gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <CardTitle className="text-base">
                  Choose an automation
                </CardTitle>
                <CardDescription>
                  Execution history is retained per automation so the timeline
                  stays easy to scan.
                </CardDescription>
              </div>
              <select
                className="bg-background h-9 w-full rounded-md border px-3 text-sm sm:w-80"
                value={selected?.id ?? ""}
                onChange={(event) => setSelectedId(event.target.value)}
                disabled={automationsQuery.isLoading}
              >
                {automations.length === 0 ? (
                  <option value="">No automations available</option>
                ) : (
                  automations.map((automation) => (
                    <option key={automation.id} value={automation.id}>
                      {automation.name}
                    </option>
                  ))
                )}
              </select>
            </CardHeader>
          </Card>

          {selected ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">{selected.name}</CardTitle>
                    <CardDescription className="mt-1">
                      {selected.objective}
                    </CardDescription>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to="/agent/automations/list"
                      search={{ automationId: selected.id }}
                    >
                      View automation <IconExternalLink className="size-4" />
                    </Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {executionsQuery.isLoading ? (
                  <p className="text-muted-foreground py-8 text-sm">
                    Loading execution history…
                  </p>
                ) : executionsQuery.data?.executions.length ? (
                  <div className="space-y-3">
                    {executionsQuery.data.executions.map((execution) => (
                      <div
                        key={execution.id}
                        className="flex flex-col gap-3 rounded-xl border p-4 md:flex-row md:items-center md:justify-between"
                      >
                        <div className="flex items-start gap-3">
                          <span
                            className={
                              execution.status === "completed"
                                ? "mt-1.5 size-2.5 rounded-full bg-emerald-500"
                                : execution.status === "failed"
                                  ? "bg-destructive mt-1.5 size-2.5 rounded-full"
                                  : "bg-primary mt-1.5 size-2.5 rounded-full"
                            }
                          />
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium">
                                {execution.status.charAt(0).toUpperCase() +
                                  execution.status.slice(1)}
                              </p>
                              <Badge
                                variant="outline"
                                className={statusClass(execution.status)}
                              >
                                {execution.trigger}
                              </Badge>
                            </div>
                            <p className="text-muted-foreground mt-1 text-xs">
                              {formatDate(execution.createdAt)} · Run{" "}
                              {execution.runId.slice(0, 8)}
                            </p>
                            {execution.error && (
                              <p className="text-destructive mt-2 text-xs">
                                {execution.error}
                              </p>
                            )}
                          </div>
                        </div>
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            to="/agent/runs"
                            search={{
                              q: "",
                              status: "all",
                              run: execution.runId,
                              step: "",
                              page: 1,
                            }}
                          >
                            Open Runs <IconExternalLink className="size-4" />
                          </Link>
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed p-10 text-center">
                    <p className="font-medium">No executions yet</p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      Open Automations to run this workflow and create its first
                      linked Run.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="text-muted-foreground py-12 text-center text-sm">
                Create an automation first to start collecting execution
                evidence.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
