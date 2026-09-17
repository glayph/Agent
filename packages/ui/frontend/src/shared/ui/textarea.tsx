import * as React from "react"

import { cn } from "@/lib/utils"
import { useFieldControl } from "@/shared/ui/field"

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
        "border-input bg-card text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/25 aria-invalid:border-destructive aria-invalid:ring-destructive/25 flex field-sizing-content min-h-16 w-full rounded-lg border px-4 py-3 text-base shadow-none transition-[color,border-color,box-shadow] outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-2 md:text-sm",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
