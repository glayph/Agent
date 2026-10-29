export interface AddForm {
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

export const EMPTY_ADD_FORM: AddForm = {
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

export function generateUniqueModelName(existingNames: string[]): string {
  const existing = new Set(
    existingNames.map((name) => name.trim().toLowerCase()),
  )
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const bytes = new Uint8Array(6)
    globalThis.crypto.getRandomValues(bytes)
    const candidate = Array.from(
      bytes,
      (byte) => alphabet[byte % alphabet.length],
    ).join("")
    if (!existing.has(candidate)) return candidate
  }
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0")
}

export interface AddFormValidationMessages {
  duplicateModelName: string
  providerInvalid: string
  modelRequired: string
}

export function validateAddFormState(
  form: AddForm,
  input: {
    providerIsValid: boolean
    existingModelNames: string[]
    selectedModels: string[]
    modelValidationError?: string
    messages: AddFormValidationMessages
  },
): Partial<Record<keyof AddForm, string>> {
  const errors: Partial<Record<keyof AddForm, string>> = {}
  const requestedName = form.modelName.trim().toLowerCase()
  if (
    requestedName &&
    input.existingModelNames.some(
      (name) => name.trim().toLowerCase() === requestedName,
    )
  ) {
    errors.modelName = input.messages.duplicateModelName
  }
  if (!input.providerIsValid) errors.provider = input.messages.providerInvalid
  if (!form.model.trim() && input.selectedModels.length === 0) {
    errors.model = input.messages.modelRequired
  }
  if (input.selectedModels.length === 0 && input.modelValidationError) {
    errors.model = input.modelValidationError
  }
  return errors
}

export function getModelIdsToSave(
  selectedModels: string[],
  modelField: string,
): string[] {
  const selected = [
    ...new Set(selectedModels.map((model) => model.trim()).filter(Boolean)),
  ]
  return selected.length > 0
    ? selected
    : modelField.trim()
      ? [modelField.trim()]
      : []
}

export interface BuildAddModelPayloadOptions {
  modelName: string
  modelId: string
  provider: string
  submittedApiBase: string | null
  authMethodLocked: boolean
  defaultAuthMethod: string
  extraBody?: Record<string, unknown>
  customHeaders?: Record<string, string>
  local?: import("@/api/models").LocalLlamaModelConfig
}

export function buildAddModelPayload(
  form: AddForm,
  options: BuildAddModelPayloadOptions,
): Partial<import("@/api/models").ModelInfo> {
  return {
    model_name: options.modelName,
    provider: options.provider || undefined,
    model: options.modelId,
    api_base: options.submittedApiBase || undefined,
    api_key: form.apiKey.trim() || undefined,
    proxy: form.proxy.trim() || undefined,
    auth_method: options.authMethodLocked
      ? options.defaultAuthMethod || undefined
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
    extra_body: options.extraBody,
    custom_headers: options.customHeaders,
    local: options.local,
  }
}
