import { useAtomValue } from "jotai"
import { useCallback, useEffect, useState } from "react"

import { restartGateway, startGateway, stopGateway } from "@/api/gateway"
import {
  beginGatewayStoppingTransition,
  cancelGatewayStoppingTransition,
  gatewayAtom,
  refreshGatewayState,
  subscribeGatewayPolling,
  updateGatewayStore,
} from "@/store"

export function useGateway() {
  const gateway = useAtomValue(gatewayAtom)
  const {
    status: state,
    canStart,
    startReason,
    restartRequired,
    runtimeApplyStatus,
    runtimeApplyError,
    pendingRestartFields,
  } = gateway
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return subscribeGatewayPolling()
  }, [])

  const start = useCallback(async () => {
    if (!canStart) return

    setError(null)
    setLoading(true)
    try {
      await startGateway()
      updateGatewayStore({
        status: "starting",
        restartRequired: false,
      })
    } catch (err) {
      console.error("Failed to start gateway:", err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      await refreshGatewayState({ force: true })
      setLoading(false)
    }
  }, [canStart])

  const stop = useCallback(async () => {
    setError(null)
    setLoading(true)
    beginGatewayStoppingTransition()
    try {
      const result = await stopGateway()
      if (result.supported === false) {
        cancelGatewayStoppingTransition()
        setError(result.error || "Gateway stop is not supported in this runtime.")
      }
    } catch (err) {
      console.error("Failed to stop gateway:", err)
      setError(err instanceof Error ? err.message : String(err))
      cancelGatewayStoppingTransition()
    } finally {
      await refreshGatewayState({ force: true })
      setLoading(false)
    }
  }, [])

  const restart = useCallback(async () => {
    if (state !== "running") return

    setError(null)
    setLoading(true)
    try {
      const response = await restartGateway()
      if (
        response.runtime_apply_status === "failed" ||
        response.status === "failed"
      ) {
        const message =
          response.runtime_apply_error ||
          response.message ||
          "Failed to apply gateway restart changes"
        setError(message)
        updateGatewayStore({
          status: "running",
          restartRequired: response.gateway_restart_required ?? true,
          runtimeApplyStatus: "failed",
          runtimeApplyError: message,
          pendingRestartFields: response.pending_restart_fields ?? [],
        })
      } else if (
        response.runtime_apply_status === "pending_restart" ||
        response.status === "pending_restart"
      ) {
        const pendingFields = response.pending_restart_fields ?? []
        const message =
          response.message ||
          `A full Hiro process restart is required for: ${pendingFields.join(", ")}`
        setError(message)
        updateGatewayStore({
          status: "running",
          restartRequired: response.gateway_restart_required ?? true,
          runtimeApplyStatus: "pending_restart",
          runtimeApplyError: undefined,
          pendingRestartFields: pendingFields,
        })
      } else {
        updateGatewayStore({
          status: "restarting",
          restartRequired: false,
          runtimeApplyStatus: response.runtime_apply_status ?? "applied",
          runtimeApplyError: undefined,
          pendingRestartFields: response.pending_restart_fields ?? [],
        })
      }
    } catch (err) {
      console.error("Failed to restart gateway:", err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      await refreshGatewayState({ force: true })
      setLoading(false)
    }
  }, [state])

  return {
    state,
    loading,
    canStart,
    startReason,
    restartRequired,
    runtimeApplyStatus,
    runtimeApplyError,
    pendingRestartFields,
    start,
    stop,
    restart,
    error,
  }
}
