import { IconLoader2 } from "@tabler/icons-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  type QrBindingChannel,
  type QrBindingFlowResponse,
  pollQrBindingFlow,
  startQrBindingFlow,
} from "@/api/channels"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Card, CardContent } from "@/shared/ui/card"

type NormalizedQrBindingStatus =
  | "idle"
  | "wait"
  | "scanned"
  | "confirmed"
  | "expired"
  | "error"

interface QrBindingPanelProps {
  channel: QrBindingChannel
  isBound: boolean
  onBindingComplete?: () => void
}

function normalizeStatus(status?: string): NormalizedQrBindingStatus {
  if (!status) return "idle"
  if (status === "scaned" || status === "scanned") return "scanned"
  if (
    status === "wait" ||
    status === "confirmed" ||
    status === "expired" ||
    status === "error"
  ) {
    return status
  }
  return "error"
}

function isPollingStatus(status: NormalizedQrBindingStatus): boolean {
  return status === "wait" || status === "scanned"
}

function statusBadgeVariant(status: NormalizedQrBindingStatus) {
  if (status === "confirmed") return "default" as const
  if (status === "error" || status === "expired") return "destructive" as const
  return "outline" as const
}

export function QrBindingPanel({
  channel,
  isBound,
  onBindingComplete,
}: QrBindingPanelProps) {
  const { t } = useTranslation()
  const [flow, setFlow] = useState<QrBindingFlowResponse | null>(null)
  const [starting, setStarting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState("")
  const notifiedCompleteRef = useRef(false)
  const pollingRef = useRef(false)

  const translationPrefix = `channels.${channel}` as const
  const status = normalizeStatus(flow?.status)
  const isActive = isPollingStatus(status)

  const statusText = useMemo(() => {
    if (error) return error
    if (!flow) {
      return isBound
        ? t(`${translationPrefix}.bound`)
        : t(`${translationPrefix}.notBound`)
    }
    if (status === "wait") return t(`${translationPrefix}.scanHint`)
    if (status === "scanned") return t(`${translationPrefix}.scanned`)
    if (status === "confirmed") return t(`${translationPrefix}.bound`)
    if (status === "expired") return t(`${translationPrefix}.expired`)
    return flow.error || t(`${translationPrefix}.errorGeneric`)
  }, [error, flow, isBound, status, t, translationPrefix])

  const refreshFlow = useCallback(
    async (flowId: string) => {
      if (pollingRef.current) return
      pollingRef.current = true
      setPolling(true)
      try {
        const nextFlow = await pollQrBindingFlow(channel, flowId)
        setFlow(nextFlow)
        setError(nextFlow.status === "error" ? nextFlow.error || "" : "")
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t(`${translationPrefix}.errorGeneric`),
        )
      } finally {
        pollingRef.current = false
        setPolling(false)
      }
    },
    [channel, t, translationPrefix],
  )

  const startFlow = useCallback(async () => {
    setStarting(true)
    setError("")
    notifiedCompleteRef.current = false
    try {
      const nextFlow = await startQrBindingFlow(channel)
      setFlow(nextFlow)
      setError(nextFlow.status === "error" ? nextFlow.error || "" : "")
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t(`${translationPrefix}.errorGeneric`),
      )
    } finally {
      setStarting(false)
    }
  }, [channel, t, translationPrefix])

  useEffect(() => {
    if (!flow?.flow_id || !isActive) return
    const interval = window.setInterval(() => {
      void refreshFlow(flow.flow_id)
    }, 2500)
    return () => window.clearInterval(interval)
  }, [flow?.flow_id, isActive, refreshFlow])

  useEffect(() => {
    if (status !== "confirmed" || notifiedCompleteRef.current) return
    notifiedCompleteRef.current = true
    onBindingComplete?.()
  }, [onBindingComplete, status])

  const primaryLabel = flow
    ? t(`${translationPrefix}.refresh`)
    : isBound
      ? t(`${translationPrefix}.rebind`)
      : t(`${translationPrefix}.bind`)

  const handlePrimaryAction = () => {
    if (flow?.flow_id && isActive) {
      void refreshFlow(flow.flow_id)
      return
    }
    void startFlow()
  }

  return (
    <Card className="shadow-sm">
      <CardContent className="space-y-4 px-6 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">
                {t(`${translationPrefix}.bindTitle`)}
              </h3>
              {(flow || isBound) && (
                <Badge variant={statusBadgeVariant(status)}>
                  {flow ? status : t(`${translationPrefix}.bound`)}
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              {t(`${translationPrefix}.bindDesc`)}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={starting || polling}
            onClick={handlePrimaryAction}
          >
            {starting || polling ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : null}
            {starting ? t(`${translationPrefix}.generating`) : primaryLabel}
          </Button>
        </div>

        {flow?.qr_data_uri && isActive && (
          <div className="border-border bg-background flex w-fit rounded-lg border p-3">
            <img
              src={flow.qr_data_uri}
              alt={t(`${translationPrefix}.scanHint`)}
              className="size-44"
            />
          </div>
        )}

        <p
          className={
            error || status === "error"
              ? "text-destructive text-sm"
              : "text-muted-foreground text-sm"
          }
          role={error || status === "error" ? "alert" : "status"}
          aria-live={error || status === "error" ? "assertive" : "polite"}
        >
          {statusText}
        </p>
      </CardContent>
    </Card>
  )
}
