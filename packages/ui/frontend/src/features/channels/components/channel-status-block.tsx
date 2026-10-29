import {
  IconActivityHeartbeat,
  IconChevronDown,
  IconLoader2,
} from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import type {
  ChannelRuntimeProbeResponse,
  SupportedChannel,
} from "@/api/channels"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu"
import { Switch } from "@/shared/ui/switch"

/** Channels whose "live" probe verifies the credential with the provider (read-only). */
const LIVE_AUTH_CHECK_CHANNELS = new Set(["telegram", "discord", "slack"])

function supportsLiveAuthCheck(channelName: string | undefined) {
  return channelName !== undefined && LIVE_AUTH_CHECK_CHANNELS.has(channelName)
}

function probeStatusClass(
  status: ChannelRuntimeProbeResponse["probe_status"],
): string {
  switch (status) {
    case "ready":
      return "border-emerald-500/30 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300"
    case "disabled":
    case "needs_config":
    case "partial":
    case "rate_limited":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    case "auth_failed":
    case "webhook_failed":
    case "runtime_error":
    case "not_implemented":
      return "border-destructive/30 bg-destructive/10 text-destructive"
    default:
      return ""
  }
}

function checkStatusClass(
  status: ChannelRuntimeProbeResponse["checks"][number]["status"],
): string {
  switch (status) {
    case "pass":
      return "text-emerald-700 dark:text-emerald-300"
    case "warn":
      return "text-amber-700 dark:text-amber-300"
    case "fail":
      return "text-destructive"
    default:
      return "text-muted-foreground"
  }
}

function formatCheckedAt(value: string | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString()
}

interface ChannelStatusBlockProps {
  channel: SupportedChannel | null
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  /** False for QR-binding channels (hidesPageLevelEnableToggle): the block stays, the switch goes. */
  showEnableSwitch: boolean
  runtimeConnecting: boolean
  probing: boolean
  probeResult: ChannelRuntimeProbeResponse | null
  probeError: string
  onProbe: (mode?: ChannelRuntimeProbeResponse["check_mode"]) => void
}

export function ChannelStatusBlock({
  channel,
  enabled,
  onEnabledChange,
  showEnableSwitch,
  runtimeConnecting,
  probing,
  probeResult,
  probeError,
  onProbe,
}: ChannelStatusBlockProps) {
  const { t } = useTranslation()

  const connectionLabel = !enabled
    ? t("channels.page.connectionDisabled")
    : channel?.runtime_status !== "functional"
      ? t("channels.page.connectionSavedOnly")
      : channel?.runtime_error
        ? t("channels.page.connectionError")
        : channel?.runtime_connected
          ? t("channels.page.connectionConnected")
          : !channel?.configured
            ? t("channels.page.connectionNeedsSetup")
            : t("channels.page.connectionConnecting")

  const testLabel = probing
    ? t("channels.page.probing")
    : t("channels.page.testConnection")
  const testIcon = probing ? (
    <IconLoader2 className="size-4 animate-spin" />
  ) : (
    <IconActivityHeartbeat className="size-4" />
  )
  const checkedAt = formatCheckedAt(probeResult?.checked_at)

  return (
    <section
      aria-label={t("channels.page.statusBlock")}
      className="bg-card text-card-foreground border-border/60 rounded-xl border shadow-sm"
    >
      <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {t("channels.page.statusBlock")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{connectionLabel}</Badge>
            {runtimeConnecting && (
              <IconLoader2
                className="text-muted-foreground size-3.5 animate-spin"
                aria-hidden="true"
              />
            )}
            {channel?.runtime_error && (
              <span
                className="text-destructive max-w-full truncate text-xs"
                title={channel.runtime_error}
              >
                {channel.runtime_error}
              </span>
            )}
          </div>
        </div>
        {showEnableSwitch && (
          <div className="flex shrink-0 items-center gap-3">
            <p className="text-sm font-medium">
              {t("channels.page.enableLabel")}
            </p>
            <Switch
              checked={enabled}
              onCheckedChange={onEnabledChange}
              aria-label={t("channels.page.enableLabel")}
            />
          </div>
        )}
      </div>

      <div className="border-border/60 flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">
              {t("channels.page.lastTest")}
            </p>
            {probeResult ? (
              <Badge
                variant="outline"
                className={probeStatusClass(probeResult.probe_status)}
              >
                {t(`channels.page.probeStatus.${probeResult.probe_status}`)}
              </Badge>
            ) : (
              <span className="text-muted-foreground text-xs">
                {t("channels.page.neverTested")}
              </span>
            )}
            {checkedAt && (
              <span className="text-muted-foreground text-xs">
                {checkedAt}
              </span>
            )}
          </div>
          {probeError && (
            <p className="text-destructive text-sm" role="alert">
              {probeError}
            </p>
          )}
        </div>

        {supportsLiveAuthCheck(channel?.name) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={probing}
                title={t("channels.page.probeRun")}
              >
                {testIcon}
                {testLabel}
                <IconChevronDown className="size-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={probing}
                onSelect={() => onProbe()}
              >
                {t("channels.page.quickCheck")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={probing}
                onSelect={() => onProbe("live")}
              >
                {t("channels.page.liveAdapterCheck")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => onProbe()}
            disabled={!channel || probing}
            title={t("channels.page.probeRun")}
          >
            {testIcon}
            {testLabel}
          </Button>
        )}
      </div>

      {probeResult && (
        <div className="border-border/60 space-y-2 border-t px-4 py-3 sm:px-5">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">
              {t("channels.page.probeMode", { mode: probeResult.check_mode })}
            </Badge>
            <Badge variant="outline">
              {t("channels.page.probeLatency", {
                latency: probeResult.latency_ms,
              })}
            </Badge>
            {probeResult.send_check && (
              <Badge variant="outline">
                {t("channels.page.sendCheck", {
                  status: probeResult.send_check.status,
                })}
              </Badge>
            )}
            {probeResult.failure_code && (
              <Badge variant="outline">{probeResult.failure_code}</Badge>
            )}
          </div>
          <details className="text-xs">
            <summary className="text-muted-foreground cursor-pointer py-1">
              {t("channels.page.probeDetails")}
            </summary>
            <div className="grid gap-2 pt-2 sm:grid-cols-2">
              {probeResult.checks.map((check) => (
                <div key={check.id} className="min-w-0">
                  <span
                    className={`font-medium uppercase ${checkStatusClass(check.status)}`}
                  >
                    {check.status}
                  </span>
                  <span className="text-muted-foreground break-words">
                    {" "}
                    {check.message}
                  </span>
                </div>
              ))}
            </div>
          </details>
          {probeResult.next_steps.length > 0 && (
            <div className="text-muted-foreground space-y-1 text-xs">
              {probeResult.next_steps.map((step) => (
                <p key={step}>{step}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
