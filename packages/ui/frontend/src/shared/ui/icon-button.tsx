import * as React from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/shared/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, "children"> & {
  label: string
  icon: React.ReactNode
  side?: React.ComponentProps<typeof TooltipContent>["side"]
  iconClassName?: string
}

export function IconButton({
  label,
  icon,
  side = "bottom",
  className,
  iconClassName,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...props}
          size={props.size ?? "icon"}
          className={cn("shrink-0", className)}
          aria-label={props["aria-label"] ?? label}
          title={props.title ?? label}
        >
          <span
            className={cn("flex items-center justify-center", iconClassName)}
          >
            {icon}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
