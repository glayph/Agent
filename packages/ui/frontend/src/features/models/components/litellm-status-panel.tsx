import {
  IconLoader2,
  IconRefresh,
  IconServer,
  IconSettings,
} from "@tabler/icons-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  type LiteLLMStatus,
  getLiteLLMStatus,
  restartLiteLLM,
  syncLiteLLMConfig,
} from "@/api/litellm"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card"

function statusVariant(status?: LiteLLMStatus) {
  if (!status?.configured) return "outline" as const
  return status.healthy ? ("default" as const) : ("destructive" as const)
}

function statusLabel(
  status: LiteLLMStatus | undefined,
  t: ReturnType<typeof useTranslation>["t"],
) {
  if (!status) return t("models.litellm.status.loading")
  if (!status.configured) return t("models.litellm.status.unconfigured")
  return status.healthy
    ? t("models.litellm.status.healthy")
    : t("models.litellm.status.needsAttention")
}

function statusError(
  status: LiteLLMStatus,
  t: ReturnType<typeof useTranslation>["t"],
) {
  if (!status.error) return ""
  if (/LiteLLM returned 400/i.test(status.error)) {
    return t("models.litellm.modelsEndpoint400")
  }
  return status.error
}

export function LiteLLMStatusPanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<LiteLLMStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<"sync" | "restart" | null>(null)
  const [statusMessage, setStatusMessage] = useState<{
    kind: "success" | "error"
    text: string
  } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await getLiteLLMStatus())
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("models.litellm.loadError")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSync = async () => {
    setAction("sync")
    try {
      await syncLiteLLMConfig()
      await refresh()
      const message = t("models.litellm.syncSuccess")
      setStatusMessage({ kind: "success", text: message })
      toast.success(message)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("models.litellm.syncFailed")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    } finally {
      setAction(null)
    }
  }

  const handleRestart = async () => {
    setAction("restart")
    try {
      await restartLiteLLM()
      await refresh()
      const message = t("models.litellm.restartSuccess")
      setStatusMessage({ kind: "success", text: message })
      toast.success(message)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("models.litellm.restartFailed")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    } finally {
      setAction(null)
    }
  }

  const error = status ? statusError(status, t) : ""

  return (
    <Card size="sm" className="bg-card/95 mt-4 rounded-lg">
      <CardHeader className="grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
          <IconServer className="size-4 shrink-0" aria-hidden="true" />
          {t("models.litellm.title")}
          <Badge
            variant={statusVariant(status ?? undefined)}
            aria-live="polite"
          >
            {loading
              ? t("models.loading")
              : statusLabel(status ?? undefined, t)}
          </Badge>
        </CardTitle>
        <CardDescription className="min-w-0 break-all">
          {status?.base_url ?? t("models.litellm.loading")}
        </CardDescription>
        <CardAction className="col-start-1 row-start-auto justify-self-start sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-self-end">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              disabled={loading || action !== null}
              aria-label={t("models.litellm.refresh")}
            >
              {loading ? (
                <IconLoader2
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <IconRefresh className="size-4" aria-hidden="true" />
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleSync()}
              disabled={action !== null}
            >
              {action === "sync" ? (
                <IconLoader2
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <IconSettings className="size-4" aria-hidden="true" />
              )}
              {t("models.litellm.sync")}
            </Button>
            <Button
              size="sm"
              onClick={() => void handleRestart()}
              disabled={action !== null || !status?.configured}
            >
              {action === "restart" ? (
                <IconLoader2
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <IconRefresh className="size-4" aria-hidden="true" />
              )}
              {t("models.litellm.restart")}
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        {statusMessage && (
          <div
            className={
              statusMessage.kind === "error"
                ? "border-border bg-destructive/10 text-destructive mb-3 rounded-lg border px-3 py-2 text-sm"
                : "border-border bg-muted/60 text-foreground mb-3 rounded-lg border px-3 py-2 text-sm"
            }
            role={statusMessage.kind === "error" ? "alert" : "status"}
            aria-live={statusMessage.kind === "error" ? "assertive" : "polite"}
          >
            {statusMessage.text}
          </div>
        )}
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
          <div>
            <div className="text-muted-foreground">
              {t("models.litellm.configuredModels")}
            </div>
            <div className="font-medium">{status?.model_count ?? 0}</div>
          </div>
          <div>
            <div className="text-muted-foreground">
              {t("models.litellm.liveModels")}
            </div>
            <div className="font-medium">
              {status?.models_endpoint_count ?? "-"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">
              {t("models.litellm.configFile")}
            </div>
            <div className="font-mono text-xs break-all">
              {status?.config_path ?? "-"}
            </div>
          </div>
        </div>
        {error && (
          <p className="text-destructive mt-3 text-xs" role="status">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
