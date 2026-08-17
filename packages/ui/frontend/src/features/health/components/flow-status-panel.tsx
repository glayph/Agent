import { IconRefresh } from "@tabler/icons-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  type FlowComponentStatus,
  type FlowStatusResponse,
  getFlowStatus,
} from "@/api/system"
import { SectionPanel, StatusDot } from "@/shared/ui/minimal-primitives"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Skeleton } from "@/shared/ui/skeleton"
import { formatDateTime } from "@/lib/format"

function statusVariant(status: FlowComponentStatus) {
  if (status === "ready") return "default" as const
  if (status === "error") return "destructive" as const
  if (status === "disabled") return "outline" as const
  return "secondary" as const
}

function statusTone(status: FlowComponentStatus) {
  if (status === "ready") return "success" as const
  if (status === "error") return "danger" as const
  if (status === "disabled") return "neutral" as const
  return "warning" as const
}

function gapVariant(severity: "info" | "warning" | "error") {
  if (severity === "error") return "destructive" as const
  if (severity === "warning") return "secondary" as const
  return "outline" as const
}

function formatMetricValue(value: number | string | boolean) {
  return typeof value === "boolean" ? String(value) : value
}

export function FlowStatusPanel() {
  const { t } = useTranslation()
  const [flow, setFlow] = useState<FlowStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setFlow(await getFlowStatus())
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("pages.health.flow.load_error"),
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const readyCount = useMemo(
    () =>
      flow?.components.filter((component) => component.status === "ready")
        .length ?? 0,
    [flow],
  )

  return (
    <SectionPanel
      title={t("pages.health.flow.title")}
      description={t("pages.health.flow.description")}
      action={
        flow ? (
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={statusVariant(flow.status)}>{flow.status}</Badge>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void load()}
              disabled={loading}
              aria-label={t("pages.health.flow.refresh")}
            >
              <IconRefresh />
            </Button>
          </div>
        ) : undefined
      }
    >
      {loading && !flow ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-md" />
          ))}
        </div>
      ) : flow ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline">
              {t("pages.health.flow.components_ready", {
                ready: readyCount,
                total: flow.components.length,
              })}
            </Badge>
            <Badge variant="outline">
              {t("pages.health.flow.edges", { count: flow.edges.length })}
            </Badge>
            <span className="text-muted-foreground">
              {t("pages.health.flow.generated", {
                date: formatDateTime(flow.generated_at),
              })}
            </span>
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            {flow.components.map((component) => (
              <div
                key={component.id}
                className="border-border bg-muted/20 rounded-md border px-3 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <StatusDot tone={statusTone(component.status)} />
                      <div className="truncate text-sm font-medium">
                        {component.label}
                      </div>
                    </div>
                    <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5">
                      {component.summary}
                    </p>
                  </div>
                  <Badge variant={statusVariant(component.status)}>
                    {component.status}
                  </Badge>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {component.evidence.slice(0, 4).map((item) => (
                    <Badge key={item} variant="outline">
                      {item}
                    </Badge>
                  ))}
                </div>

                {component.metrics &&
                  Object.keys(component.metrics).length > 0 && (
                    <div className="text-muted-foreground mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {Object.entries(component.metrics).map(([key, value]) => (
                        <span key={key}>
                          {key}: {formatMetricValue(value)}
                        </span>
                      ))}
                    </div>
                  )}
              </div>
            ))}
          </div>

          <div className="border-border rounded-md border">
            <div className="border-border flex items-center justify-between gap-3 border-b px-3 py-2">
              <div className="text-sm font-medium">
                {t("pages.health.flow.gaps")}
              </div>
              <Badge variant="outline">{flow.gaps.length}</Badge>
            </div>
            {flow.gaps.length === 0 ? (
              <div className="text-muted-foreground px-3 py-3 text-sm">
                {t("pages.health.flow.no_gaps")}
              </div>
            ) : (
              <div className="divide-border divide-y">
                {flow.gaps.map((gap) => (
                  <div
                    key={gap.id}
                    className="flex items-start justify-between gap-3 px-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {gap.title}
                      </div>
                      <p className="text-muted-foreground mt-1 text-xs leading-5">
                        {gap.detail}
                      </p>
                    </div>
                    <Badge variant={gapVariant(gap.severity)}>
                      {gap.owner}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-muted-foreground text-sm">
          {t("pages.health.flow.load_error")}
        </div>
      )}
    </SectionPanel>
  )
}
