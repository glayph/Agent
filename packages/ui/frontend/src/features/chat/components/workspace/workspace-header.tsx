import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Badge } from "@/shared/ui/badge"
import { SidebarTrigger } from "@/shared/ui/sidebar"

import type { WorkspaceStatusPill, WorkspaceStatusTone } from "./types"

const statusToneClass: Record<WorkspaceStatusTone, string> = {
  neutral: "border-border/80 bg-background/75 text-muted-foreground",
  success:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning: "border-primary/25 bg-primary/10 text-primary",
  info: "border-primary/30 bg-primary/10 text-primary",
}

const statusDotClass: Record<WorkspaceStatusTone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  info: "bg-primary",
}

interface WorkspaceHeaderProps {
  title: string
  subtitle?: string
  statuses: WorkspaceStatusPill[]
  controls?: ReactNode
}

export function WorkspaceHeader({
  title,
  subtitle,
  statuses,
  controls,
}: WorkspaceHeaderProps) {
  const statusSummary = statuses.map((status) => status.label).join(", ")

  return (
    <header
      data-chat-header="true"
      className="bg-background/88 border-border/75 relative z-10 flex h-16 min-h-16 shrink-0 items-center gap-2 border-b px-3 backdrop-blur-xl sm:px-6"
    >
      <SidebarTrigger
        className="text-muted-foreground hover:bg-primary/10 hover:text-primary md:hidden"
        aria-label="Open navigation"
        title="Open navigation"
      />

      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <h1 className="text-foreground min-w-0 shrink truncate text-[14px] font-semibold tracking-[-0.01em] sm:text-[15px]">
          {title}
        </h1>

        <div
          className="flex shrink-0 items-center gap-1 sm:hidden"
          aria-label={statusSummary}
          title={statusSummary}
        >
          {statuses.map((status) => {
            const dot = (
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  statusDotClass[status.tone ?? "neutral"],
                )}
              />
            )
            return status.onClick ? (
              <button
                key={status.label}
                type="button"
                className="rounded-full p-1"
                onClick={status.onClick}
                aria-label={status.label}
                title={status.label}
              >
                {dot}
              </button>
            ) : (
              <span key={status.label}>{dot}</span>
            )
          })}
        </div>

        <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
          {statuses.map((status) => {
            const badge = (
              <Badge
                variant="outline"
                className={cn(
                  "h-5 border px-2 text-[10px] leading-none font-medium",
                  statusToneClass[status.tone ?? "neutral"],
                  status.onClick &&
                    "hover:bg-primary/15 cursor-pointer transition-colors",
                )}
              >
                {status.label}
              </Badge>
            )
            return status.onClick ? (
              <button
                key={status.label}
                type="button"
                className="rounded-md"
                onClick={status.onClick}
                aria-label={status.label}
                title={status.label}
              >
                {badge}
              </button>
            ) : (
              <span key={status.label}>{badge}</span>
            )
          })}
        </div>

        {subtitle && (
          <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
            {subtitle}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">{controls}</div>
    </header>
  )
}
