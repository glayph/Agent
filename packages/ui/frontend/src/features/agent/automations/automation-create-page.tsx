import {
  IconArrowLeft,
  IconCheck,
  IconClock,
  IconShieldCheck,
} from "@tabler/icons-react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"

import {
  type AutomationApprovalMode,
  type AutomationTarget,
  createAutomation,
  getAutomation,
  updateAutomation,
} from "@/api/automations"
import { PageHeader } from "@/app/layout/page-header"
import { Button } from "@/shared/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card"
import { Input } from "@/shared/ui/input"
import { Textarea } from "@/shared/ui/textarea"

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

function toLocalDateTimeInput(timestamp?: number): string {
  if (!timestamp) return ""
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseRunAt(value: string): number | undefined {
  if (!value.trim()) return undefined
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : timestamp
}

export function AutomationCreatePage() {
  const navigate = useNavigate({ from: "/agent/automations/create" })
  const { automationId } = useSearch({ from: "/agent/automations/create" })
  const isEditing = Boolean(automationId)
  const [scheduleType, setScheduleType] = useState<"recurring" | "one-time">(
    "recurring",
  )
  const [name, setName] = useState("")
  const [objective, setObjective] = useState("")
  const [steps, setSteps] = useState(
    "Research the topic\nPrepare a concise report",
  )
  const [cronExpression, setCronExpression] = useState("@daily")
  const [runAt, setRunAt] = useState("")
  const [target, setTarget] = useState<AutomationTarget>("research")
  const [approvalMode, setApprovalMode] =
    useState<AutomationApprovalMode>("review")
  const [error, setError] = useState<string | null>(null)

  const automationQuery = useQuery({
    queryKey: ["automation", automationId],
    queryFn: () => getAutomation(automationId!),
    enabled: isEditing,
  })

  useEffect(() => {
    const automation = automationQuery.data?.automation
    if (!automation) return
    setName(automation.name)
    setObjective(automation.objective)
    setSteps(automation.steps.join("\n"))
    setCronExpression(automation.cronExpression ?? "@daily")
    setRunAt(toLocalDateTimeInput(automation.runAt))
    setScheduleType(automation.cronExpression ? "recurring" : "one-time")
    setTarget(automation.target)
    setApprovalMode(automation.approvalMode)
  }, [automationQuery.data?.automation])

  const normalizedSteps = useMemo(
    () =>
      steps
        .split("\n")
        .map((step) => step.trim())
        .filter(Boolean),
    [steps],
  )

  const saveMutation = useMutation({
    mutationFn: () => {
      const base = {
        name: name.trim() || objective.trim().slice(0, 60),
        objective: objective.trim(),
        steps: normalizedSteps,
        target,
        approvalMode,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        maxAttempts: 3,
      }
      if (isEditing) {
        return updateAutomation(automationId!, {
          ...base,
          ...(scheduleType === "recurring"
            ? { cronExpression: cronExpression.trim(), runAt: null }
            : { cronExpression: null, runAt }),
        })
      }
      return createAutomation({
        ...base,
        ...(scheduleType === "recurring"
          ? { cronExpression: cronExpression.trim() }
          : { runAt }),
      })
    },
    onSuccess: () =>
      void navigate({
        to: "/agent/automations/list",
        search:
          isEditing && automationId
            ? { automationId }
            : { automationId: undefined },
      }),
    onError: (mutationError: Error) => setError(mutationError.message),
  })

  const submit = () => {
    setError(null)
    if (!objective.trim() || normalizedSteps.length === 0) {
      setError("Objective and at least one step are required.")
      return
    }
    if (scheduleType === "recurring" && !cronExpression.trim()) {
      setError(
        "Enter a recurring schedule such as @daily, @weekly, or every 15 minutes.",
      )
      return
    }
    if (scheduleType === "one-time") {
      const parsedRunAt = parseRunAt(runAt)
      if (!parsedRunAt) {
        setError("Choose a date and time for the one-time run.")
        return
      }
      if (parsedRunAt <= Date.now()) {
        setError("One-time run must be scheduled in the future.")
        return
      }
    }
    saveMutation.mutate()
  }

  if (isEditing && automationQuery.isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        Loading automation…
      </div>
    )
  }

  if (isEditing && automationQuery.isError) {
    return (
      <div className="text-destructive flex h-full items-center justify-center text-sm">
        Unable to load this automation.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={isEditing ? "Edit automation" : "Create automation"}>
        <Button asChild variant="outline" size="sm">
          <Link
            to="/agent/automations/list"
            search={
              isEditing && automationId
                ? { automationId }
                : { automationId: undefined }
            }
          >
            <IconArrowLeft className="size-4" />
            Back to automations
          </Link>
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <AutomationCenterNav />
          <AutomationCenterSectionHeader
            eyebrow={isEditing ? "Workflow settings" : "New workflow"}
            title={
              isEditing ? "Update a repeatable task" : "Build a repeatable task"
            }
            description="Define the outcome, choose a supported schedule, and review the execution policy before saving."
          />

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,0.75fr)]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">1. Define the task</CardTitle>
                <CardDescription>
                  Research and internal tasks are ready to use. External targets
                  remain approval-gated until platform adapters are configured.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-1.5 text-sm">
                    <span className="font-medium">Name</span>
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Weekly AI research"
                    />
                  </label>
                  <label className="space-y-1.5 text-sm">
                    <span className="font-medium">Target</span>
                    <select
                      className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                      value={target}
                      onChange={(event) =>
                        setTarget(event.target.value as AutomationTarget)
                      }
                    >
                      {Object.entries(targetLabels).map(([value, label]) => (
                        <option
                          key={value}
                          value={value}
                          disabled={value === "facebook" || value === "youtube"}
                        >
                          {value === "facebook" || value === "youtube"
                            ? `${label} (adapter unavailable)`
                            : label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">Objective</span>
                  <Textarea
                    value={objective}
                    onChange={(event) => setObjective(event.target.value)}
                    placeholder="Research the latest developments and prepare a concise report."
                    rows={4}
                  />
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">Steps</span>
                  <Textarea
                    value={steps}
                    onChange={(event) => setSteps(event.target.value)}
                    placeholder="One step per line"
                    rows={5}
                  />
                  <span className="text-muted-foreground text-xs">
                    Use one step per line. Miki preserves this order when it
                    creates the linked Run.
                  </span>
                </label>
              </CardContent>
            </Card>

            <div className="space-y-5">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <IconClock className="text-primary size-4" />
                    2. Schedule
                  </CardTitle>
                  <CardDescription>
                    Choose a recurring schedule or a future one-time run.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <label className="space-y-1.5 text-sm">
                    <span className="font-medium">Schedule type</span>
                    <select
                      className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                      value={scheduleType}
                      onChange={(event) =>
                        setScheduleType(
                          event.target.value as "recurring" | "one-time",
                        )
                      }
                    >
                      <option value="recurring">Recurring</option>
                      <option value="one-time">One-time</option>
                    </select>
                  </label>
                  <label className="space-y-1.5 text-sm">
                    <span className="font-medium">
                      {scheduleType === "recurring"
                        ? "Schedule expression"
                        : "Run at"}
                    </span>
                    {scheduleType === "recurring" ? (
                      <>
                        <Input
                          value={cronExpression}
                          onChange={(event) =>
                            setCronExpression(event.target.value)
                          }
                          placeholder="@daily"
                        />
                        <span className="text-muted-foreground text-xs">
                          Supported: @hourly, @daily, @weekly, every N minutes,
                          every N seconds.
                        </span>
                      </>
                    ) : (
                      <Input
                        type="datetime-local"
                        value={runAt}
                        onChange={(event) => setRunAt(event.target.value)}
                      />
                    )}
                  </label>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <IconShieldCheck className="text-primary size-4" />
                    3. Review policy
                  </CardTitle>
                  <CardDescription>
                    Approval is recommended for anything that may create an
                    external side effect.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <select
                    className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                    value={approvalMode}
                    onChange={(event) =>
                      setApprovalMode(
                        event.target.value as AutomationApprovalMode,
                      )
                    }
                  >
                    <option value="review">Review before publishing</option>
                    <option value="none">No external action</option>
                    <option value="publish">Publish automatically</option>
                  </select>
                  {target === "facebook" || target === "youtube" ? (
                    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                      This target is currently a configuration label only. A
                      real platform adapter is not installed, so publishing will
                      not occur.
                    </p>
                  ) : null}
                  {error && <p className="text-destructive text-sm">{error}</p>}
                  <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                    <Button asChild variant="ghost">
                      <Link
                        to="/agent/automations/list"
                        search={
                          isEditing && automationId
                            ? { automationId }
                            : { automationId: undefined }
                        }
                      >
                        Cancel
                      </Link>
                    </Button>
                    <Button onClick={submit} disabled={saveMutation.isPending}>
                      <IconCheck className="size-4" />
                      {saveMutation.isPending
                        ? "Saving…"
                        : isEditing
                          ? "Save changes"
                          : "Create automation"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
