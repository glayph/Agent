import {
  IconKey,
  IconLoader2,
  IconPlayerStopFilled,
  IconSparkles,
  IconEye,
  IconEyeOff,
  IconCopy,
  IconCheck,
} from "@tabler/icons-react"
import { useTranslation } from "react-i18next"
import { useState } from "react"

import type { OAuthProviderStatus } from "@/api/oauth"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"

import { CredentialCard } from "./credential-card"

interface AnthropicCredentialCardProps {
  status?: OAuthProviderStatus
  activeAction: string
  token: string
  onTokenChange: (value: string) => void
  onStopLoading: () => void
  onSaveToken: () => void
  onAskLogout: () => void
  revealedToken?: string
  onRevealToken: () => void
  onHideToken: () => void
}

export function AnthropicCredentialCard({
  status,
  activeAction,
  token,
  onTokenChange,
  onStopLoading,
  onSaveToken,
  onAskLogout,
  revealedToken,
  onRevealToken,
  onHideToken,
}: AnthropicCredentialCardProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const actionBusy = activeAction !== ""
  const tokenLoading = activeAction === "anthropic:token"
  const stopLabel = t("credentials.actions.stopLoading")
  const tokenLabel = t("credentials.fields.anthropicToken")

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
            <IconSparkles className="size-3.5" />
          </span>
          <span>Anthropic</span>
        </span>
      }
      description={t("credentials.providers.anthropic.description")}
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
        <div className="border-muted flex h-[120px] flex-col justify-center rounded-lg border p-3">
          <div className="flex h-full flex-col gap-3">
            <div className="flex h-full items-center gap-2">
              <label htmlFor="anthropic-api-token" className="sr-only">
                {tokenLabel}
              </label>
              <Input
                id="anthropic-api-token"
                name="anthropic_api_token"
                value={token}
                onChange={(e) => onTokenChange(e.target.value)}
                type="password"
                placeholder={tokenLabel}
                autoComplete="new-password"
              />
              <Button
                size="sm"
                className="w-fit"
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
            {activeAction === "anthropic:logout" && (
              <IconLoader2 className="size-4 animate-spin" />
            )}
            {t("credentials.actions.logout")}
          </Button>
        ) : null
      }
    />
  )
}
