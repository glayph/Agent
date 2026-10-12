import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { type ModelInfo, type ModelResolution, getModels, setDefaultModel } from "@/api/models"
import { showSaveSuccessOrRestartToast } from "@/lib/restart-required"
import { refreshGatewayState } from "@/store/gateway"

interface UseChatModelsOptions {
  isConnected: boolean
}

function isLocalModel(model: ModelInfo): boolean {
  const isLocalHostBase = Boolean(
    model.api_base?.includes("localhost") ||
    model.api_base?.includes("127.0.0.1"),
  )

  return (
    model.auth_method === "local" || (!model.auth_method && isLocalHostBase)
  )
}

export function useChatModels({ isConnected }: UseChatModelsOptions) {
  const { t } = useTranslation()
  const [modelList, setModelList] = useState<ModelInfo[]>([])
  const [defaultModelName, setDefaultModelName] = useState("")
  const [defaultModelId, setDefaultModelId] = useState("")
  const [resolution, setResolution] = useState<ModelResolution | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const setDefaultRequestIdRef = useRef(0)

  const syncDefaultModelName = useCallback(
    (models: ModelInfo[], defaultModel: string, resolved?: ModelResolution | null) => {
      const selected = models.find(
        (model) =>
          model.model_name === defaultModel ||
          model.runtime_model === defaultModel ||
          model.model === defaultModel,
      )
      if (selected) {
        setDefaultModelName(selected.model_name)
        setDefaultModelId(
          selected.runtime_model || selected.model || selected.model_name,
        )
        return
      }
      // Environment-only setups have no stored row; trust the backend's live resolution.
      if (resolved?.configured && resolved.model) {
        setDefaultModelName(resolved.model_name || resolved.model)
        setDefaultModelId(resolved.model)
        return
      }
      setDefaultModelName("")
      setDefaultModelId("")
    },
    [],
  )

  // Always ask the backend (single source of truth). A failed fetch is retried with
  // backoff instead of being swallowed, so a transient error at start-up can no
  // longer leave the chat stuck on "No model is configured".
  const loadModels = useCallback(async () => {
    const delays = [0, 1500, 4000]
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
      try {
        const data = await getModels()
        setModelList(data.models)
        setResolution(data.resolved ?? null)
        syncDefaultModelName(data.models, data.default_model, data.resolved)
        setLoadFailed(false)
        return
      } catch {
        // retry
      }
    }
    setLoadFailed(true)
  }, [syncDefaultModelName])

  useEffect(() => {
    const timerId = setTimeout(() => {
      void loadModels()
    }, 0)

    return () => clearTimeout(timerId)
  }, [isConnected, loadModels])

  // Re-resolve when the tab regains focus (e.g. after fixing the key on the Models page).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadModels()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [loadModels])

  const handleSetDefault = useCallback(
    async (modelName: string) => {
      if (modelName === defaultModelName) return
      const requestId = ++setDefaultRequestIdRef.current

      try {
        await setDefaultModel(modelName)
        const data = await getModels()
        if (requestId !== setDefaultRequestIdRef.current) {
          return
        }

        setModelList(data.models)
        setResolution(data.resolved ?? null)
        syncDefaultModelName(data.models, data.default_model, data.resolved)
        const gateway = await refreshGatewayState({ force: true })
        showSaveSuccessOrRestartToast(
          t,
          t("models.defaultChangeSuccess"),
          modelName,
          gateway?.restartRequired === true,
        )
      } catch (err) {
        console.error("Failed to set default model:", err)
        toast.error(err instanceof Error ? err.message : t("models.loadError"))
      }
    },
    [defaultModelName, syncDefaultModelName, t],
  )

  const defaultSelectableModels = useMemo(
    () =>
      modelList.filter(
        (m) => m.default_model_allowed !== false && m.is_virtual !== true,
      ),
    [modelList],
  )

  const hasAvailableModels = useMemo(
    () =>
      defaultSelectableModels.some((m) => m.available) ||
      resolution?.configured === true,
    [defaultSelectableModels, resolution],
  )

  const oauthModels = useMemo(
    () =>
      defaultSelectableModels.filter(
        (m) => m.available && m.auth_method === "oauth",
      ),
    [defaultSelectableModels],
  )

  const localModels = useMemo(
    () => defaultSelectableModels.filter((m) => m.available && isLocalModel(m)),
    [defaultSelectableModels],
  )

  const apiKeyModels = useMemo(
    () =>
      defaultSelectableModels.filter(
        (m) => m.available && m.auth_method !== "oauth" && !isLocalModel(m),
      ),
    [defaultSelectableModels],
  )

  return {
    defaultModelName,
    defaultModelId,
    hasAvailableModels,
    resolution,
    loadFailed,
    apiKeyModels,
    oauthModels,
    localModels,
    handleSetDefault,
  }
}
