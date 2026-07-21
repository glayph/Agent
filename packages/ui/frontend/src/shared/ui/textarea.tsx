import * as React from "react"

import { useFieldControl } from "@/shared/ui/field"
import { cn } from "@/lib/utils"

function Textarea({
  className,
  id,
  "aria-describedby": ariaDescribedBy,
  ...props
}: React.ComponentProps<"textarea">) {
  const fieldControlProps = useFieldControl({
    id,
    describedBy: ariaDescribedBy,
  })

  return (
    <textarea
      id={fieldControlProps.id}
      data-slot="textarea"
      aria-describedby={fieldControlProps["aria-describedby"]}
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-card px-4 py-3 text-base text-foreground shadow-none transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
