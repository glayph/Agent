import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useState,
} from "react"
import { useTranslation } from "react-i18next"

import {
  type LocalLlamaModelConfig,
  addModel,
  setDefaultModel,
} from "@/api/models"
import { notify } from "@/lib/notify"
import { showSaveSuccessOrRestartToast } from "@/lib/restart-required"
import { refreshGatewayState } from "@/store/gateway"

import {
  type AddForm,
  buildAddModelPayload,
  generateUniqueModelName,
  getModelIdsToSave,
} from "./add-model-form-state"
import { retainUnsuccessfulModelIds } from "./model-selection"

interface UseAddModelSubmitOptions {
  form: AddForm
  setAsDefault: boolean
  selectedModels: string[]
  existingModelNames: string[]
  provider: string
  submittedApiBase: string | null
  authMethodLocked: boolean
  defaultAuthMethod: string
  validate: () => boolean
  onSaved: () => void
  onClose: () => void
  setSelectedModels: Dispatch<SetStateAction<string[]>>
  setModelFailures: (failures: Record<string, string>) => void
  setSetAsDefault: (value: boolean) => void
}

function parseJsonField<T>(raw: string): T | undefined {
  return raw.trim() ? (JSON.parse(raw.trim()) as T) : ({} as T)
}

function buildLocalConfig(form: AddForm): LocalLlamaModelConfig {
  return {
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
}

/**
 * Saves one or many models sequentially. Successful ids are removed from the
 * selection, failed ones stay with a reason, the gateway refreshes once and a
 * single summary toast is shown.
 */
export function useAddModelSubmit(options: UseAddModelSubmitOptions) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState("")

  const reset = useCallback(() => {
    setServerError("")
  }, [])

  const save = async () => {
    const { form, provider, existingModelNames } = options
    if (!options.validate()) return

    let extraBody: Record<string, unknown> | undefined
    let customHeaders: Record<string, string> | undefined
    try {
      extraBody = parseJsonField(form.extraBody)
    } catch {
      setServerError(
        `${t("models.field.extraBody")}: ${t("models.field.invalidJson")}`,
      )
      return
    }
    try {
      customHeaders = parseJsonField(form.customHeaders)
    } catch {
      setServerError(
        `${t("models.field.customHeaders")}: ${t("models.field.invalidJson")}`,
      )
      return
    }

    const modelIds = getModelIdsToSave(options.selectedModels, form.model)
    const successfulModelIds: string[] = []
    const successfulModelNames: string[] = []
    const failures: Record<string, string> = {}
    let defaultModelError: string | undefined
    setSaving(true)
    setServerError("")
    try {
      const local =
        provider === "llama.cpp" ? buildLocalConfig(form) : undefined
      const requestedName = form.modelName.trim()

      for (const [index, modelId] of modelIds.entries()) {
        const modelName =
          requestedName && (modelIds.length === 1 || index === 0)
            ? requestedName
            : generateUniqueModelName([
                ...existingModelNames,
                ...successfulModelNames,
                ...(requestedName ? [requestedName] : []),
              ])
        try {
          await addModel(
            buildAddModelPayload(form, {
              modelName,
              modelId,
              provider,
              submittedApiBase: options.submittedApiBase,
              authMethodLocked: options.authMethodLocked,
              defaultAuthMethod: options.defaultAuthMethod,
              extraBody,
              customHeaders,
              local,
            }),
          )
          successfulModelIds.push(modelId)
          successfulModelNames.push(modelName)
        } catch (error) {
          failures[modelId] =
            error instanceof Error ? error.message : t("models.add.saveError")
        }
      }

      if (options.setAsDefault && successfulModelNames.length > 0) {
        // Only the first successful model in the batch may become default.
        options.setSetAsDefault(false)
        try {
          await setDefaultModel(successfulModelNames[0])
        } catch (error) {
          defaultModelError =
            error instanceof Error ? error.message : t("models.add.saveError")
          setServerError(defaultModelError)
        }
      }

      if (successfulModelIds.length > 0) {
        let restartRequired = false
        try {
          const gateway = await refreshGatewayState({ force: true })
          restartRequired = gateway?.restartRequired === true
        } catch {
          notify.error(t("models.loadError"), {
            id: "models:refresh-after-add",
          })
        }
        showSaveSuccessOrRestartToast(
          t,
          successfulModelIds.length === 1
            ? t("models.add.saveSuccess")
            : t("models.add.batchSaveSuccess", {
                count: successfulModelIds.length,
              }),
          successfulModelNames[0],
          restartRequired,
        )
        options.onSaved()
        if (defaultModelError) {
          notify.error(defaultModelError, {
            id: "models:set-default-after-add",
          })
        }
      }

      options.setModelFailures(failures)
      const remaining = retainUnsuccessfulModelIds(modelIds, successfulModelIds)
      options.setSelectedModels((current) =>
        current.filter((modelId) => remaining.includes(modelId)),
      )
      if (remaining.length === 0) {
        options.onClose()
      } else if (successfulModelIds.length === 0 && modelIds.length === 1) {
        setServerError(failures[modelIds[0]] || t("models.add.saveError"))
      }
    } catch (error) {
      setServerError(
        error instanceof Error ? error.message : t("models.add.saveError"),
      )
    } finally {
      setSaving(false)
    }
  }

  return {
    saving,
    serverError,
    setServerError,
    reset,
    save,
  }
}
