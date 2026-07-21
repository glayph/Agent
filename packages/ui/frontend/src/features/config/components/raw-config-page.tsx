import { IconAdjustments } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { launcherFetch } from "@/api/http"
import { ConfigChangeNotice } from "@/app/layout/config-change-notice"
import { PageHeader } from "@/app/layout/page-header"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/shared/ui/alert-dialog"
import { Button } from "@/shared/ui/button"
import { Textarea } from "@/shared/ui/textarea"
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard"
import { showSaveSuccessOrRestartToast } from "@/lib/restart-required"
import { refreshGatewayState } from "@/store/gateway"

async function readConfigSaveError(
  res: Response,
  fallbackMessage: string,
): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: unknown
      errors?: unknown
    }
    if (Array.isArray(body.errors)) {
      const errors = body.errors.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
      if (errors.length > 0) return errors.join("\n")
    }
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error
    }
  } catch {
    // Fall through to the generic message.
  }
  return fallbackMessage
}

export function RawConfigPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [statusMessage, setStatusMessage] = useState<{
    kind: "success" | "error" | "info"
    text: string
  } | null>(null)

  const { data: config, isLoading } = useQuery({
    queryKey: ["config"],
    queryFn: async () => {
      const res = await launcherFetch("/api/config")
      if (!res.ok) {
        const message = t("pages.config.load_error")
        setStatusMessage({ kind: "error", text: message })
        throw new Error(message)
      }
      return res.json()
    },
  })

  const mutation = useMutation({
    mutationFn: async (newConfig: string) => {
      const res = await launcherFetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: newConfig,
      })
      if (!res.ok) {
        throw new Error(
          await readConfigSaveError(res, t("pages.config.save_error")),
        )
      }
    },
    onSuccess: (_, submittedConfig) => {
      try {
        const savedConfig = JSON.parse(submittedConfig)
        setLastSavedConfig(savedConfig)
        setIsDirty(false)
        queryClient.invalidateQueries({ queryKey: ["config"] })
      } catch {
        queryClient.invalidateQueries({ queryKey: ["config"] })
      }
      void refreshGatewayState({ force: true }).then((gateway) => {
        const restartRequired = gateway?.restartRequired === true
        setStatusMessage({
          kind: "success",
          text: restartRequired
            ? t("common.restartRequiredDesc", { name: t("navigation.config") })
            : t("pages.config.save_success"),
        })
        showSaveSuccessOrRestartToast(
          t,
          t("pages.config.save_success"),
          t("navigation.config"),
          restartRequired,
        )
      })
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : t("pages.config.save_error")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    },
  })

  const [editorValue, setEditorValue] = useState<string | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [lastSavedConfig, setLastSavedConfig] = useState<Record<
    string,
    unknown
  > | null>(null)
  useUnsavedChangesGuard(isDirty)

  const effectiveEditorValue =
    editorValue ?? (config ? JSON.stringify(config, null, 2) : "")

  const handleSave = () => {
    try {
      JSON.parse(effectiveEditorValue)
      mutation.mutate(effectiveEditorValue)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("pages.config.invalid_json")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    }
  }

  const handleFormat = () => {
    try {
      const formatted = JSON.stringify(
        JSON.parse(effectiveEditorValue),
        null,
        2,
      )
      setEditorValue(formatted)
      const message = t("pages.config.format_success")
      setStatusMessage({ kind: "success", text: message })
      toast.success(message)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("pages.config.format_error")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    }
  }

  const [showResetDialog, setShowResetDialog] = useState(false)

  const confirmReset = () => {
    if (lastSavedConfig) {
      setEditorValue(JSON.stringify(lastSavedConfig, null, 2))
    } else if (config) {
      setEditorValue(JSON.stringify(config, null, 2))
    }
    setIsDirty(false)
    const message = t("pages.config.reset_success")
    setStatusMessage({ kind: "info", text: message })
    toast.info(message)
    setShowResetDialog(false)
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("pages.config.raw_json_title")}>
        <Button
          variant="outline"
          size="sm"
          asChild
          className="max-sm:size-8 max-sm:gap-0 max-sm:rounded-full max-sm:px-0"
          aria-label={t("pages.config.back_to_visual")}
          title={t("pages.config.back_to_visual")}
        >
          <Link to="/config">
            <IconAdjustments className="size-4" />
            <span className="max-sm:hidden">
              {t("pages.config.back_to_visual")}
            </span>
          </Link>
        </Button>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col p-1 lg:p-3 lg:p-6">
        <div className="mx-auto flex h-full min-h-0 w-full max-w-[1000px] flex-col">
          {isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <p>{t("labels.loading")}</p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              {isDirty && (
                <ConfigChangeNotice
                  kind="save"
                  title={t("common.saveChangesTitle")}
                  description={t("pages.config.unsaved_changes")}
                  className="shrink-0"
                />
              )}
              {statusMessage && (
                <div
                  className={
                    statusMessage.kind === "error"
                      ? "border-border bg-destructive/10 text-destructive shrink-0 rounded-lg border px-3 py-2 text-sm"
                      : "border-border bg-muted/60 text-foreground shrink-0 rounded-lg border px-3 py-2 text-sm"
                  }
                  role={statusMessage.kind === "error" ? "alert" : "status"}
                  aria-live={
                    statusMessage.kind === "error" ? "assertive" : "polite"
                  }
                >
                  {statusMessage.text}
                </div>
              )}
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border shadow-sm">
                <label htmlFor="raw-config-json" className="sr-only">
                  {t("pages.config.raw_json_title")}
                </label>
                <Textarea
                  id="raw-config-json"
                  name="raw_config_json"
                  value={effectiveEditorValue}
                  onChange={(e) => {
                    setEditorValue(e.target.value)
                    setIsDirty(true)
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  wrap="off"
                  className="h-full min-h-0 resize-none overflow-auto border-0 bg-transparent px-4 py-3 font-mono text-sm [overflow-wrap:normal] whitespace-pre shadow-none focus-visible:ring-0"
                  placeholder={t("pages.config.json_placeholder")}
                />
              </div>
              <div className="flex shrink-0 justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={handleFormat}
                  disabled={mutation.isPending}
                >
                  {t("pages.config.format")}
                </Button>
                <AlertDialog
                  open={showResetDialog}
                  onOpenChange={setShowResetDialog}
                >
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      disabled={!isDirty}
                      onClick={() => setShowResetDialog(true)}
                    >
                      {t("common.reset")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("pages.config.reset_confirm_title")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("pages.config.reset_confirm_desc")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        {t("common.cancel")}
                      </AlertDialogCancel>
                      <AlertDialogAction onClick={confirmReset}>
                        {t("common.confirm")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button onClick={handleSave} disabled={mutation.isPending}>
                  {mutation.isPending ? t("common.saving") : t("common.save")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
