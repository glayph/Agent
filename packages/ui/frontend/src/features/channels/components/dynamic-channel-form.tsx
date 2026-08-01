import { useTranslation } from "react-i18next"

import { Input } from "@/shared/ui/input"
import { Label } from "@/shared/ui/label"
import { Switch } from "@/shared/ui/switch"

export interface FieldSchema {
  key: string
  labelKey: string
  type: "text" | "password" | "boolean" | "number"
  placeholderKey?: string
  required?: boolean
  descriptionKey?: string
}

export interface DynamicChannelFormProps {
  fields: FieldSchema[]
  config: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  configuredSecrets?: Record<string, boolean>
  fieldErrors?: Record<string, string>
}

export function DynamicChannelForm({
  fields,
  config,
  onChange,
  configuredSecrets = {},
  fieldErrors = {},
}: DynamicChannelFormProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-4">
      {fields.map((field) => {
        const value = config[field.key] ?? ""
        const isSecret = field.type === "password"
        const isConfigured = Boolean(configuredSecrets[field.key])
        const error = fieldErrors[field.key]

        if (field.type === "boolean") {
          return (
            <div
              key={field.key}
              className="border-border/60 bg-card flex items-center justify-between rounded-xl border p-4"
            >
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={field.key} className="text-sm font-medium">
                  {t(field.labelKey)}
                </Label>
                {field.descriptionKey && (
                  <span className="text-muted-foreground text-xs">
                    {t(field.descriptionKey)}
                  </span>
                )}
              </div>
              <Switch
                id={field.key}
                checked={Boolean(value)}
                onCheckedChange={(checked) => onChange(field.key, checked)}
              />
            </div>
          )
        }

        return (
          <div key={field.key} className="flex flex-col gap-2">
            <Label htmlFor={field.key} className="text-xs font-medium">
              {t(field.labelKey)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={field.key}
              type={field.type}
              value={String(value)}
              onChange={(e) => onChange(field.key, e.target.value)}
              placeholder={
                isSecret && isConfigured
                  ? t("common.secretConfiguredPlaceholder", {
                      defaultValue: "•••••••• (Configured)",
                    })
                  : field.placeholderKey
                    ? t(field.placeholderKey)
                    : ""
              }
            />
            {error && <p className="text-destructive text-xs">{error}</p>}
          </div>
        )
      })}
    </div>
  )
}
