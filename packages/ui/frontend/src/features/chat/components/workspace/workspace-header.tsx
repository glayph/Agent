import { IconLoader2 } from "@tabler/icons-react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { SidebarTrigger } from "@/shared/ui/sidebar"

import type { WorkspaceStatusPill, WorkspaceStatusTone } from "./types"

const statusDotClass: Record<WorkspaceStatusTone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-primary",
  warning: "bg-primary",
  info: "bg-primary",
}

interface WorkspaceHeaderProps {
  title: string
  subtitle?: string
  statuses: WorkspaceStatusPill[]
  controls?: ReactNode
  isWorking?: boolean
}

export function WorkspaceHeader({
  title,
  subtitle,
  statuses,
  controls,
  isWorking = false,
}: WorkspaceHeaderProps) {
  const statusSummary = statuses.map((status) => status.label).join(", ")

  return (
    <header
      data-chat-header="true"
      className="miki-topbar bg-background/96 border-border relative z-10 flex h-14 min-h-14 shrink-0 items-center gap-2 border-b px-3 backdrop-blur-xl sm:px-6"
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

        <div className="hidden min-w-0 items-center gap-2 sm:flex">
          {statuses[0] ? (
            statuses[0].onClick ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-[11px] transition-colors"
                onClick={statuses[0].onClick}
                aria-label={statuses[0].label}
                title={statuses[0].label}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    statusDotClass[statuses[0].tone ?? "neutral"],
                  )}
                />
                <span>{statuses[0].label}</span>
              </button>
            ) : (
              <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    statusDotClass[statuses[0].tone ?? "neutral"],
                  )}
                />
                <span>{statuses[0].label}</span>
              </span>
            )
          ) : null}
          <span className="sr-only">{statuses.slice(1).map((status) => status.label).join(", ")}</span>
          {subtitle ? <span className="sr-only">{subtitle}</span> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {isWorking && (
          <button
            type="button"
            data-testid="working-indicator"
            className="text-primary/90 hover:bg-primary/10 inline-flex size-7 items-center justify-center rounded-md transition-colors motion-reduce:transition-none"
            onClick={statuses[0]?.onClick}
            aria-label="Agent is working"
            title="Agent is working"
          >
            <IconLoader2
              aria-hidden="true"
              className="size-3.5 motion-safe:animate-spin motion-reduce:animate-none"
            />
          </button>
        )}
        {controls}
      </div>
    </header>
  )
}
