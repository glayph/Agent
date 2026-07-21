import { IconChevronDown, IconEye, IconEyeOff } from "@tabler/icons-react"
import { type ReactNode, useId, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  FieldControlProvider,
  FieldDescription,
  FieldLabel,
  Field as UiField,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

type FieldLayout = "default" | "setting-row"

interface FieldProps {
  label: string
  hint?: string
  error?: string
  required?: boolean
  labelFor?: string
  descriptionId?: string
  errorId?: string
  children: ReactNode
  layout?: FieldLayout
  controlClassName?: string
}

export function Field({
  label,
  hint,
  error,
  required,
  labelFor,
  descriptionId,
  errorId,
  children,
  layout = "default",
  controlClassName,
}: FieldProps) {
  const generatedControlId = useId()
  const controlId = labelFor ?? generatedControlId
  const hintId = hint
    ? (descriptionId ?? `${controlId}-description`)
    : undefined
  const validationId = error ? (errorId ?? `${controlId}-error`) : undefined
  const describedBy =
    [hintId, validationId].filter(Boolean).join(" ") || undefined

  if (layout === "setting-row") {
    return (
      <div className="flex flex-col gap-4 py-4 md:grid md:grid-cols-[280px_minmax(0,1fr)] md:items-center md:gap-8">
        <div className="w-full min-w-0">
          <FieldLabel
            className="leading-relaxed break-words whitespace-normal"
            htmlFor={controlId}
          >
            {label}
            {required && <span className="text-destructive ml-1">*</span>}
          </FieldLabel>
          {hint && (
            <FieldDescription
              id={hintId}
              className="mt-1 text-xs leading-relaxed break-words whitespace-normal"
            >
              {hint}
            </FieldDescription>
          )}
        </div>
        <div
          className={cn(
            "w-full md:max-w-[28rem] md:justify-self-end",
            controlClassName,
          )}
        >
          <FieldControlProvider controlId={controlId} describedBy={describedBy}>
            {children}
          </FieldControlProvider>
        </div>
        {error && (
          <FieldDescription
            id={validationId}
            role="alert"
            className="text-destructive text-xs leading-normal md:col-start-2 md:justify-self-end"
          >
            {error}
          </FieldDescription>
        )}
      </div>
    )
  }

  return (
    <UiField className="gap-2.5">
      <div className="space-y-1">
        <FieldLabel htmlFor={controlId}>
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </FieldLabel>
        {hint && (
          <FieldDescription id={hintId} className="text-xs leading-normal">
            {hint}
          </FieldDescription>
        )}
      </div>
      <FieldControlProvider controlId={controlId} describedBy={describedBy}>
        {children}
      </FieldControlProvider>
      {error && (
        <FieldDescription
          id={validationId}
          role="alert"
          className="text-destructive text-xs leading-normal"
        >
          {error}
        </FieldDescription>
      )}
    </UiField>
  )
}

interface KeyInputProps {
  id?: string
  name?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  ariaDescribedBy?: string
  className?: string
  disabled?: boolean
}

export function KeyInput({
  id,
  name,
  value,
  onChange,
  placeholder,
  autoComplete,
  ariaDescribedBy,
  className,
  disabled = false,
}: KeyInputProps) {
  const { t } = useTranslation()
  const [show, setShow] = useState(false)
  const visibilityLabel = show
    ? t("common.hide_secret", "Hide secret")
    : t("common.show_secret", "Show secret")

  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-describedby={ariaDescribedBy}
        className={cn("pr-10", className)}
        disabled={disabled}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2 transition-colors"
        disabled={disabled}
        aria-label={visibilityLabel}
        title={visibilityLabel}
      >
        {show ? (
          <IconEyeOff className="size-4" aria-hidden="true" />
        ) : (
          <IconEye className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  )
}

interface SwitchCardFieldProps {
  label: string
  hint?: string
  error?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  ariaLabel?: string
  disabled?: boolean
  children?: ReactNode
  layout?: FieldLayout
  transparent?: boolean
}

export function SwitchCardField({
  label,
  hint,
  error,
  checked,
  onCheckedChange,
  ariaLabel,
  disabled,
  children,
  layout = "default",
  transparent,
}: SwitchCardFieldProps) {
  if (layout === "setting-row") {
    return (
      <div className="flex flex-col gap-4 py-4 md:grid md:grid-cols-[280px_minmax(0,1fr)] md:items-center md:gap-8">
        <div className="w-full min-w-0">
          <p className="text-sm leading-relaxed font-medium break-words whitespace-normal">
            {label}
          </p>
          {hint && (
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed break-words whitespace-normal">
              {hint}
            </p>
          )}
        </div>
        <div className="flex items-center md:justify-self-end">
          <Switch
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
            aria-label={ariaLabel ?? label}
          />
        </div>
        {children && (
          <div className="mt-1 flex w-full justify-end md:col-start-2">
            <div className="w-full md:max-w-[28rem]">{children}</div>
          </div>
        )}
        {error && (
          <p className="text-destructive text-xs leading-normal md:col-start-2 md:justify-self-end">
            {error}
          </p>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        transparent ? "py-1" : "border-border/60 rounded-lg border px-4 py-3",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {hint && (
            <p className="text-muted-foreground mt-0.5 text-xs leading-normal">
              {hint}
            </p>
          )}
        </div>
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
        />
      </div>
      {children && <div className="mt-4">{children}</div>}
      {error && (
        <p className="text-destructive mt-2 text-xs leading-normal">{error}</p>
      )}
    </div>
  )
}

interface AdvancedSectionProps {
  children: ReactNode
}

export function AdvancedSection({ children }: AdvancedSectionProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const contentId = useId()

  return (
    <div className="border-border/50 rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={contentId}
        className="hover:bg-muted/40 flex w-full items-center justify-between rounded-lg px-4 py-3 transition-colors"
      >
        <span className="text-muted-foreground text-sm">
          {t("models.advanced.toggle")}
        </span>
        <IconChevronDown
          className={[
            "text-muted-foreground size-4 transition-transform duration-200",
            open ? "rotate-180" : "",
          ].join(" ")}
        />
      </button>
      {open && (
        <div
          id={contentId}
          className="border-border/30 space-y-5 border-t px-4 pt-4 pb-4"
        >
          {children}
        </div>
      )}
    </div>
  )
}
