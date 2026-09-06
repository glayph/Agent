import {
  IconActivity,
  IconArrowRight,
  IconCheck,
  IconClock,
  IconPlayerPlay,
  IconPlus,
  IconShieldCheck,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { type AutomationTarget, listAutomations } from "@/api/automations"
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

const targetLabels: Record<AutomationTarget, string> = {
  internal: "Internal task",
  research: "Research",
  facebook: "Facebook Page",
  youtube: "YouTube",
}

function formatDate(value?: number): string {
  if (!value) return "Not scheduled"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

export function AutomationOverviewPage() {
  const automationsQuery = useQuery({
    queryKey: ["automations"],
    queryFn: () => listAutomations(),
    refetchInterval: 15_000,
  })
  const automations = automationsQuery.data?.automations ?? []
  const active = automations.filter(
    (automation) => automation.status === "active",
  )
  const paused = automations.filter(
    (automation) => automation.status === "paused",
  )
  const disabled = automations.filter(
    (automation) => automation.status === "disabled",
  )

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
            <IconPlus className="size-4" />
            New automation
          </Link>
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <AutomationCenterNav />
          <AutomationCenterSectionHeader
            eyebrow="Workspace overview"
            title="A calmer way to run repeatable work"
            description="Start here for a quick health check. Open Automations to manage schedules, Create to build a workflow, or History to inspect linked Runs."
          />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <p className="text-muted-foreground text-xs">
                    Total workflows
                  </p>
                  <IconActivity className="text-primary size-4" />
                </div>
                <p className="mt-2 text-2xl font-semibold">
                  {automations.length}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Saved in Miki
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <p className="text-muted-foreground text-xs">Active</p>
                  <IconCheck className="size-4 text-emerald-600" />
                </div>
                <p className="mt-2 text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
                  {active.length}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Ready to run
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <p className="text-muted-foreground text-xs">Paused</p>
                  <IconClock className="size-4 text-amber-600" />
                </div>
                <p className="mt-2 text-2xl font-semibold text-amber-600 dark:text-amber-400">
                  {paused.length}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Waiting for review
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <p className="text-muted-foreground text-xs">Disabled</p>
                  <IconShieldCheck className="text-muted-foreground size-4" />
                </div>
                <p className="mt-2 text-2xl font-semibold">{disabled.length}</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Kept for history
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(260px,0.7fr)]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Active schedules</CardTitle>
                <CardDescription>
                  Only active workflows can create new linked Runs.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {active.length ? (
                  <div className="space-y-3">
                    {active.slice(0, 5).map((automation) => (
                      <div
                        key={automation.id}
                        className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium">
                              {automation.name}
                            </p>
                            <Badge variant="secondary">
                              {targetLabels[automation.target]}
                            </Badge>
                          </div>
                          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                            {automation.objective}
                          </p>
                          <p className="text-muted-foreground mt-2 text-xs">
                            Next run: {formatDate(automation.nextRunAt)}
                          </p>
                        </div>
                        <Button asChild variant="outline" size="sm">
                          <Link
                            to="/agent/automations/list"
                            search={{ automationId: automation.id }}
                          >
                            <IconArrowRight className="size-4" />
                            Manage
                          </Link>
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed p-10 text-center">
                    <p className="font-medium">No active schedules</p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      Create an automation to start a repeatable workflow.
                    </p>
                    <Button asChild className="mt-4" size="sm">
                      <Link
                        to="/agent/automations/create"
                        search={{ automationId: undefined }}
                      >
                        <IconPlus className="size-4" />
                        Create automation
                      </Link>
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Quick actions</CardTitle>
                <CardDescription>
                  Keep the common tasks one click away.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button
                  asChild
                  className="w-full justify-between"
                  variant="outline"
                >
                  <Link
                    to="/agent/automations/create"
                    search={{ automationId: undefined }}
                  >
                    Create a workflow
                    <IconPlus className="size-4" />
                  </Link>
                </Button>
                <Button
                  asChild
                  className="w-full justify-between"
                  variant="outline"
                >
                  <Link
                    to="/agent/automations/list"
                    search={{ automationId: undefined }}
                  >
                    Manage schedules
                    <IconArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button
                  asChild
                  className="w-full justify-between"
                  variant="outline"
                >
                  <Link
                    to="/agent/automations/history"
                    search={{ automationId: undefined }}
                  >
                    Review linked Runs
                    <IconPlayerPlay className="size-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
