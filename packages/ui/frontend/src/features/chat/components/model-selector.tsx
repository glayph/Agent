import { IconAtom } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import type { ModelInfo } from "@/api/models"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from "@/shared/ui/select"

interface ModelSelectorProps {
  defaultModelName: string
  defaultModelIndex: string
  apiKeyModels: ModelInfo[]
  oauthModels: ModelInfo[]
  localModels: ModelInfo[]
  /** Saved models that cannot run yet; listed but not selectable. */
  unavailableModels?: ModelInfo[]
  onValueChange: (modelIndex: number) => void
  compact?: boolean
  disabled?: boolean
}

export function ModelSelector({
  defaultModelName,
  defaultModelIndex,
  apiKeyModels,
  oauthModels,
  localModels,
  unavailableModels = [],
  onValueChange,
  compact = false,
  disabled = false,
}: ModelSelectorProps) {
  const { t } = useTranslation()
  const allModels = [...apiKeyModels, ...oauthModels, ...localModels, ...unavailableModels]
  const nameCounts = new Map<string, number>()
  for (const model of allModels) nameCounts.set(model.model_name, (nameCounts.get(model.model_name) ?? 0) + 1)
  const labelFor = (model: ModelInfo) => {
    if ((nameCounts.get(model.model_name) ?? 0) < 2) return model.model_name
    const provider = model.provider || model.auth_method || "custom"
    let endpoint = ""
    try { endpoint = model.api_base ? new URL(model.api_base).host : "" } catch { /* endpoint label is optional */ }
    return `${model.model_name} — ${provider}${endpoint ? ` · ${endpoint}` : ""}`
  }

  return (
    <Select
      value={defaultModelIndex}
      onValueChange={(value) => onValueChange(Number(value))}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label={defaultModelName || t("chat.noModel")}
        title={defaultModelName || t("chat.noModel")}
        className={compact
          ? "text-muted-foreground hover:text-foreground hover:bg-accent/25 size-8 min-w-8 shrink-0 justify-center border-transparent bg-transparent p-0 shadow-none focus-visible:border-transparent focus-visible:ring-0 [&>svg:last-child]:hidden"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/25 h-8 min-w-8 max-w-44 shrink-0 justify-start border-transparent bg-transparent px-2 shadow-none focus-visible:border-transparent focus-visible:ring-0 [&>svg:last-child]:size-3 [&>svg:last-child]:opacity-60"}
      >
        <IconAtom className="size-4" />
        {!compact && (
          <span className="max-w-32 truncate text-xs">
            {defaultModelName || t("chat.noModel")}
          </span>
        )}
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {apiKeyModels.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t("chat.modelGroup.apikey")}</SelectLabel>
            {apiKeyModels.map((model) => (
              <SelectItem key={model.index} value={String(model.index)}>
                {labelFor(model)}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {apiKeyModels.length > 0 &&
          (oauthModels.length > 0 || localModels.length > 0) && (
            <SelectSeparator />
          )}

        {oauthModels.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t("chat.modelGroup.oauth")}</SelectLabel>
            {oauthModels.map((model) => (
              <SelectItem key={model.index} value={String(model.index)}>
                {labelFor(model)}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {oauthModels.length > 0 &&
          (localModels.length > 0 || apiKeyModels.length > 0) && (
            <SelectSeparator />
          )}

        {localModels.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t("chat.modelGroup.local")}</SelectLabel>
            {localModels.map((model) => (
              <SelectItem key={model.index} value={String(model.index)}>
                {labelFor(model)}
              </SelectItem>
            ))}
          </SelectGroup>
        )}

        {unavailableModels.length > 0 && (
          <>
            {(apiKeyModels.length > 0 ||
              oauthModels.length > 0 ||
              localModels.length > 0) && <SelectSeparator />}
            <SelectGroup>
              <SelectLabel>
                {t("chat.modelGroup.unavailable", {
                  defaultValue: "Needs attention",
                })}
              </SelectLabel>
              {unavailableModels.map((model) => (
                <SelectItem
                  key={model.index}
                  value={String(model.index)}
                  disabled
                  title={model.status_reason}
                >
                  {labelFor(model)}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  )
}
