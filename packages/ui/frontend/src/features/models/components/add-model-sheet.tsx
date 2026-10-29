import { useEffect, useId, useRef, useState } from "react"
import type { ChangeEvent } from "react"
import { useTranslation } from "react-i18next"

import type { ModelInfo, ModelProviderOption } from "@/api/models"
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/shared/ui/sheet"

import { AddModelAdvancedFields } from "./add-model-advanced-fields"
import { AddModelCredentials } from "./add-model-credentials"
import { AddModelDialogs } from "./add-model-dialogs"
import { createAddModelFieldIds } from "./add-model-field-ids"
import { placeholderText } from "./add-model-field-utils"
import { FormRow, SwitchRow } from "./add-model-fields"
import { AddModelFooter } from "./add-model-footer"
import { type AddForm, EMPTY_ADD_FORM } from "./add-model-form-state"
import { AddModelIdField } from "./add-model-id-field"
import { applyProviderChange } from "./add-model-provider-change"
import { getAddModelProviderContext } from "./add-model-provider-context"
import type { ModelFilePickerKind } from "./model-file-picker-dialog"
import { getSubmittedAPIBase } from "./model-provider-form-shared"
import { ProviderCombobox } from "./provider-combobox"
import {
  getCanonicalProviderKey,
  getProviderCatalogEntry,
  getProviderDefaultAPIBase,
} from "./provider-registry"
import { useAddModelSubmit } from "./use-add-model-submit"
import { useAddModelValidation } from "./use-add-model-validation"
import { useCatalogModels } from "./use-catalog-models"
import { useModelSelection } from "./use-model-selection"

interface AddModelSheetProps {
  open: boolean
  onClose: () => void
  onSaved: () => void
  existingModelNames: string[]
  existingModels?: ModelInfo[]
  providerOptions?: ModelProviderOption[]
}

export function AddModelSheet({
  open,
  onClose,
  onSaved,
  existingModelNames,
  existingModels = [],
  providerOptions,
}: AddModelSheetProps) {
  const { t } = useTranslation()
  const formId = useId()
  const fieldIds = createAddModelFieldIds(formId)
  const errorId = (key: keyof typeof fieldIds) => `${fieldIds[key]}-error`
  const [form, setForm] = useState<AddForm>(EMPTY_ADD_FORM)
  const [setAsDefault, setSetAsDefault] = useState(false)
  const [fetchOpen, setFetchOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [filePickerKind, setFilePickerKind] =
    useState<ModelFilePickerKind | null>(null)
  const selection = useModelSelection()
  const {
    fetchedModels,
    selectedModels,
    setSelectedModels,
    resetAll: resetSelectionAll,
  } = selection
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const catalogModels = useCatalogModels(
    form.provider,
    form.apiBase,
    providerOptions,
  )
  const {
    canonicalProvider,
    providerDef,
    commonModels,
    authMethodLocked,
    defaultAuthMethod,
    effectiveAuthMethod,
    isOAuth,
    effectiveApiBase,
    supportsFetch,
    missingApiKey,
    defaultModelAllowed,
  } = getAddModelProviderContext(form, providerOptions)
  const alreadyAddedModelIds = existingModels
    .filter(
      (model) =>
        getCanonicalProviderKey(model.provider ?? "", providerOptions) ===
        canonicalProvider,
    )
    .map((model) => model.model)
  const isDirty =
    JSON.stringify(form) !== JSON.stringify(EMPTY_ADD_FORM) ||
    setAsDefault ||
    selectedModels.length > 0
  useUnsavedChangesGuard(open && isDirty)

  const validation = useAddModelValidation({
    form,
    providerIsValid: Boolean(providerDef),
    existingModelNames,
    selectedModels,
    providerOptions,
  })
  const {
    fieldErrors,
    clearFieldError,
    modelValidation,
    setModelValidation,
    validateModelLater,
  } = validation

  const submit = useAddModelSubmit({
    form,
    setAsDefault,
    selectedModels,
    existingModelNames,
    provider: canonicalProvider,
    submittedApiBase: getSubmittedAPIBase(form.apiBase),
    authMethodLocked,
    defaultAuthMethod,
    validate: validation.validate,
    onSaved,
    onClose,
    setSelectedModels,
    setModelFailures: selection.setModelFailures,
    setSetAsDefault,
  })
  const { reset: resetSubmit } = submit
  const { reset: resetValidation } = validation

  useEffect(() => {
    if (!open) return
    setForm(EMPTY_ADD_FORM)
    setSetAsDefault(false)
    resetValidation()
    resetSelectionAll()
    resetSubmit()
  }, [open, resetSelectionAll, resetSubmit, resetValidation])

  const setField =
    (key: keyof AddForm) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }))
      clearFieldError(key)
    }

  const handleModelChange = (e: ChangeEvent<HTMLInputElement>) => {
    selection.clearSelection()
    setForm((f) => ({ ...f, model: e.target.value }))
    clearFieldError("model")
    validateModelLater(e.target.value, form.provider)
  }

  const providerCanBeDefault = (provider: string) =>
    getProviderCatalogEntry(provider, providerOptions)?.defaultModelAllowed ??
    false

  const handleProviderChange = (provider: string) => {
    selection.resetAll()
    setForm((f) => applyProviderChange(f, provider, providerOptions))
    if (form.model) validateModelLater(form.model, provider)
    if (!providerCanBeDefault(provider)) setSetAsDefault(false)
    clearFieldError("provider")
  }

  const handleCommonModel = (modelId: string) => {
    selection.clearSelection()
    setForm((f) => ({ ...f, model: modelId }))
    setModelValidation(null)
    clearFieldError("model")
  }

  const handleFetchFill = (models: string[]) => {
    const plan = selection.applyFetched(models)
    setModelValidation(null)
    if (plan.modelField !== null) {
      setForm((f) => ({ ...f, model: plan.modelField ?? "" }))
    }
    clearFieldError("model")
  }

  const suggestions = [
    ...new Set([...commonModels, ...catalogModels, ...fetchedModels]),
  ]

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        className="flex flex-col gap-0 p-0 data-[side=right]:!w-full data-[side=right]:sm:!w-[440px] data-[side=right]:sm:!max-w-[440px]"
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-base font-semibold tracking-tight">
            {t("models.add.button")}
          </SheetTitle>
        </SheetHeader>

        <div
          className="min-h-0 flex-1 overflow-y-auto"
          ref={scrollContainerRef}
        >
          <div className="space-y-4 px-5 py-4">
            <FormRow
              label={t("models.field.provider")}
              htmlFor={fieldIds.provider}
              error={fieldErrors.provider}
              errorId={errorId("provider")}
            >
              <ProviderCombobox
                id={fieldIds.provider}
                value={form.provider}
                onChange={handleProviderChange}
                placeholder={placeholderText(
                  t("models.field.providerPlaceholder"),
                )}
                ariaDescribedBy={
                  fieldErrors.provider ? errorId("provider") : undefined
                }
                backendOptions={providerOptions}
                filterCreateAllowed
                containerRef={scrollContainerRef}
              />
            </FormRow>

            <AddModelIdField
              id={fieldIds.model}
              value={form.model}
              placeholder={placeholderText(
                providerDef
                  ? commonModels[0] || "model-name"
                  : t("models.add.modelIdPlaceholder"),
              )}
              error={fieldErrors.model}
              errorId={errorId("model")}
              validation={modelValidation}
              onChange={handleModelChange}
              onApplyFix={() => {
                if (!modelValidation?.fix) return
                setForm((f) => ({ ...f, model: modelValidation.fix! }))
                setModelValidation(null)
              }}
              fetchAction={
                supportsFetch
                  ? {
                      disabled:
                        providerDef?.emptyApiKeyAllowed !== true &&
                        missingApiKey,
                      needsApiKey:
                        providerDef?.requiresApiKey !== false && missingApiKey,
                      onClick: () => setFetchOpen(true),
                    }
                  : undefined
              }
              selectedModels={selectedModels}
              modelFailures={selection.modelFailures}
              onRemoveSelected={selection.removeSelected}
              suggestions={suggestions}
              selectedSuggestion={form.model}
              onSelectSuggestion={handleCommonModel}
            />

            <AddModelCredentials
              form={form}
              setForm={setForm}
              setField={setField}
              apiKeyId={fieldIds.apiKey}
              isLocalRuntime={canonicalProvider === "llama.cpp"}
              isOAuth={isOAuth}
              onPickFile={setFilePickerKind}
            />

            <div className="border-t pt-5">
              <SwitchRow
                label={t("models.defaultOnSave.label")}
                checked={setAsDefault}
                onCheckedChange={setSetAsDefault}
                disabled={!defaultModelAllowed}
                title={
                  !defaultModelAllowed && form.provider
                    ? t("models.defaultOnSave.unsupportedProvider")
                    : undefined
                }
              />
            </div>

            <AddModelAdvancedFields
              form={form}
              fieldIds={fieldIds}
              fieldErrors={fieldErrors}
              errorId={errorId}
              setField={setField}
              setForm={setForm}
              isOAuth={isOAuth}
              authMethodLocked={authMethodLocked}
              defaultAuthMethod={defaultAuthMethod}
              apiBasePlaceholder={
                getProviderDefaultAPIBase(form.provider, providerOptions) ||
                "https://api.example.com/v1"
              }
              moreOpen={moreOpen}
              setMoreOpen={setMoreOpen}
              moreId={`${formId}-more`}
            />

            {submit.serverError && (
              <p
                role="alert"
                className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm"
              >
                {submit.serverError}
              </p>
            )}
          </div>
        </div>

        <AddModelFooter
          saving={submit.saving}
          canTest={
            Boolean(form.provider && form.model) && selectedModels.length === 0
          }
          canSave={isDirty && modelValidation?.level !== "error"}
          onTest={() => setTestOpen(true)}
          onCancel={onClose}
          onSave={submit.save}
        />
      </SheetContent>

      <AddModelDialogs
        provider={canonicalProvider}
        form={form}
        setForm={setForm}
        apiBase={effectiveApiBase}
        authMethod={effectiveAuthMethod}
        providerOptions={providerOptions}
        alreadyAddedModelIds={alreadyAddedModelIds}
        fetchOpen={fetchOpen}
        onFetchClose={() => setFetchOpen(false)}
        onFetchFill={handleFetchFill}
        testOpen={testOpen}
        onTestClose={() => setTestOpen(false)}
        filePickerKind={filePickerKind}
        onFilePickerKindChange={setFilePickerKind}
      />
    </Sheet>
  )
}
