import * as React from "react"

import { cn } from "@/lib/utils"
import { useFieldControl } from "@/shared/ui/field"

// Material Design input styles
const materialInputStyles = `
  .material-input {
    background-color: var(--md-sys-color-surface);
    border-color: var(--md-sys-color-outline);
    color: var(--md-sys-color-on-surface);
    border-radius: var(--md-sys-radius-pill);
    font: var(--md-sys-typescale-body-large);
    transition: border-color 150ms cubic-bezier(0.4, 0, 0.2, 1),
      box-shadow 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .material-input::placeholder {
    color: var(--md-sys-color-on-surface-variant);
  }
  .material-input:focus {
    border-color: var(--md-sys-color-primary);
    outline: none;
    box-shadow: 0 0 0 4px var(--md-sys-color-primary-glow);
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
          "material-input file:text-foreground placeholder:text-muted-foreground/75 aria-invalid:border-destructive aria-invalid:ring-destructive/25 h-10 w-full min-w-0 border px-4 py-2 text-base shadow-none outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed aria-invalid:ring-2 md:text-sm",
          className,
        )}
        {...props}
      />
    </>
  )
}

export { Input }
