import {
  IconChevronDown,
  IconDownload,
  IconFolderOpen,
  IconLoader2,
  IconPlugConnected,
} from "@tabler/icons-react"
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  type LocalLlamaModelConfig,
  type ModelProviderOption,
  addModel,
  getCatalogs,
  setDefaultModel,
} from "@/api/models"
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard"
import { showSaveSuccessOrRestartToast } from "@/lib/restart-required"
import { cn } from "@/lib/utils"
import { maskedSecretPlaceholder } from "@/shared/forms/secret-placeholder"
import { KeyInput } from "@/shared/forms/shared-form"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet"
import { Switch } from "@/shared/ui/switch"
import { Textarea } from "@/shared/ui/textarea"
import { refreshGatewayState } from "@/store/gateway"

import { FetchModelsDialog } from "./fetch-models-dialog"
import {
  ModelFilePickerDialog,
  type ModelFilePickerKind,
} from "./model-file-picker-dialog"
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
  localModelPath: string
  localExecutablePath: string
  localPort: string
  localContextSize: string
  localGpuLayers: string
  localAutoStart: boolean
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
  localModelPath: "",
  localExecutablePath: "",
  localPort: "",
  localContextSize: "",
  localGpuLayers: "",
  localAutoStart: true,
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

const inputClass = "h-10 rounded-md shadow-none"

/** One labelled control: sentence-case label, optional trailing action, inline error only. */
function FormRow({
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

function SwitchRow({
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
  const [moreOpen, setMoreOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [filePickerKind, setFilePickerKind] =
    useState<ModelFilePickerKind | null>(null)
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

  const suggestions = [
    ...new Set([...commonModels, ...catalogModels, ...fetchedModels]),
  ]

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
      const local: LocalLlamaModelConfig | undefined =
        provider === "llama.cpp"
          ? {
              runtime: "llama.cpp",
              model_format: "gguf",
              model_path: form.localModelPath.trim() || undefined,
              executable_path: form.localExecutablePath.trim() || undefined,
              port: form.localPort ? Number(form.localPort) : undefined,
              context_size: form.localContextSize
                ? Number(form.localContextSize)
                : undefined,
              gpu_layers: form.localGpuLayers
                ? form.localGpuLayers === "auto"
                  ? "auto"
                  : Number(form.localGpuLayers)
                : undefined,
              enabled: true,
              auto_start: form.localAutoStart,
            }
          : undefined
      await addModel({
        model_name: modelName,
        provider: provider || undefined,
        model: modelId,
        api_base: submittedApiBase || undefined,
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
        local,
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

  const moreId = `${formId}-more`
  const modelStatusClass =
    modelValidation?.level === "error"
      ? "text-destructive"
      : modelValidation?.level === "warning"
        ? "text-yellow-600 dark:text-yellow-500"
        : "text-green-600 dark:text-green-500"

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent
          side="right"
          className="flex flex-col gap-0 p-0 data-[side=right]:!w-full data-[side=right]:sm:!w-[500px] data-[side=right]:sm:!max-w-[500px]"
        >
          <SheetHeader className="border-b px-7 py-5">
            <SheetTitle className="text-[1.25rem] leading-7 font-normal tracking-[-0.005em] [font-family:Georgia,'Times_New_Roman',serif]">
              {t("models.add.button")}
            </SheetTitle>
          </SheetHeader>

          <div
            className="min-h-0 flex-1 overflow-y-auto"
            ref={scrollContainerRef}
          >
            <div className="space-y-5 px-7 py-6">
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
                  ariaDescribedBy={joinIds(
                    fieldErrors.provider && errorId("provider"),
                  )}
                  backendOptions={providerOptions}
                  filterCreateAllowed
                  containerRef={scrollContainerRef}
                />
              </FormRow>

              <FormRow
                label={t("models.add.modelId")}
                htmlFor={fieldIds.model}
                error={
                  fieldErrors.model && !modelValidation
                    ? fieldErrors.model
                    : undefined
                }
                errorId={errorId("model")}
                action={
                  providerSupportsFetch(form.provider, providerOptions) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground -mr-1.5 size-7 rounded-md"
                      onClick={() => setFetchOpen(true)}
                      aria-label={t("models.fetch.title")}
                      title={t("models.fetch.title")}
                    >
                      <IconDownload className="size-4" aria-hidden="true" />
                    </Button>
                  ) : undefined
                }
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
                  className={cn(inputClass, "font-mono text-sm")}
                  aria-invalid={
                    !!fieldErrors.model || modelValidation?.level === "error"
                  }
                  aria-describedby={joinIds(
                    modelValidation?.messageKey &&
                      `${fieldIds.model}-validation`,
                    fieldErrors.model && !modelValidation && errorId("model"),
                  )}
                />
                {modelValidation && modelValidation.messageKey && (
                  <div
                    id={`${fieldIds.model}-validation`}
                    className={cn(
                      "flex items-center gap-2 text-xs",
                      modelStatusClass,
                    )}
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
                <ModelSuggestionBadges
                  models={suggestions}
                  selectedModel={form.model}
                  onSelect={handleCommonModel}
                  pageSize={8}
                />
              </FormRow>

              {canonicalProvider === "llama.cpp" ? (
                <div className="space-y-5">
                  <FormRow label="GGUF model">
                    <div className="flex gap-2">
                      <Input
                        value={form.localModelPath}
                        onChange={setField("localModelPath")}
                        placeholder="/models/model.Q4_K_M.gguf"
                        className={cn(inputClass, "min-w-0 flex-1 font-mono text-sm")}
                        aria-label="GGUF model"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-10 shrink-0 rounded-md shadow-none"
                        onClick={() => setFilePickerKind("llm")}
                        aria-label="Browse models"
                        title="Browse models"
                      >
                        <IconFolderOpen className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </FormRow>
                  <FormRow label="llama-server">
                    <div className="flex gap-2">
                      <Input
                        value={form.localExecutablePath}
                        onChange={setField("localExecutablePath")}
                        placeholder="/usr/local/bin/llama-server"
                        className={cn(inputClass, "min-w-0 flex-1 font-mono text-sm")}
                        aria-label="llama-server"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-10 shrink-0 rounded-md shadow-none"
                        onClick={() => setFilePickerKind("executable")}
                        aria-label="Browse executable"
                        title="Browse executable"
                      >
                        <IconFolderOpen className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </FormRow>
                  <div className="grid grid-cols-3 gap-3">
                    <FormRow label="Port">
                      <Input
                        value={form.localPort}
                        onChange={setField("localPort")}
                        placeholder="39200"
                        inputMode="numeric"
                        className={inputClass}
                        aria-label="Port"
                      />
                    </FormRow>
                    <FormRow label="Context">
                      <Input
                        value={form.localContextSize}
                        onChange={setField("localContextSize")}
                        placeholder="4096"
                        inputMode="numeric"
                        className={inputClass}
                        aria-label="Context size"
                      />
                    </FormRow>
                    <FormRow label="GPU layers">
                      <Input
                        value={form.localGpuLayers}
                        onChange={setField("localGpuLayers")}
                        placeholder="auto"
                        className={inputClass}
                        aria-label="GPU layers"
                      />
                    </FormRow>
                  </div>
                  <SwitchRow
                    label="Auto-start"
                    checked={form.localAutoStart}
                    onCheckedChange={(checked) =>
                      setForm((f) => ({ ...f, localAutoStart: checked }))
                    }
                  />
                </div>
              ) : (
                !isOAuth && (
                  <FormRow
                    label={t("models.field.apiKey")}
                    htmlFor={fieldIds.apiKey}
                  >
                    <KeyInput
                      id={fieldIds.apiKey}
                      name="api_key"
                      value={form.apiKey}
                      onChange={(v) => setForm((f) => ({ ...f, apiKey: v }))}
                      placeholder={apiKeyPlaceholder}
                      autoComplete="off"
                    />
                  </FormRow>
                )
              )}

              <FormRow
                label={t("models.field.apiBase")}
                htmlFor={fieldIds.apiBase}
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
                  className={inputClass}
                  disabled={isOAuth}
                />
              </FormRow>

              <FormRow
                label={t("models.add.modelName")}
                htmlFor={fieldIds.modelName}
                error={fieldErrors.modelName}
                errorId={errorId("modelName")}
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
                  className={inputClass}
                  aria-invalid={!!fieldErrors.modelName}
                  aria-describedby={joinIds(
                    fieldErrors.modelName && errorId("modelName"),
                  )}
                />
              </FormRow>

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

              <div className="border-t pt-1">
                <button
                  type="button"
                  onClick={() => setMoreOpen((v) => !v)}
                  aria-expanded={moreOpen}
                  aria-controls={moreId}
                  className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between py-3 text-[13px] transition-colors"
                >
                  {t("models.advanced.toggle")}
                  <IconChevronDown
                    className={cn(
                      "size-4 transition-transform duration-200 motion-reduce:transition-none",
                      moreOpen && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </button>
                {moreOpen && (
                  <div id={moreId} className="space-y-5 pt-2 pb-1">
                    <FormRow
                      label={t("models.field.proxy")}
                      htmlFor={fieldIds.proxy}
                    >
                      <Input
                        id={fieldIds.proxy}
                        name="proxy"
                        value={form.proxy}
                        onChange={setField("proxy")}
                        placeholder={placeholderText("http://127.0.0.1:7890")}
                        inputMode="url"
                        autoComplete="off"
                        className={inputClass}
                      />
                    </FormRow>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <FormRow
                        label={t("models.field.authMethod")}
                        htmlFor={fieldIds.authMethod}
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
                          className={inputClass}
                          disabled={authMethodLocked}
                        />
                      </FormRow>
                      <FormRow
                        label={t("models.field.connectMode")}
                        htmlFor={fieldIds.connectMode}
                      >
                        <Input
                          id={fieldIds.connectMode}
                          name="connect_mode"
                          value={form.connectMode}
                          onChange={setField("connectMode")}
                          placeholder={placeholderText("stdio")}
                          autoComplete="off"
                          className={inputClass}
                        />
                      </FormRow>
                      <FormRow
                        label={t("models.field.requestTimeout")}
                        htmlFor={fieldIds.requestTimeout}
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
                          className={inputClass}
                          min={0}
                        />
                      </FormRow>
                      <FormRow
                        label={t("models.field.rpm")}
                        htmlFor={fieldIds.rpm}
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
                          className={inputClass}
                          min={0}
                        />
                      </FormRow>
                      <FormRow
                        label={t("models.field.thinkingLevel")}
                        htmlFor={fieldIds.thinkingLevel}
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
                          className={inputClass}
                        />
                      </FormRow>
                      <FormRow
                        label={t("models.field.maxTokensField")}
                        htmlFor={fieldIds.maxTokensField}
                      >
                        <Input
                          id={fieldIds.maxTokensField}
                          name="max_tokens_field"
                          value={form.maxTokensField}
                          onChange={setField("maxTokensField")}
                          placeholder={placeholderText("max_completion_tokens")}
                          autoComplete="off"
                          className={inputClass}
                        />
                      </FormRow>
                    </div>

                    <FormRow
                      label={t("models.field.toolSchemaTransform")}
                      htmlFor={fieldIds.toolSchemaTransform}
                    >
                      <Input
                        id={fieldIds.toolSchemaTransform}
                        name="tool_schema_transform"
                        value={form.toolSchemaTransform}
                        onChange={setField("toolSchemaTransform")}
                        placeholder={placeholderText("google")}
                        autoComplete="off"
                        className={inputClass}
                      />
                    </FormRow>

                    <FormRow
                      label={t("models.field.workspace")}
                      htmlFor={fieldIds.workspace}
                    >
                      <Input
                        id={fieldIds.workspace}
                        name="workspace"
                        value={form.workspace}
                        onChange={setField("workspace")}
                        placeholder={placeholderText("/path/to/workspace")}
                        autoComplete="off"
                        className={inputClass}
                      />
                    </FormRow>

                    <FormRow
                      label={t("models.field.extraBody")}
                      htmlFor={fieldIds.extraBody}
                    >
                      <Textarea
                        id={fieldIds.extraBody}
                        name="extra_body"
                        value={form.extraBody}
                        onChange={setField("extraBody")}
                        placeholder={placeholderText('{"key": "value"}')}
                        autoComplete="off"
                        className="rounded-md font-mono text-sm shadow-none"
                        rows={3}
                      />
                    </FormRow>

                    <FormRow
                      label={t("models.field.customHeaders")}
                      htmlFor={fieldIds.customHeaders}
                    >
                      <Textarea
                        id={fieldIds.customHeaders}
                        name="custom_headers"
                        value={form.customHeaders}
                        onChange={setField("customHeaders")}
                        placeholder={placeholderText('{"X-Source": "value"}')}
                        autoComplete="off"
                        className="rounded-md font-mono text-sm shadow-none"
                        rows={3}
                      />
                    </FormRow>

                    <SwitchRow
                      label={t("models.field.streamingEnabled")}
                      checked={form.streamingEnabled}
                      onCheckedChange={(checked) =>
                        setForm((f) => ({ ...f, streamingEnabled: checked }))
                      }
                    />
                  </div>
                )}
              </div>

              {serverError && (
                <p
                  role="alert"
                  className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm"
                >
                  {serverError}
                </p>
              )}
            </div>
          </div>

          <SheetFooter className="flex-row items-center justify-between gap-2 border-t px-7 py-4 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground -ml-2 rounded-md"
              onClick={() => setTestOpen(true)}
              disabled={!form.provider || !form.model}
            >
              <IconPlugConnected className="size-4" aria-hidden="true" />
              {t("models.test.testConnection")}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                className="rounded-md"
                onClick={onClose}
                disabled={saving}
              >
                {t("common.cancel")}
              </Button>
              <Button
                className="rounded-md px-5"
                onClick={handleSave}
                disabled={
                  !isDirty || saving || modelValidation?.level === "error"
                }
              >
                {saving && <IconLoader2 className="size-4 animate-spin" />}
                {t("models.add.confirm")}
              </Button>
            </div>
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
        <ModelFilePickerDialog
          open={filePickerKind !== null}
          onOpenChange={(open) => !open && setFilePickerKind(null)}
          kind={filePickerKind ?? "llm"}
          onSelect={(path) => {
            if (filePickerKind === "llm") {
              setForm((current) => ({ ...current, localModelPath: path }))
            } else if (filePickerKind === "executable") {
              setForm((current) => ({ ...current, localExecutablePath: path }))
            }
            setFilePickerKind(null)
          }}
        />
      </Sheet>
    </>
  )
}
