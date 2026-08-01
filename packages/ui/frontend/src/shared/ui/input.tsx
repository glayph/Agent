import * as React from "react"

import { useFieldControl } from "@/shared/ui/field"
import { cn } from "@/lib/utils"

// Material Design input styles
const materialInputStyles = `
  .material-input {
    background-color: var(--md-sys-color-surface);
    border-color: var(--md-sys-color-outline);
    color: var(--md-sys-color-on-surface);
    border-radius: var(--md-sys-radius-sm);
    font: var(--md-sys-typescale-body-large);
  }
  .material-input::placeholder {
    color: var(--md-sys-color-on-surface-variant);
  }
  .material-input:focus {
    border-color: var(--md-sys-color-primary);
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
  }
  .material-input:disabled {
    background-color: var(--md-sys-color-surface-variant);
    opacity: 0.6;
  }
`

function Input({
  className,
  type,
  id,
  "aria-describedby": ariaDescribedBy,
  ...props
}: React.ComponentProps<"input">) {
  const fieldControlProps = useFieldControl({
    id,
    describedBy: ariaDescribedBy,
  })

  return (
    <>
      <style>{materialInputStyles}</style>
      <input
        id={fieldControlProps.id}
        type={type}
        data-slot="input"
        aria-describedby={fieldControlProps["aria-describedby"]}
        className={cn(
          "material-input h-10 w-full min-w-0 border px-3 py-2 text-base shadow-none transition-all duration-200 outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/75 disabled:pointer-events-none disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25 md:text-sm",
          className
        )}
        {...props}
      />
    </>
  )
}

export { Input }
