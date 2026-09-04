import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

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

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "mx-auto flex min-h-[220px] max-w-[560px] flex-col items-center justify-center px-6 py-10 text-center",
        className,
      )}
    >
      {icon && (
        <div className="bg-card/70 text-muted-foreground mb-4 flex size-11 items-center justify-center rounded-lg">
          {icon}
        </div>
      )}
      <h3 className="text-foreground text-base font-semibold">{title}</h3>
      {description && (
        <p className="text-muted-foreground mt-2 max-w-[440px] text-sm leading-6">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
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
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{title}</h3>
          {description && (
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              {description}
            </p>
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
