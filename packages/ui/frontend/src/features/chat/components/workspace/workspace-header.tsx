import {
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconMenu2,
} from "@tabler/icons-react"
import type { ReactNode } from "react"

import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { cn } from "@/lib/utils"

import type { WorkspaceStatusPill, WorkspaceStatusTone } from "./types"

const statusToneClass: Record<WorkspaceStatusTone, string> = {
  neutral: "border-border bg-muted/35 text-muted-foreground",
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/25 bg-warning/10 text-warning",
  info: "border-ring/25 bg-secondary/50 text-secondary-foreground",
}

const statusDotClass: Record<WorkspaceStatusTone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-ring",
}

interface WorkspaceHeaderProps {
  title: string
  subtitle?: string
  statuses: WorkspaceStatusPill[]
  controls?: ReactNode
  rightPanelOpen: boolean
  onOpenSidebar: () => void
  onToggleRightPanel: () => void
}

export function WorkspaceHeader({
  title,
  subtitle,
  statuses,
  controls,
  rightPanelOpen,
  onOpenSidebar,
  onToggleRightPanel,
}: WorkspaceHeaderProps) {
  const InspectorIcon = rightPanelOpen
    ? IconLayoutSidebarRightCollapse
    : IconLayoutSidebarRightExpand
  const statusSummary = statuses.map((status) => status.label).join(", ")

  return (
    <header className="flex h-14 min-h-14 shrink-0 items-center gap-2 border-b border-transparent bg-transparent px-3">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-foreground md:hidden"
        onClick={onOpenSidebar}
        aria-label="Open workspaces"
        title="Open workspaces"
      >
        <IconMenu2 className="size-4" />
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <h1 className="min-w-0 shrink truncate text-[13px] leading-none font-semibold sm:text-[15px]">
          {title}
        </h1>

        <div
          className="flex shrink-0 items-center gap-1 sm:hidden"
          aria-label={statusSummary}
          title={statusSummary}
        >
          {statuses.map((status) => (
            <span
              key={status.label}
              className={cn(
                "size-1.5 rounded-full",
                statusDotClass[status.tone ?? "neutral"],
              )}
            />
          ))}
        </div>

        <div className="hidden min-w-0 items-center gap-1 sm:flex">
          {statuses.map((status) => (
            <Badge
              key={status.label}
              variant="outline"
              className={cn(
                "h-4 border px-1.5 text-[10px] leading-none font-medium",
                statusToneClass[status.tone ?? "neutral"],
              )}
            >
              {status.label}
            </Badge>
          ))}
        </div>

        {subtitle && (
          <span className="text-muted-foreground hidden shrink-0 text-[11px] leading-none sm:inline">
            {subtitle}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {controls}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={onToggleRightPanel}
          aria-label={rightPanelOpen ? "Hide inspector" : "Show inspector"}
          title={rightPanelOpen ? "Hide inspector" : "Show inspector"}
        >
          <InspectorIcon className="size-4" />
        </Button>
      </div>
    </header>
  )
}
