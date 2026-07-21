import type { AgentRun, TaskGraphStep } from "@/api/agent-runs"
import { StatusDot } from "@/components/minimal-primitives"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import { formatOptionalRunDate } from "./date-format"

function statusTone(status: TaskGraphStep["status"]) {
  if (status === "completed") return "success" as const
  if (status === "running") return "info" as const
  if (status === "failed") return "danger" as const
  if (status === "skipped") return "warning" as const
  return "neutral" as const
}

export function TaskGraph({
  run,
  selectedStepId,
  onSelectStep,
  className,
}: {
  run: AgentRun
  selectedStepId: string | null
  onSelectStep: (stepId: string) => void
  className?: string
}) {
  return (
    <section
      className={cn(
        "border-border bg-card min-h-0 overflow-hidden rounded-lg border",
        className,
      )}
    >
      <div className="border-border flex items-start justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">Task Graph</h3>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            Persistent execution steps, dependencies, attempts, and evidence.
          </p>
        </div>
        <Badge variant="outline">{run.steps.length} steps</Badge>
      </div>
      <div className="flex max-h-[36rem] flex-col gap-2 overflow-y-auto p-3 xl:max-h-none">
        {run.steps.map((step, index) => {
          const selected = step.id === selectedStepId
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onSelectStep(step.id)}
              data-selected={selected}
              aria-current={selected ? "step" : undefined}
              aria-label={`Select step ${index + 1}: ${step.title}, ${step.status}`}
              className={cn(
                "border-border hover:bg-accent flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors",
                selected && "bg-accent text-accent-foreground",
              )}
            >
              <div className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold">
                {index + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <StatusDot tone={statusTone(step.status)} />
                  <div className="min-w-0 truncate text-sm font-medium">
                    {step.title}
                  </div>
                  <Badge variant="outline">{step.status}</Badge>
                </div>
                <div className="text-muted-foreground mt-2 flex flex-wrap gap-2 text-xs">
                  <span>Attempts: {step.attempts}</span>
                  <span>Evidence: {step.evidence.length}</span>
                  <span>Started: {formatOptionalRunDate(step.startedAt)}</span>
                  <span>
                    Completed: {formatOptionalRunDate(step.completedAt)}
                  </span>
                </div>
                {step.dependsOn.length > 0 && (
                  <div className="text-muted-foreground mt-2 truncate text-xs">
                    Depends on {step.dependsOn.join(", ")}
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
