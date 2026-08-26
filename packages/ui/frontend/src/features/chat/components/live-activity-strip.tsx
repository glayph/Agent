import {
  IconActivity,
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconLoader2,
} from "@tabler/icons-react"

import {
  activityStatusLabel,
  activitySummary,
  activityTitle,
} from "@/features/monitor/activity-copy"
import type { MonitorNode } from "@/features/monitor/store"
import { cn } from "@/lib/utils"

interface LiveActivityStripProps {
  nodes: MonitorNode[]
  selectedNodeId?: string
  onSelect: (node: MonitorNode) => void
}

function ActivityStateIcon({ status }: { status: MonitorNode["status"] }) {
  if (status === "running" || status === "retrying") {
    return <IconLoader2 className="size-3.5 animate-spin" aria-hidden="true" />
  }
  if (status === "failed") {
    return <IconAlertTriangle className="size-3.5" aria-hidden="true" />
  }
  return <IconCheck className="size-3.5" aria-hidden="true" />
}

export function LiveActivityStrip({
  nodes,
  selectedNodeId,
  onSelect,
}: LiveActivityStripProps) {
  if (nodes.length === 0) return null

  return (
    <section
      aria-label="Live agent activity"
      className="border-border/50 bg-card/65 mx-auto w-full max-w-[var(--chat-content-width)] rounded-xl border px-3 py-2 shadow-sm backdrop-blur-sm"
    >
      <div className="text-muted-foreground flex items-center gap-2 px-1 pb-1.5 text-[10px] font-semibold tracking-[0.14em] uppercase">
        <IconActivity className="text-primary size-3.5" aria-hidden="true" />
        <span>Live activity</span>
      </div>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-stretch">
        {nodes.map((node) => {
          const isActive =
            node.status === "running" || node.status === "retrying"
          const isSelected = node.id === selectedNodeId
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect(node)}
              className={cn(
                "group flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                "hover:border-primary/25 hover:bg-primary/[0.06] border-transparent",
                isSelected && "border-primary/35 bg-primary/[0.08]",
                isActive && "text-foreground",
                !isActive && "text-muted-foreground",
              )}
              aria-current={isSelected ? "true" : undefined}
              title={`${activityTitle(node)} — ${activityStatusLabel(node.status)}`}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full",
                  isActive
                    ? "bg-primary/12 text-primary"
                    : node.status === "failed"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted text-muted-foreground",
                )}
              >
                <ActivityStateIcon status={node.status} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">
                  {isActive ? activitySummary(node) : activityTitle(node)}
                </span>
                <span className="text-muted-foreground/75 block truncate text-[10px]">
                  {activityStatusLabel(node.status)}
                </span>
              </span>
              <IconChevronRight
                className="text-muted-foreground/50 size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </button>
          )
        })}
      </div>
    </section>
  )
}
