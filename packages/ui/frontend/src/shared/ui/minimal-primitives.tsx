import { IconInfoCircle } from "@tabler/icons-react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

export function StatusDot({
  tone = "neutral",
  label,
}: {
  tone?: "neutral" | "success" | "warning" | "danger" | "info"
  label?: string
}) {
  const toneClass = {
    neutral: "bg-muted-foreground",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    info: "bg-primary",
  }[tone]

  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("size-2 rounded-full", toneClass)} />
      {label && <span>{label}</span>}
    </span>
  )
}


export function SectionPanel({
  title,
  description,
  children,
  action,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "border-border bg-card text-card-foreground rounded-lg border",
        className,
      )}
    >
      <div className="border-border flex items-start justify-between gap-4 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="truncate text-[13px] font-semibold tracking-[-0.01em]">{title}</h3>
          {description && (
            <Tooltip delayDuration={350}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="More information"
                  className="miki-section-info ml-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <IconInfoCircle className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" align="start" className="max-w-[20rem] whitespace-normal">
                {description}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

export function CompactActionRow({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "border-border bg-muted/35 flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3",
        className,
      )}
    >
      {children}
    </div>
  )
}
