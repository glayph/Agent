import { IconX } from "@tabler/icons-react"
import type { ChangeEvent } from "react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"

import { inputClass, joinIds } from "./add-model-field-utils"
import { FormRow } from "./add-model-fields"
import { ModelSuggestionBadges } from "./model-suggestion-badges"
import type { FieldValidation } from "./model-validation"

interface AddModelIdFieldProps {
  id: string
  value: string
  placeholder: string
  error?: string
  errorId: string
  validation: FieldValidation | null
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  onApplyFix: () => void
  /** Present only when the provider supports fetching models. */
  fetchAction?: { disabled: boolean; needsApiKey: boolean; onClick: () => void }
  selectedModels: string[]
  modelFailures: Record<string, string>
  onRemoveSelected: (modelId: string) => void
  suggestions: string[]
  selectedSuggestion: string
  onSelectSuggestion: (modelId: string) => void
}

function validationClass(validation: FieldValidation | null) {
  if (validation?.level === "error") return "text-destructive"
  if (validation?.level === "warning")
    return "text-yellow-600 dark:text-yellow-500"
  return "text-green-600 dark:text-green-500"
}

/** Model ID row: text input, visible "Fetch models" action and multi-select chips. */
export function AddModelIdField(props: AddModelIdFieldProps) {
  const { t } = useTranslation()
  const { validation, selectedModels, modelFailures, fetchAction } = props
  const validationId = `${props.id}-validation`
  const hasSelection = selectedModels.length > 0

  return (
    <FormRow
      label={t("models.add.modelId")}
      htmlFor={props.id}
      error={props.error && !validation ? props.error : undefined}
      errorId={props.errorId}
      action={
        fetchAction ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs shadow-none"
            onClick={fetchAction.onClick}
            disabled={fetchAction.disabled}
            aria-label={t("models.fetch.title")}
            title={t("models.fetch.title")}
          >
            {t("models.fetch.title")}
          </Button>
        ) : undefined
      }
    >
      <Input
        id={props.id}
        name="model"
        value={hasSelection ? "" : props.value}
        onChange={props.onChange}
        placeholder={props.placeholder}
        autoComplete="off"
        className={cn(inputClass, "font-mono text-sm")}
        aria-invalid={!!props.error || validation?.level === "error"}
        aria-describedby={joinIds(
          validation?.messageKey && validationId,
          props.error && !validation && props.errorId,
        )}
      />
      {fetchAction?.needsApiKey && (
        <p className="text-muted-foreground pt-0.5 text-[11px]">
          {t("models.fetch.needApiKey")}
        </p>
      )}
      {hasSelection && (
        <div
          className="flex flex-wrap gap-1.5 pt-1"
          aria-label={t("models.fetch.selectedModels")}
        >
          {selectedModels.map((modelId) => (
            <span
              key={modelId}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
                modelFailures[modelId]
                  ? "border-destructive/40 bg-destructive/5 text-destructive"
                  : "border-border bg-muted/30",
              )}
              title={modelFailures[modelId]}
            >
              <span className="max-w-[220px] truncate">{modelId}</span>
              {modelFailures[modelId] && (
                <span className="font-sans">
                  {t("models.fetch.failedBadge")}
                </span>
              )}
              <button
                type="button"
                className="hover:bg-muted rounded-sm p-0.5"
                aria-label={t("models.fetch.removeSelected", {
                  model: modelId,
                })}
                onClick={() => props.onRemoveSelected(modelId)}
              >
                <IconX className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      {validation?.messageKey && !hasSelection && (
        <div
          id={validationId}
          className={cn(
            "flex items-center gap-2 text-xs",
            validationClass(validation),
          )}
        >
          <span>{t(validation.messageKey, validation.messageParams)}</span>
          {validation.fix && (
            <button
              type="button"
              onClick={props.onApplyFix}
              className="text-primary underline hover:no-underline"
            >
              {t("common.fix")}
            </button>
          )}
        </div>
      )}
      <ModelSuggestionBadges
        models={props.suggestions}
        selectedModel={props.selectedSuggestion}
        onSelect={props.onSelectSuggestion}
        pageSize={8}
      />
    </FormRow>
  )
}
