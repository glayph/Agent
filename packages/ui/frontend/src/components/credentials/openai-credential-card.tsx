import {
  IconBrandOpenai,
  IconClockHour4,
  IconKey,
  IconLoader2,
  IconPlayerStopFilled,
  IconEye,
  IconEyeOff,
  IconCopy,
  IconCheck,
} from "@tabler/icons-react"
import { useTranslation } from "react-i18next"
import { useState } from "react"

import type { OAuthProviderStatus } from "@/api/oauth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

import { CredentialCard } from "./credential-card"

interface OpenAICredentialCardProps {
  status?: OAuthProviderStatus
  activeAction: string
  token: string
  onTokenChange: (value: string) => void
  onStartBrowserOAuth: () => void
  onStartDeviceCode: () => void
  onStopLoading: () => void
  onSaveToken: () => void
  onAskLogout: () => void
  revealedToken?: string
  onRevealToken: () => void
  onHideToken: () => void
}

export function OpenAICredentialCard({
  status,
  activeAction,
  token,
  onTokenChange,
  onStartBrowserOAuth,
  onStartDeviceCode,
  onStopLoading,
  onSaveToken,
  onAskLogout,
  revealedToken,
  onRevealToken,
  onHideToken,
}: OpenAICredentialCardProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const actionBusy = activeAction !== ""
  const browserLoading = activeAction === "openai:browser"
  const deviceLoading = activeAction === "openai:device"
  const oauthLoading = browserLoading || deviceLoading
  const tokenLoading = activeAction === "openai:token"
  const supportsBrowser = status?.methods?.includes("browser") === true
  const supportsDeviceCode = status?.methods?.includes("device_code") === true
  const tokenLabel = t("credentials.fields.openaiToken")
  const stopLabel = t("credentials.actions.stopLoading")

  const handleCopy = () => {
    if (revealedToken) {
      navigator.clipboard.writeText(revealedToken)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <CredentialCard
      title={
        <span className="inline-flex items-center gap-2">
          <span className="border-muted inline-flex size-6 items-center justify-center rounded-full border">
            <IconBrandOpenai className="size-3.5" />
          </span>
          <span>OpenAI</span>
        </span>
      }
      description={t("credentials.providers.openai.description")}
      status={status?.status ?? "not_logged_in"}
      authMethod={status?.auth_method}
      details={
        <div className="flex flex-col gap-2">
          {status?.account_id ? (
            <p>
              {t("credentials.labels.account")}: {status.account_id}
            </p>
          ) : null}
          {status?.logged_in && (
            <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 p-2">
              <span className="font-mono text-xs text-foreground truncate select-all">
                {revealedToken ? revealedToken : (status?.account_id || "••••••••••••••••")}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={revealedToken ? onHideToken : onRevealToken}
                  title={revealedToken ? "Hide Key" : "Reveal Key"}
                  aria-label={revealedToken ? "Hide Key" : "Reveal Key"}
                >
                  {revealedToken ? <IconEyeOff className="size-3.5" /> : <IconEye className="size-3.5" />}
                </Button>
                {revealedToken && (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={handleCopy}
                    title={copied ? "Copied" : "Copy Key"}
                    aria-label="Copy Key"
                  >
                    {copied ? <IconCheck className="size-3.5 text-success" /> : <IconCopy className="size-3.5" />}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      }
      actions={
        <div className="border-muted flex h-[120px] flex-col rounded-lg border p-3">
          <div className="flex h-full flex-col gap-3">
            <div className="min-h-8">
              <div className="flex flex-nowrap items-center gap-2 overflow-x-auto">
                {supportsBrowser && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionBusy}
                    onClick={onStartBrowserOAuth}
                  >
                    {browserLoading && (
                      <IconLoader2 className="size-4 animate-spin" />
                    )}
                    <IconBrandOpenai className="size-4" />
                    {t("credentials.actions.browser")}
                  </Button>
                )}

                {supportsBrowser && oauthLoading && !deviceLoading && (
                  <Button
                    size="icon-xs"
                    variant="secondary"
                    onClick={onStopLoading}
                    aria-label={stopLabel}
                    title={stopLabel}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <IconPlayerStopFilled className="size-4" />
                  </Button>
                )}

                {supportsDeviceCode && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionBusy}
                    onClick={onStartDeviceCode}
                  >
                    {deviceLoading && (
                      <IconLoader2 className="size-4 animate-spin" />
                    )}
                    <IconClockHour4 className="size-4" />
                    {t("credentials.actions.deviceCode")}
                  </Button>
                )}
              </div>
            </div>

            <div className="min-h-9 flex-1">
              <div className="flex h-full items-center gap-2">
                <label htmlFor="openai-api-token" className="sr-only">
                  {tokenLabel}
                </label>
                <Input
                  id="openai-api-token"
                  name="openai_api_token"
                  value={token}
                  onChange={(e) => onTokenChange(e.target.value)}
                  type="password"
                  placeholder={tokenLabel}
                  autoComplete="new-password"
                />
                <Button
                  size="sm"
                  disabled={actionBusy || !token.trim()}
                  onClick={onSaveToken}
                >
                  {tokenLoading && (
                    <IconLoader2 className="size-4 animate-spin" />
                  )}
                  <IconKey className="size-4" />
                  {t("credentials.actions.saveToken")}
                </Button>
                {tokenLoading && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={onStopLoading}
                    aria-label={stopLabel}
                    title={stopLabel}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <IconPlayerStopFilled className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      }
      footer={
        status?.logged_in ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={actionBusy}
            onClick={onAskLogout}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {activeAction === "openai:logout" && (
              <IconLoader2 className="size-4 animate-spin" />
            )}
            {t("credentials.actions.logout")}
          </Button>
        ) : null
      }
    />
  )
}
