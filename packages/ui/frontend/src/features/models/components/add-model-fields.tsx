import type { ChangeEvent, ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Switch } from "@/shared/ui/switch"

export interface AddModelFieldIds {
  modelName: string
  provider: string
  model: string
  apiKey: string
  apiBase: string
  proxy: string
  authMethod: string
  connectMode: string
  workspace: string
  requestTimeout: string
  rpm: string
  thinkingLevel: string
  maxTokensField: string
  toolSchemaTransform: string
  extraBody: string
  customHeaders: string
}

export function FormRow({
  label,
  htmlFor,
  error,
  errorId,
  action,
  children,
  className,
}: {
  label: string
  htmlFor?: string
  error?: string
  errorId?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <label
          htmlFor={htmlFor}
          className="text-foreground text-[13px] font-medium"
        >
          {label}
        </label>
        {action}
      </div>
      {children}
      {error ? (
        <p id={errorId} className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function SwitchRow({
  label,
  checked,
  onCheckedChange,
  disabled,
  title,
}: {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  title?: string
}) {
  return (
    <div className="flex items-center justify-between gap-4" title={title}>
      <span
        className={cn(
          "text-[13px] font-medium",
          disabled && "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
      />
    </div>
  )
}

export type AddFormFieldSetter = (
  key: keyof import("./add-model-form-state").AddForm,
) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void
