import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "border-border/60 bg-card/40 text-muted-foreground flex flex-col items-center justify-center rounded-2xl border border-dashed p-8 text-center animate-fade-in",
        className,
      )}
    >
      {icon ? (
        <div className="bg-secondary/60 text-muted-foreground mb-4 flex size-12 items-center justify-center rounded-2xl">
          {icon}
        </div>
      ) : null}
      <h3 className="text-foreground text-base font-semibold tracking-tight">
        {title}
      </h3>
      {description ? (
        <p className="text-muted-foreground mt-1 max-w-sm text-xs leading-relaxed">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}
