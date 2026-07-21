import * as React from "react"

import { cn } from "@/lib/utils"

// Material Design card styles
const materialCardStyles = `
  .material-card {
    background-color: var(--md-sys-color-surface);
    border-color: var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-radius-md);
  }
  .material-card-elevated {
    box-shadow: var(--md-sys-elevation-1);
  }
  .material-card-title {
    font: var(--md-sys-typescale-title-medium);
    color: var(--md-sys-color-on-surface);
  }
  .material-card-description {
    font: var(--md-sys-typescale-body-medium);
    color: var(--md-sys-color-on-surface-variant);
  }
`

function Card({
  className,
  size = "default",
  elevated = false,
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm"; elevated?: boolean }) {
  return (
    <>
      <style>{materialCardStyles}</style>
      <div
        data-slot="card"
        data-size={size}
        className={cn(
          "material-card group/card flex flex-col gap-4 overflow-hidden border py-4 text-sm text-card-foreground has-[>img:first-child]:pt-0 data-[size=sm]:gap-3 data-[size=sm]:py-3 *:[img:first-child]:rounded-t-lg *:[img:last-child]:rounded-b-lg",
          elevated && "material-card-elevated",
          className
        )}
        {...props}
      />
    </>
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-lg px-4 group-data-[size=sm]/card:px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "material-card-title leading-normal group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("material-card-description leading-5", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4 group-data-[size=sm]/card:px-4", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-lg px-4 group-data-[size=sm]/card:px-4 [.border-t]:pt-4 group-data-[size=sm]/card:[.border-t]:pt-3",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
