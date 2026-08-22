import {
  IconAlertTriangle,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react"
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import { PageHeader } from "@/app/layout/page-header"
import { AntigravityCredentialCard } from "@/features/credentials/components/antigravity-credential-card"
import { CredentialCard } from "@/features/credentials/components/credential-card"
import { DeviceCodeSheet } from "@/features/credentials/components/device-code-sheet"
import { LogoutConfirmDialog } from "@/features/credentials/components/logout-confirm-dialog"
import { OpenAICredentialCard } from "@/features/credentials/components/openai-credential-card"
import { useCredentialsPage } from "@/hooks/use-credentials-page"
import { Button } from "@/shared/ui/button"

export const Route = createFileRoute("/credentials")({
  component: CredentialsPage,
})

function CredentialsPage() {
  const { t } = useTranslation()
  const credentials = useCredentialsPage()
  const {
    loading,
    error,
    loadProviders,
    activeAction,
    activeFlow,
    flowHint,
    openAIToken,
    antigravityToken,
    openaiStatus,
    antigravityStatus,
    logoutDialogOpen,
    logoutProviderLabel,
    deviceSheetOpen,
    deviceFlow,
    revealedTokens,
    setOpenAIToken,
    setAntigravityToken,
    startBrowserOAuth,
    startOpenAIDeviceCode,
    stopLoading,
    saveToken,
    askLogout,
    handleConfirmLogout,
    handleLogoutDialogOpenChange,
    handleDeviceSheetOpenChange,
    revealToken,
    hideToken,
  } = credentials

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("navigation.credentials")} titleLevel={1}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void loadProviders()}
          disabled={loading || activeAction !== ""}
          aria-label={t("models.retry", { defaultValue: "Retry" })}
          title={t("models.retry", { defaultValue: "Retry" })}
        >
          {loading ? (
            <IconLoader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <IconRefresh className="size-4" aria-hidden="true" />
          )}
          <span className="max-sm:hidden">
            {t("models.retry", { defaultValue: "Retry" })}
          </span>
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-6xl space-y-4 py-4">
          <p className="text-muted-foreground text-sm">
            {t("credentials.description")}
          </p>

          {error && (
            <div
              className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-lg px-4 py-3 text-sm"
              role="alert"
            >
              <IconAlertTriangle
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span>{error}</span>
            </div>
          )}

          {activeFlow && (
            <div
              className="bg-muted flex items-start gap-2 rounded-lg border px-4 py-3 text-sm"
              role="status"
            >
              <IconLoader2
                className={
                  activeFlow.status === "pending"
                    ? "mt-0.5 size-4 shrink-0 animate-spin"
                    : "mt-0.5 size-4 shrink-0"
                }
                aria-hidden="true"
              />
              <span>{flowHint}</span>
            </div>
          )}

          {loading && !openaiStatus && !antigravityStatus ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-20 text-sm">
              <IconLoader2 className="size-5 animate-spin" aria-hidden="true" />
              <span>{t("credentials.loading")}</span>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <OpenAICredentialCard
                status={openaiStatus}
                activeAction={activeAction}
                token={openAIToken}
                onTokenChange={setOpenAIToken}
                onStartBrowserOAuth={() => void startBrowserOAuth("openai")}
                onStartDeviceCode={() => void startOpenAIDeviceCode()}
                onStopLoading={stopLoading}
                onSaveToken={() => void saveToken("openai", openAIToken)}
                onAskLogout={() => askLogout("openai")}
                revealedToken={revealedTokens.openai}
                onRevealToken={() => void revealToken("openai")}
                onHideToken={() => hideToken("openai")}
              />
              <AntigravityCredentialCard
                status={antigravityStatus}
                activeAction={activeAction}
                token={antigravityToken}
                onTokenChange={setAntigravityToken}
                onStopLoading={stopLoading}
                onSaveToken={() =>
                  void saveToken("google-antigravity", antigravityToken)
                }
                onAskLogout={() => askLogout("google-antigravity")}
                revealedToken={revealedTokens["google-antigravity"]}
                onRevealToken={() => void revealToken("google-antigravity")}
                onHideToken={() => hideToken("google-antigravity")}
              />
              {!openaiStatus && !antigravityStatus && (
                <CredentialCard
                  title="Credentials"
                  description={t("credentials.description")}
                  status="not_logged_in"
                  actions={
                    <div className="text-muted-foreground flex h-[120px] items-center justify-center rounded-lg border p-3 text-sm">
                      {t("credentials.loading")}
                    </div>
                  }
                />
              )}
            </div>
          )}
        </div>
      </div>

      <DeviceCodeSheet
        open={deviceSheetOpen}
        flow={deviceFlow}
        flowHint={flowHint}
        onOpenChange={handleDeviceSheetOpenChange}
      />
      <LogoutConfirmDialog
        open={logoutDialogOpen}
        providerLabel={logoutProviderLabel}
        isSubmitting={activeAction.endsWith(":logout")}
        onOpenChange={handleLogoutDialogOpenChange}
        onConfirm={() => void handleConfirmLogout()}
      />
    </div>
  )
}
