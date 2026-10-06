import { Switch as SwitchPrimitive } from "radix-ui"
import * as React from "react"

import { cn } from "@/lib/utils"
import { useFieldControl } from "@/shared/ui/field"

function Switch({
  className,
  id,
  "aria-describedby": ariaDescribedBy,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  const fieldControlProps = useFieldControl({
    id,
    describedBy: ariaDescribedBy,
  })

  return (
    <SwitchPrimitive.Root
      id={fieldControlProps.id}
      data-slot="switch"
      data-size={size}
      aria-describedby={fieldControlProps["aria-describedby"]}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-border/80 bg-muted p-0 shadow-none outline-none transition-[background-color,border-color,box-shadow] data-checked:border-primary data-checked:bg-primary data-unchecked:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive data-disabled:cursor-not-allowed data-disabled:opacity-50 data-[size=default]:h-6 data-[size=default]:w-11 data-[size=sm]:h-5 data-[size=sm]:w-9",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full border border-border/70 bg-background shadow-sm ring-0 transition-transform group-data-[size=default]/switch:size-5 group-data-[size=sm]/switch:size-4 group-data-[size=default]/switch:data-checked:translate-x-5 group-data-[size=sm]/switch:data-checked:translate-x-4 group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
