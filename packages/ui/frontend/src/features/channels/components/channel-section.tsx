import { IconChevronDown } from "@tabler/icons-react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/shared/ui/card"

interface ChannelSectionProps {
  title: string
  description?: string
  children: ReactNode
  className?: string
  /** Renders the section collapsed behind its title (used for Advanced). */
  collapsible?: boolean
  defaultOpen?: boolean
}

export function ChannelSection({
  title,
  description,
  children,
  className,
  collapsible = false,
  defaultOpen = false,
}: ChannelSectionProps) {
  const heading = (
    <div className="space-y-1">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {description && (
        <p className="text-muted-foreground text-xs leading-5">{description}</p>
      )}
    </div>
  )

  if (collapsible) {
    return (
      <details
        className={cn("group space-y-3", className)}
        open={defaultOpen}
        aria-label={title}
      >
        <summary className="flex cursor-pointer list-none items-start justify-between gap-2 [&::-webkit-details-marker]:hidden">
          {heading}
          <IconChevronDown
            className="text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="pt-1">{children}</div>
      </details>
    )
  }

  return (
    <section className={cn("space-y-3", className)} aria-label={title}>
      {heading}
      {children}
    </section>
  )
}

/** Standard card used by every channel form section. */
export function ChannelFieldCard({ children }: { children: ReactNode }) {
  return (
    <Card className="shadow-sm">
      <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
        {children}
      </CardContent>
    </Card>
  )
}
