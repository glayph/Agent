import {
  IconDownload,
  IconLoader2,
  IconPlugConnected,
} from "@tabler/icons-react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  type ModelProviderOption,
  addModel,
  getCatalogs,
  setDefaultModel,
} from "@/api/models"
import { ConfigChangeNotice } from "@/components/config-change-notice"
import { maskedSecretPlaceholder } from "@/components/secret-placeholder"
import {
  AdvancedSection,
  Field,
  KeyInput,
  SwitchCardField,
} from "@/components/shared-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard"
import { showSaveSuccessOrRestartToast } from "@/lib/restart-required"
import { refreshGatewayState } from "@/store/gateway"

import { FetchModelsDialog } from "./fetch-models-dialog"
import {
  getEffectiveAPIBase,
  getSubmittedAPIBase,
  normalizeApiBase,
} from "./model-provider-form-shared"
import { ModelSuggestionBadges } from "./model-suggestion-badges"
import { type FieldValidation, validateModelField } from "./model-validation"
import { ProviderCombobox } from "./provider-combobox"
import {
  getCanonicalProviderKey,
  getProviderCatalogEntry,
  getProviderCatalogMap,
  getProviderDefaultAPIBase,
  getProviderDefaultAuthMethod,
  isProviderAuthMethodLocked,
  providerSupportsFetch,
} from "./provider-registry"
import { TestModelDialog } from "./test-model-dialog"

interface AddForm {
  modelName: string
  provider: string
  model: string
  apiBase: string
  apiKey: string
  proxy: string
  authMethod: string
  connectMode: string
  workspace: string
  rpm: string
  maxTokensField: string
  requestTimeout: string
  thinkingLevel: string
  toolSchemaTransform: string
  streamingEnabled: boolean
  extraBody: string
  customHeaders: string
}

const EMPTY_ADD_FORM: AddForm = {
  modelName: "",
  provider: "",
  model: "",
  apiBase: "",
  apiKey: "",
  proxy: "",
  authMethod: "",
  connectMode: "",
  workspace: "",
  rpm: "",
  maxTokensField: "",
  requestTimeout: "",
  thinkingLevel: "",
  toolSchemaTransform: "",
  streamingEnabled: false,
  extraBody: "",
  customHeaders: "",
}

function joinIds(...ids: Array<string | false | null | undefined>) {
  const value = ids.filter(Boolean).join(" ")
  return value || undefined
}

function placeholderText(value: string) {
  const trimmed = value.trim()
  if (!trimmed || trimmed.endsWith("…")) return value
  return `${trimmed}…`
}

interface AddModelSheetProps {
  open: boolean
  onClose: () => void
  onSaved: () => void
  existingModelNames: string[]
  providerOptions?: ModelProviderOption[]
}

export function AddModelSheet({
  open,
  onClose,
  onSaved,
  existingModelNames,
  providerOptions,
}: AddModelSheetProps) {
  const { t } = useTranslation()
  const formId = useId()
  const [form, setForm] = useState<AddForm>(EMPTY_ADD_FORM)
  const [saving, setSaving] = useState(false)
  const [setAsDefault, setSetAsDefault] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof AddForm, string>>
  >({})
  const [serverError, setServerError] = useState("")
  const [modelValidation, setModelValidation] =
    useState<FieldValidation | null>(null)
  const [fetchOpen, setFetchOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [catalogModels, setCatalogModels] = useState<string[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const providerMap = getProviderCatalogMap(providerOptions)
  const fieldIds = {
    modelName: `${formId}-model-name`,
    provider: `${formId}-provider`,
    model: `${formId}-model-id`,
    apiKey: `${formId}-api-key`,
    apiBase: `${formId}-api-base`,
    proxy: `${formId}-proxy`,
    authMethod: `${formId}-auth-method`,
    connectMode: `${formId}-connect-mode`,
    workspace: `${formId}-workspace`,
    requestTimeout: `${formId}-request-timeout`,
    rpm: `${formId}-rpm`,
    thinkingLevel: `${formId}-thinking-level`,
    maxTokensField: `${formId}-max-tokens-field`,
    toolSchemaTransform: `${formId}-tool-schema-transform`,
    extraBody: `${formId}-extra-body`,
    customHeaders: `${formId}-custom-headers`,
  }
  const hintId = (key: keyof typeof fieldIds) => `${fieldIds[key]}-hint`
  const errorId = (key: keyof typeof fieldIds) => `${fieldIds[key]}-error`

  const apiKeyPlaceholder = maskedSecretPlaceholder(
    form.apiKey,
    placeholderText(t("models.field.apiKeyPlaceholder")),
  )
  const isDirty =
    JSON.stringify(form) !== JSON.stringify(EMPTY_ADD_FORM) || setAsDefault
  useUnsavedChangesGuard(open && isDirty)

  useEffect(() => {
    if (open) {
      setForm(EMPTY_ADD_FORM)
      setSetAsDefault(false)
      setFieldErrors({})
      setServerError("")
      setModelValidation(null)
      setFetchedModels([])
      setCatalogModels([])
    }
  }, [open])

  // Load catalog models when provider or apiBase changes
  useEffect(() => {
    const providerKey = getCanonicalProviderKey(form.provider, providerOptions)
    const apiBase = getEffectiveAPIBase(
      form.provider,
      form.apiBase,
      providerOptions,
    )
    if (!form.provider.trim()) {
      setCatalogModels([])
      return
    }
    let cancelled = false
    getCatalogs()
      .then((res) => {
        if (cancelled) return
        const matched = (res.entries || []).filter((e) => {
          const ep = getCanonicalProviderKey(e.provider, providerOptions)
          const eb = (e.api_base ?? "").trim().replace(/\/+$/, "")
          return ep === providerKey && eb === apiBase
        })
        const ids = matched.flatMap((e) => e.models.map((m) => m.id))
        const unique = [...new Set(ids)]
        setCatalogModels(unique)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [form.provider, form.apiBase, providerOptions])

  const validate = (): boolean => {
    const errors: Partial<Record<keyof AddForm, string>> = {}
    const modelName = form.modelName.trim()
    if (!modelName) {
      errors.modelName = t("models.add.errorRequired")
    } else if (existingModelNames.some((name) => name.trim() === modelName)) {
      errors.modelName = t("models.add.errorDuplicateModelName")
    }
    if (!providerDef) {
      errors.provider = t("models.field.providerInvalid")
    }
    if (!form.model.trim()) errors.model = t("models.add.errorRequired")
    if (modelValidation?.level === "error") {
      errors.model = t(
        modelValidation.messageKey,
        modelValidation.messageParams,
      )
    }
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const setField =
    (key: keyof AddForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }))
      if (fieldErrors[key]) {
        setFieldErrors((prev) => ({ ...prev, [key]: undefined }))
      }
    }

  const debouncedValidateModel = useCallback(
    (value: string, provider: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        const result = validateModelField(
          value,
          provider || undefined,
          providerOptions,
        )
        setModelValidation(result)
      }, 300)
    },
    [providerOptions],
  )

  const handleModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setForm((f) => ({ ...f, model: value }))
    if (fieldErrors.model) {
      setFieldErrors((prev) => ({ ...prev, model: undefined }))
    }
    debouncedValidateModel(value, form.provider)
  }

  const handleProviderChange = (provider: string) => {
    setForm((f) => {
      const previousOption = getProviderCatalogEntry(
        f.provider,
        providerOptions,
      )
      const nextOption = getProviderCatalogEntry(provider, providerOptions)
      const previousDefaultBase = normalizeApiBase(
        getProviderDefaultAPIBase(f.provider, providerOptions),
      )
      const nextDefaultBase = normalizeApiBase(
        getProviderDefaultAPIBase(provider, providerOptions),
      )
      const currentApiBase = normalizeApiBase(f.apiBase)
      let authMethod = f.authMethod
      let apiBase = f.apiBase
      if (nextOption?.authMethodLocked) {
        authMethod = nextOption.defaultAuthMethod ?? ""
      } else if (
        previousOption?.authMethodLocked &&
        f.authMethod === (previousOption.defaultAuthMethod ?? "")
      ) {
        authMethod = ""
      }
      if (
        currentApiBase &&
        previousDefaultBase &&
        currentApiBase === previousDefaultBase &&
        currentApiBase !== nextDefaultBase
      ) {
        apiBase = ""
      }
      return {
        ...f,
        provider: getCanonicalProviderKey(provider, providerOptions),
        apiBase,
        authMethod,
      }
    })
    // Re-validate model with new provider context
    if (form.model) {
      debouncedValidateModel(form.model, provider)
    }
    // Clear setAsDefault if the new provider doesn't support being default
    const allowed =
      getProviderCatalogEntry(provider, providerOptions)?.defaultModelAllowed ??
      false
    if (!allowed) {
      setSetAsDefault(false)
    }
    if (fieldErrors.provider) {
      setFieldErrors((prev) => ({ ...prev, provider: undefined }))
    }
  }

  const applyFix = () => {
    if (modelValidation?.fix) {
      setForm((f) => ({ ...f, model: modelValidation.fix! }))
      setModelValidation(null)
    }
  }

  const handleCommonModel = (modelId: string) => {
    setForm((f) => ({ ...f, model: modelId }))
    setModelValidation(null)
    if (fieldErrors.model) {
      setFieldErrors((prev) => ({ ...prev, model: undefined }))
    }
  }

  const handleFetchFill = (models: string[]) => {
    setFetchedModels(models)
    if (models.length >= 1) {
      setForm((f) => ({ ...f, model: models[0] }))
      setModelValidation(null)
      if (fieldErrors.model) {
        setFieldErrors((prev) => ({ ...prev, model: undefined }))
      }
    }
  }

  const canonicalProvider = getCanonicalProviderKey(
    form.provider,
    providerOptions,
  )
  const providerDef = canonicalProvider
    ? providerMap.get(canonicalProvider)
    : undefined
  const commonModels = providerDef?.commonModels || []
  const authMethodLocked = isProviderAuthMethodLocked(
    form.provider,
    providerOptions,
  )
  const defaultAuthMethod = getProviderDefaultAuthMethod(
    form.provider,
    providerOptions,
  )
  const effectiveAuthMethod = (
    authMethodLocked ? defaultAuthMethod : form.authMethod
  )
    .trim()
    .toLowerCase()
  const isOAuth = effectiveAuthMethod === "oauth"
  const defaultModelAllowed = providerDef?.defaultModelAllowed === true
  const apiBasePlaceholder =
    getProviderDefaultAPIBase(form.provider, providerOptions) ||
    "https://api.example.com/v1"
  const effectiveApiBase = getEffectiveAPIBase(
    form.provider,
    form.apiBase,
    providerOptions,
  )
  const submittedApiBase = getSubmittedAPIBase(form.apiBase)

  const handleSave = async () => {
    if (!validate()) return

    let extraBody: Record<string, unknown> | undefined
    let customHeaders: Record<string, string> | undefined
    try {
      if (form.extraBody.trim()) {
        extraBody = JSON.parse(form.extraBody.trim())
      } else {
        extraBody = {}
      }
    } catch {
      setServerError(
        t("models.field.extraBody") + ": " + t("models.field.invalidJson"),
      )
      return
    }
    try {
      if (form.customHeaders.trim()) {
        customHeaders = JSON.parse(form.customHeaders.trim())
      } else {
        customHeaders = {}
      }
    } catch {
      setServerError(
        t("models.field.customHeaders") + ": " + t("models.field.invalidJson"),
      )
      return
    }

    setSaving(true)
    setServerError("")
    try {
      const modelName = form.modelName.trim()
      const provider = canonicalProvider
      const modelId = form.model.trim()
      await addModel({
        model_name: modelName,
        provider: provider || undefined,
        model: modelId,
        api_base: submittedApiBase,
        api_key: form.apiKey.trim() || undefined,
        proxy: form.proxy.trim() || undefined,
        auth_method: authMethodLocked
          ? defaultAuthMethod || undefined
          : form.authMethod.trim() || undefined,
        connect_mode: form.connectMode.trim() || undefined,
        workspace: form.workspace.trim() || undefined,
        rpm: form.rpm ? Number(form.rpm) : undefined,
        max_tokens_field: form.maxTokensField.trim() || undefined,
        request_timeout: form.requestTimeout
          ? Number(form.requestTimeout)
          : undefined,
        thinking_level: form.thinkingLevel.trim() || undefined,
        tool_schema_transform: form.toolSchemaTransform.trim() || undefined,
        streaming: form.streamingEnabled ? { enabled: true } : undefined,
        extra_body: extraBody,
        custom_headers: customHeaders,
      })
      if (setAsDefault) {
        await setDefaultModel(modelName)
      }
      const gateway = await refreshGatewayState({ force: true })
      showSaveSuccessOrRestartToast(
        t,
        t("models.add.saveSuccess"),
        modelName,
        gateway?.restartRequired === true,
      )
      onSaved()
      onClose()
    } catch (e) {
      setServerError(e instanceof Error ? e.message : t("models.add.saveError"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent
          side="right"
          className="flex flex-col gap-0 p-0 data-[side=right]:!w-full data-[side=right]:sm:!w-[560px] data-[side=right]:sm:!max-w-[560px]"
        >
          <SheetHeader className="border-b-muted border-b px-6 py-5">
            <SheetTitle className="text-base">
              {t("models.add.title")}
            </SheetTitle>
            <SheetDescription className="text-xs">
              {t("models.add.description")}
            </SheetDescription>
          </SheetHeader>

          <div
            className="min-h-0 flex-1 overflow-y-auto"
            ref={scrollContainerRef}
          >
            <div className="space-y-5 px-6 py-5">
              <Field
                label={t("models.add.modelName")}
                hint={t("models.add.modelNameHint")}
                labelFor={fieldIds.modelName}
                descriptionId={hintId("modelName")}
              >
                <Input
                  id={fieldIds.modelName}
                  name="model_name"
                  value={form.modelName}
                  onChange={setField("modelName")}
                  placeholder={placeholderText(
                    t("models.add.modelNamePlaceholder"),
                  )}
                  autoComplete="off"
                  aria-invalid={!!fieldErrors.modelName}
                  aria-describedby={joinIds(
                    hintId("modelName"),
                    fieldErrors.modelName && errorId("modelName"),
                  )}
                />
                {fieldErrors.modelName && (
                  <p
                    id={errorId("modelName")}
                    className="text-destructive text-xs"
                  >
                    {fieldErrors.modelName}
                  </p>
                )}
              </Field>

              <Field
                label={t("models.field.provider")}
                hint={t("models.field.providerHint")}
                error={fieldErrors.provider}
                labelFor={fieldIds.provider}
                descriptionId={hintId("provider")}
                errorId={errorId("provider")}
                required
              >
                <ProviderCombobox
                  id={fieldIds.provider}
                  value={form.provider}
                  onChange={handleProviderChange}
                  placeholder={placeholderText(
                    t("models.field.providerPlaceholder"),
                  )}
                  ariaDescribedBy={joinIds(
                    hintId("provider"),
                    fieldErrors.provider && errorId("provider"),
                  )}
                  backendOptions={providerOptions}
                  filterCreateAllowed
                  containerRef={scrollContainerRef}
                />
              </Field>

              <Field
                label={t("models.add.modelId")}
                hint={t("models.add.modelIdHint")}
                labelFor={fieldIds.model}
                descriptionId={hintId("model")}
              >
                <Input
                  id={fieldIds.model}
                  name="model"
                  value={form.model}
                  onChange={handleModelChange}
                  placeholder={
                    providerDef
                      ? placeholderText(`${commonModels[0] || "model-name"}`)
                      : placeholderText(t("models.add.modelIdPlaceholder"))
                  }
                  autoComplete="off"
                  className="font-mono text-sm"
                  aria-invalid={
                    !!fieldErrors.model || modelValidation?.level === "error"
                  }
                  aria-describedby={joinIds(
                    hintId("model"),
                    modelValidation?.messageKey &&
                      `${fieldIds.model}-validation`,
                    fieldErrors.model && !modelValidation && errorId("model"),
                  )}
                />
                {modelValidation && modelValidation.messageKey && (
                  <div
                    id={`${fieldIds.model}-validation`}
                    className={`flex items-center gap-2 text-xs ${
                      modelValidation.level === "error"
                        ? "text-destructive"
                        : modelValidation.level === "warning"
                          ? "text-yellow-600 dark:text-yellow-500"
                          : "text-green-600 dark:text-green-500"
                    }`}
                  >
                    <span>
                      {t(
                        modelValidation.messageKey,
                        modelValidation.messageParams,
                      )}
                    </span>
                    {modelValidation.fix && (
                      <button
                        type="button"
                        onClick={applyFix}
                        className="text-primary underline hover:no-underline"
                      >
                        {t("common.fix")}
                      </button>
                    )}
                  </div>
                )}
                {fieldErrors.model && !modelValidation && (
                  <p id={errorId("model")} className="text-destructive text-xs">
                    {fieldErrors.model}
                  </p>
                )}
                {commonModels.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {commonModels.map((m) => (
                      <Badge
                        key={m}
                        variant="secondary"
                        className="hover:bg-secondary/80 cursor-pointer font-mono text-xs"
                        asChild
                      >
                        <button
                          type="button"
                          onClick={() => handleCommonModel(m)}
                        >
                          {m}
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
                <ModelSuggestionBadges
                  models={catalogModels}
                  selectedModel={form.model}
                  onSelect={handleCommonModel}
                />
                <ModelSuggestionBadges
                  models={fetchedModels}
                  selectedModel={form.model}
                  onSelect={handleCommonModel}
                />
                <div className="flex items-center gap-2">
                  {providerSupportsFetch(form.provider, providerOptions) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setFetchOpen(true)}
                    >
                      <IconDownload className="size-3" aria-hidden="true" />
                      {t("models.fetch.title")}
                    </Button>
                  )}
                  {!form.provider && (
                    <span className="text-muted-foreground text-xs">
                      {t("models.field.selectProviderFirst")}
                    </span>
                  )}
                </div>
              </Field>

              {!isOAuth && (
                <Field
                  label={t("models.field.apiKey")}
                  labelFor={fieldIds.apiKey}
                >
                  <KeyInput
                    id={fieldIds.apiKey}
                    name="api_key"
                    value={form.apiKey}
                    onChange={(v) => setForm((f) => ({ ...f, apiKey: v }))}
                    placeholder={apiKeyPlaceholder}
                    autoComplete="off"
                  />
                </Field>
              )}

              <Field
                label={t("models.field.apiBase")}
                hint={isOAuth ? t("models.edit.oauthNote") : undefined}
                labelFor={fieldIds.apiBase}
                descriptionId={isOAuth ? hintId("apiBase") : undefined}
              >
                <Input
                  id={fieldIds.apiBase}
                  name="api_base"
                  value={form.apiBase}
                  onChange={setField("apiBase")}
                  placeholder={placeholderText(apiBasePlaceholder)}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  aria-describedby={isOAuth ? hintId("apiBase") : undefined}
                  disabled={isOAuth}
                />
              </Field>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTestOpen(true)}
                  disabled={!form.provider || !form.model}
                >
                  <IconPlugConnected className="size-4" aria-hidden="true" />
                  {t("models.test.testConnection")}
                </Button>
              </div>

              <SwitchCardField
                label={t("models.defaultOnSave.label")}
                hint={
                  !defaultModelAllowed && form.provider
                    ? t("models.defaultOnSave.unsupportedProvider")
                    : t("models.defaultOnSave.description")
                }
                checked={setAsDefault}
                onCheckedChange={setSetAsDefault}
                disabled={!defaultModelAllowed}
              />

              <AdvancedSection>
                <Field
                  label={t("models.field.proxy")}
                  hint={t("models.field.proxyHint")}
                  labelFor={fieldIds.proxy}
                  descriptionId={hintId("proxy")}
                >
                  <Input
                    id={fieldIds.proxy}
                    name="proxy"
                    value={form.proxy}
                    onChange={setField("proxy")}
                    placeholder={placeholderText("http://127.0.0.1:7890")}
                    inputMode="url"
                    autoComplete="off"
                    aria-describedby={hintId("proxy")}
                  />
                </Field>

                <Field
                  label={t("models.field.authMethod")}
                  hint={
                    authMethodLocked
                      ? t("models.field.authMethodManagedHint")
                      : t("models.field.authMethodHint")
                  }
                  labelFor={fieldIds.authMethod}
                  descriptionId={hintId("authMethod")}
                >
                  <Input
                    id={fieldIds.authMethod}
                    name="auth_method"
                    value={
                      authMethodLocked ? defaultAuthMethod : form.authMethod
                    }
                    onChange={setField("authMethod")}
                    placeholder={placeholderText("oauth")}
                    autoComplete="off"
                    aria-describedby={hintId("authMethod")}
                    disabled={authMethodLocked}
                  />
                </Field>

                <Field
                  label={t("models.field.connectMode")}
                  hint={t("models.field.connectModeHint")}
                  labelFor={fieldIds.connectMode}
                  descriptionId={hintId("connectMode")}
                >
                  <Input
                    id={fieldIds.connectMode}
                    name="connect_mode"
                    value={form.connectMode}
                    onChange={setField("connectMode")}
                    placeholder={placeholderText("stdio")}
                    autoComplete="off"
                    aria-describedby={hintId("connectMode")}
                  />
                </Field>

                <Field
                  label={t("models.field.workspace")}
                  hint={t("models.field.workspaceHint")}
                  labelFor={fieldIds.workspace}
                  descriptionId={hintId("workspace")}
                >
                  <Input
                    id={fieldIds.workspace}
                    name="workspace"
                    value={form.workspace}
                    onChange={setField("workspace")}
                    placeholder={placeholderText("/path/to/workspace")}
                    autoComplete="off"
                    aria-describedby={hintId("workspace")}
                  />
                </Field>

                <Field
                  label={t("models.field.requestTimeout")}
                  hint={t("models.field.requestTimeoutHint")}
                  labelFor={fieldIds.requestTimeout}
                  descriptionId={hintId("requestTimeout")}
                >
                  <Input
                    id={fieldIds.requestTimeout}
                    name="request_timeout"
                    value={form.requestTimeout}
                    onChange={setField("requestTimeout")}
                    placeholder={placeholderText("60")}
                    type="number"
                    inputMode="numeric"
                    autoComplete="off"
                    aria-describedby={hintId("requestTimeout")}
                    min={0}
                  />
                </Field>

                <Field
                  label={t("models.field.rpm")}
                  hint={t("models.field.rpmHint")}
                  labelFor={fieldIds.rpm}
                  descriptionId={hintId("rpm")}
                >
                  <Input
                    id={fieldIds.rpm}
                    name="rpm"
                    value={form.rpm}
                    onChange={setField("rpm")}
                    placeholder={placeholderText("60")}
                    type="number"
                    inputMode="numeric"
                    autoComplete="off"
                    aria-describedby={hintId("rpm")}
                    min={0}
                  />
                </Field>

                <Field
                  label={t("models.field.thinkingLevel")}
                  hint={t("models.field.thinkingLevelHint")}
                  labelFor={fieldIds.thinkingLevel}
                  descriptionId={hintId("thinkingLevel")}
                >
                  <Input
                    id={fieldIds.thinkingLevel}
                    name="thinking_level"
                    value={form.thinkingLevel}
                    onChange={setField("thinkingLevel")}
                    placeholder={placeholderText(
                      t("models.field.providerDefault"),
                    )}
                    autoComplete="off"
                    aria-describedby={hintId("thinkingLevel")}
                  />
                </Field>

                <Field
                  label={t("models.field.maxTokensField")}
                  hint={t("models.field.maxTokensFieldHint")}
                  labelFor={fieldIds.maxTokensField}
                  descriptionId={hintId("maxTokensField")}
                >
                  <Input
                    id={fieldIds.maxTokensField}
                    name="max_tokens_field"
                    value={form.maxTokensField}
                    onChange={setField("maxTokensField")}
                    placeholder={placeholderText("max_completion_tokens")}
                    autoComplete="off"
                    aria-describedby={hintId("maxTokensField")}
                  />
                </Field>

                <Field
                  label={t("models.field.toolSchemaTransform")}
                  hint={t("models.field.toolSchemaTransformHint")}
                  labelFor={fieldIds.toolSchemaTransform}
                  descriptionId={hintId("toolSchemaTransform")}
                >
                  <Input
                    id={fieldIds.toolSchemaTransform}
                    name="tool_schema_transform"
                    value={form.toolSchemaTransform}
                    onChange={setField("toolSchemaTransform")}
                    placeholder={placeholderText("google")}
                    autoComplete="off"
                    aria-describedby={hintId("toolSchemaTransform")}
                  />
                </Field>

                <SwitchCardField
                  label={t("models.field.streamingEnabled")}
                  hint={t("models.field.streamingEnabledHint")}
                  checked={form.streamingEnabled}
                  onCheckedChange={(checked) =>
                    setForm((f) => ({ ...f, streamingEnabled: checked }))
                  }
                  ariaLabel={t("models.field.streamingEnabled")}
                />

                <Field
                  label={t("models.field.extraBody")}
                  hint={t("models.field.extraBodyHint")}
                  labelFor={fieldIds.extraBody}
                  descriptionId={hintId("extraBody")}
                >
                  <Textarea
                    id={fieldIds.extraBody}
                    name="extra_body"
                    value={form.extraBody}
                    onChange={setField("extraBody")}
                    placeholder={placeholderText('{"key": "value"}')}
                    autoComplete="off"
                    aria-describedby={hintId("extraBody")}
                    rows={3}
                  />
                </Field>

                <Field
                  label={t("models.field.customHeaders")}
                  hint={t("models.field.customHeadersHint")}
                  labelFor={fieldIds.customHeaders}
                  descriptionId={hintId("customHeaders")}
                >
                  <Textarea
                    id={fieldIds.customHeaders}
                    name="custom_headers"
                    value={form.customHeaders}
                    onChange={setField("customHeaders")}
                    placeholder={placeholderText('{"X-Source": "coding-plan"}')}
                    autoComplete="off"
                    aria-describedby={hintId("customHeaders")}
                    rows={3}
                  />
                </Field>
              </AdvancedSection>

              {serverError && (
                <p className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
                  {serverError}
                </p>
              )}
            </div>
          </div>

          <SheetFooter className="border-t-muted border-t px-6 py-4">
            {isDirty && (
              <ConfigChangeNotice
                kind="save"
                title={t("common.saveChangesTitle")}
                description={t("models.unsavedPrompt")}
              />
            )}
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleSave}
              disabled={
                !isDirty || saving || modelValidation?.level === "error"
              }
            >
              {saving && <IconLoader2 className="size-4 animate-spin" />}
              {t("models.add.confirm")}
            </Button>
          </SheetFooter>
        </SheetContent>

        <FetchModelsDialog
          open={fetchOpen}
          onClose={() => setFetchOpen(false)}
          onFill={handleFetchFill}
          provider={canonicalProvider}
          apiKey={form.apiKey}
          apiBase={effectiveApiBase}
          backendOptions={providerOptions}
        />

        <TestModelDialog
          model={null}
          open={testOpen}
          onClose={() => setTestOpen(false)}
          inlineParams={{
            provider: canonicalProvider,
            model: form.model,
            apiBase: effectiveApiBase,
            apiKey: form.apiKey,
            authMethod: effectiveAuthMethod,
          }}
        />
      </Sheet>
    </>
  )
}
