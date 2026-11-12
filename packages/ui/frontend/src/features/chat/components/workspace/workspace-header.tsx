import { IconLoader2 } from "@tabler/icons-react"
import type { ReactNode } from "react"

import { GlobalHeaderActions } from "@/app/layout/global-header-actions"
import { cn } from "@/lib/utils"
import { SidebarTrigger } from "@/shared/ui/sidebar"

import type { WorkspaceStatusPill, WorkspaceStatusTone } from "./types"

const statusDotClass: Record<WorkspaceStatusTone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
}

interface WorkspaceHeaderProps {
  title: string
  subtitle?: string
  statuses: WorkspaceStatusPill[]
  controls?: ReactNode
  isWorking?: boolean
  workingLabel?: string
  onWorkingClick?: () => void
}

export function WorkspaceHeader({
  title,
  subtitle,
  statuses,
  controls,
  isWorking = false,
  workingLabel = "Agent is working",
  onWorkingClick,
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
          role="group"
          aria-label={statusSummary}
          aria-live="polite"
          title={statusSummary}
        >
          {statuses.map((status) => {
            const dot = (
              <span
                aria-hidden="true"
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
                className="rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={status.onClick}
                aria-label={status.label}
                title={status.label}
              >
                {dot}
              </button>
            ) : (
              <span
                key={status.label}
                aria-label={status.label}
                title={status.label}
              >
                {dot}
              </span>
            )
          })}
        </div>

        <div
          role="group"
          className="hidden min-w-0 items-center gap-1.5 overflow-hidden sm:flex"
          aria-label={statusSummary}
          aria-live="polite"
        >
          {statuses.map((status) => {
            const content = (
              <>
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    statusDotClass[status.tone ?? "neutral"],
                  )}
                />
                <span className="truncate">{status.label}</span>
              </>
            )
            const className =
              "text-muted-foreground inline-flex max-w-40 shrink items-center gap-1.5 rounded-full border border-border/70 px-2 py-1 text-[10px] leading-none transition-colors"
            return status.onClick ? (
              <button
                key={status.label}
                type="button"
                className={cn(
                  className,
                  "hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                onClick={status.onClick}
                aria-label={status.label}
                title={status.label}
              >
                {content}
              </button>
            ) : (
              <span
                key={status.label}
                className={className}
                aria-label={status.label}
                title={status.label}
              >
                {content}
              </span>
            )
          })}
          {subtitle ? <span className="sr-only">{subtitle}</span> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {isWorking && (onWorkingClick ? (
          <button
            type="button"
            data-testid="working-indicator"
            className="text-primary/90 hover:bg-primary/10 inline-flex size-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            onClick={onWorkingClick}
            aria-label={workingLabel}
            title={workingLabel}
          >
            <IconLoader2
              aria-hidden="true"
              className="size-3.5 motion-safe:animate-spin motion-reduce:animate-none"
            />
          </button>
        ) : (
          <span
            data-testid="working-indicator"
            className="text-primary/90 inline-flex size-7 items-center justify-center"
            role="status"
            aria-label={workingLabel}
            title={workingLabel}
          >
            <IconLoader2
              aria-hidden="true"
              className="size-3.5 motion-safe:animate-spin motion-reduce:animate-none"
            />
          </span>
        ))}
        {controls}
        <GlobalHeaderActions />
      </div>
    </header>
  )
}
