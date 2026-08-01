import type { TaskGraphStep } from "@/api/agent-runs"
import { EmptyState } from "@/shared/ui/minimal-primitives"
import { Badge } from "@/shared/ui/badge"
import { ScrollArea } from "@/shared/ui/scroll-area"
import { Separator } from "@/shared/ui/separator"
import { cn } from "@/lib/utils"

import { formatOptionalRunDate } from "./date-format"

function formatJson(value: unknown) {
  const formatted = JSON.stringify(value, null, 2)
  return formatted.length > 12_000
    ? `${formatted.slice(0, 12_000)}\n[Evidence data truncated]`
    : formatted
}

function evidenceDetails(evidence: TaskGraphStep["evidence"][number]) {
  return {
    ...(evidence.metadata ? { metadata: evidence.metadata } : {}),
    ...(evidence.modelCall ? { modelCall: evidence.modelCall } : {}),
    ...(evidence.toolCall ? { toolCall: evidence.toolCall } : {}),
    ...(evidence.permission ? { permission: evidence.permission } : {}),
    ...(evidence.data ? { data: evidence.data } : {}),
  }
}

export function StepEvidencePanel({
  step,
  className,
}: {
  step: TaskGraphStep | null
  className?: string
}) {
  if (!step) {
    return (
      <section
        className={cn(
          "border-border bg-card min-h-[18rem] rounded-lg border",
          className,
        )}
      >
        <EmptyState
          title="No step selected"
          description="Select a task graph step to inspect its evidence and verifier output."
        />
      </section>
    )
  }

  return (
    <section
      className={cn(
        "border-border bg-card flex min-h-[18rem] flex-col overflow-hidden rounded-lg border",
        className,
      )}
    >
      <div className="border-border border-b px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{step.title}</h3>
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              Attempts: {step.attempts} - Started:{" "}
              {formatOptionalRunDate(step.startedAt)}
            </p>
          </div>
          <Badge variant={step.status === "failed" ? "destructive" : "outline"}>
            {step.status}
          </Badge>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          {step.error && (
            <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3">
              <div className="text-sm font-medium">{step.error.code}</div>
              <div className="text-muted-foreground mt-1 text-xs">
                {step.error.message}
              </div>
              {step.error.remediation && (
                <div className="text-muted-foreground mt-2 text-xs">
                  {step.error.remediation}
                </div>
              )}
            </div>
          )}

          {step.evidence.length === 0 ? (
            <EmptyState
              title="No evidence yet"
              description="Verifier evidence will appear here after the step records commands, files, API checks, metrics, or manual notes."
              className="min-h-[260px]"
            />
          ) : (
            <div className="flex flex-col gap-3">
              {step.evidence.map((evidence, index) => (
                <div
                  key={`${evidence.kind}-${index}`}
                  className="border-border rounded-md border p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {evidence.phase && (
                          <Badge variant="secondary">{evidence.phase}</Badge>
                        )}
                        {evidence.source && (
                          <Badge variant="outline">{evidence.source}</Badge>
                        )}
                        <Badge
                          variant={evidence.ok ? "outline" : "destructive"}
                        >
                          {evidence.kind}
                        </Badge>
                        <Badge
                          variant={evidence.ok ? "default" : "destructive"}
                        >
                          {evidence.ok ? "passed" : "failed"}
                        </Badge>
                      </div>
                      {evidence.capturedAt && (
                        <p className="text-muted-foreground mt-1 text-xs">
                          Captured {formatOptionalRunDate(evidence.capturedAt)}
                        </p>
                      )}
                      <p className="mt-2 text-sm">{evidence.summary}</p>
                    </div>
                  </div>
                  {Object.keys(evidenceDetails(evidence)).length > 0 && (
                    <>
                      <Separator className="my-3" />
                      <pre className="bg-muted text-muted-foreground max-h-72 overflow-auto rounded-md p-3 text-xs leading-5">
                        {formatJson(evidenceDetails(evidence))}
                      </pre>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </section>
  )
}
