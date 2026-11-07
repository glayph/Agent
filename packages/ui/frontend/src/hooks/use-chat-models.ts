import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { notify } from "@/lib/notify"
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

function createDefaultModelClientId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useChatModels({ isConnected }: UseChatModelsOptions) {
  const { t } = useTranslation()
  const [modelList, setModelList] = useState<ModelInfo[]>([])
  const [defaultModelName, setDefaultModelName] = useState("")
  const [defaultModelIndex, setDefaultModelIndex] = useState("")
  const [defaultModelId, setDefaultModelId] = useState("")
  const [resolution, setResolution] = useState<ModelResolution | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const setDefaultRequestIdRef = useRef(0)
  // Identifies this chat window so the backend can discard its own older, slower selections.
  const [defaultModelClientId] = useState(createDefaultModelClientId)

  const syncDefaultModelName = useCallback(
    (models: ModelInfo[], defaultModel: string, resolved?: ModelResolution | null, defaultModelIndex?: number | null) => {
      const selected = typeof defaultModelIndex === "number"
        ? models.find((model) => model.index === defaultModelIndex)
        : models.find(
            (model) => model.is_virtual !== true && (
              model.model_name === defaultModel ||
              model.runtime_model === defaultModel ||
              model.model === defaultModel
            ),
          )
      if (selected) {
        setDefaultModelName(selected.model_name)
        setDefaultModelIndex(String(selected.index))
        setDefaultModelId(
          selected.runtime_model || selected.model || selected.model_name,
        )
        return
      }
      // Environment-only setups have no stored row; trust the backend's live resolution.
      if (resolved?.configured && resolved.model) {
        setDefaultModelName(resolved.model_name || resolved.model)
        setDefaultModelIndex("")
        setDefaultModelId(resolved.model)
        return
      }
      setDefaultModelName("")
      setDefaultModelIndex("")
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
        syncDefaultModelName(data.models, data.default_model, data.resolved, data.default_model_index)
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
    async (modelIndex: number) => {
      const selected = modelList.find((model) => model.index === modelIndex)
      if (!selected || String(modelIndex) === defaultModelIndex) return
      const requestId = ++setDefaultRequestIdRef.current

      try {
        const changeResult = await setDefaultModel(modelIndex, { clientId: defaultModelClientId, sequence: requestId })
        if (requestId !== setDefaultRequestIdRef.current) return
        const data = await getModels()
        if (requestId !== setDefaultRequestIdRef.current) return

        setModelList(data.models)
        setResolution(data.resolved ?? null)
        syncDefaultModelName(data.models, data.default_model, data.resolved, data.default_model_index)
        const gateway = await refreshGatewayState({ force: true })
        if (requestId !== setDefaultRequestIdRef.current) return
        showSaveSuccessOrRestartToast(
          t,
          t("models.defaultChangeSuccess"),
          selected.model_name,
          gateway?.restartRequired === true,
        )
        if (changeResult.applies === "next_run" && (changeResult.active_runs ?? 0) > 0) {
          notify.info(
            t("models.defaultChangeNextRun"),
            {
              description: t("models.defaultChangeNextRunDescription", { count: changeResult.active_runs }),
              id: "use-chat-models:default-change-next-run",
              duration: 6500,
            },
          )
        }
      } catch (err) {
        if (requestId !== setDefaultRequestIdRef.current) return
        console.error("Failed to set default model:", err)
        notify.error(err instanceof Error ? err.message : t("models.loadError"), { id: "use-chat-models:error:handleSetDefault" })
      }
    },
    [defaultModelClientId, defaultModelIndex, modelList, syncDefaultModelName, t],
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

  // Saved models that cannot run yet (missing/invalid key, disabled) stay visible in the menu
  // instead of silently disappearing after they are saved.
  const unavailableModels = useMemo(
    () => defaultSelectableModels.filter((m) => !m.available),
    [defaultSelectableModels],
  )

  return {
    defaultModelName,
    defaultModelIndex,
    defaultModelId,
    hasAvailableModels,
    hasAnyModels: defaultSelectableModels.length > 0,
    unavailableModels,
    resolution,
    loadFailed,
    apiKeyModels,
    oauthModels,
    localModels,
    handleSetDefault,
  }
}
