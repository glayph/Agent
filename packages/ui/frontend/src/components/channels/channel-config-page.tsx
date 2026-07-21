import { IconActivityHeartbeat, IconLoader2 } from "@tabler/icons-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  type ChannelConfig,
  type ChannelRuntimeProbeResponse,
  type SupportedChannel,
  getChannelConfig,
  getChannelsCatalog,
  patchAppConfig,
  probeChannelRuntime,
} from "@/api/channels"
import { type ArrayFieldFlusher } from "@/components/channels/channel-array-list-field"
import {
  buildEditConfig,
  getFieldValueForValidation,
} from "@/components/channels/channel-config-fields"
import {
  buildSavePayload,
  getChannelFieldValidationError,
  getMissingRequiredFieldKeys,
  getRequiredFieldKeys,
  normalizeConfig,
} from "@/components/channels/channel-config-model"
import { getChannelDisplayName } from "@/components/channels/channel-display-name"
import { DingTalkForm } from "@/components/channels/channel-forms/dingtalk-form"
import { DiscordForm } from "@/components/channels/channel-forms/discord-form"
import { FeishuForm } from "@/components/channels/channel-forms/feishu-form"
import { GenericForm } from "@/components/channels/channel-forms/generic-form"
import { IRCForm } from "@/components/channels/channel-forms/irc-form"
import { LineForm } from "@/components/channels/channel-forms/line-form"
import { MatrixForm } from "@/components/channels/channel-forms/matrix-form"
import { MqttForm } from "@/components/channels/channel-forms/mqtt-form"
import { OneBotForm } from "@/components/channels/channel-forms/onebot-form"
import { QQForm } from "@/components/channels/channel-forms/qq-form"
import { SlackForm } from "@/components/channels/channel-forms/slack-form"
import { TelegramForm } from "@/components/channels/channel-forms/telegram-form"
import { WecomForm } from "@/components/channels/channel-forms/wecom-form"
import { WeixinForm } from "@/components/channels/channel-forms/weixin-form"
import {
  WhatsAppForm,
  WhatsAppNativeForm,
} from "@/components/channels/channel-forms/whatsapp-form"
import { ConfigChangeNotice } from "@/components/config-change-notice"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useGateway } from "@/hooks/use-gateway"
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard"
import { showSaveSuccessOrRestartToast } from "@/lib/restart-required"
import { refreshGatewayState } from "@/store/gateway"

interface ChannelConfigPageProps {
  channelName: string
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function asBool(value: unknown): boolean {
  return value === true
}

function setRecordValueByPath(
  source: Record<string, unknown>,
  pathSegments: string[],
  value: unknown,
): Record<string, unknown> {
  const [segment, ...rest] = pathSegments
  if (!segment) {
    return source
  }
  if (rest.length === 0) {
    return { ...source, [segment]: value }
  }
  return {
    ...source,
    [segment]: setRecordValueByPath(asRecord(source[segment]), rest, value),
  }
}

function setConfigValueByPath(
  source: ChannelConfig,
  fieldPath: string,
  value: unknown,
): ChannelConfig {
  return setRecordValueByPath(source, fieldPath.split("."), value)
}

function getChannelDocSlug(channelName: string): string {
  return channelName.replaceAll("_", "-")
}

function runtimeStatusLabel(
  status: SupportedChannel["runtime_status"],
): string {
  switch (status) {
    case "functional":
      return "Functional"
    case "partial":
      return "Partial"
    case "config_only":
      return "Config surface"
    default:
      return ""
  }
}

function runtimeStatusClass(
  status: SupportedChannel["runtime_status"],
): string {
  switch (status) {
    case "functional":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    case "partial":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    case "config_only":
      return "border-muted-foreground/25 text-muted-foreground"
    default:
      return ""
  }
}

function probeStatusLabel(
  status: ChannelRuntimeProbeResponse["probe_status"],
): string {
  switch (status) {
    case "ready":
      return "Ready"
    case "disabled":
      return "Disabled"
    case "needs_config":
      return "Needs config"
    case "auth_failed":
      return "Auth failed"
    case "webhook_failed":
      return "Webhook failed"
    case "rate_limited":
      return "Rate limited"
    case "runtime_error":
      return "Runtime error"
    case "partial":
      return "Partial"
    case "not_implemented":
      return "Config surface only"
    default:
      return ""
  }
}

function probeStatusClass(
  status: ChannelRuntimeProbeResponse["probe_status"],
): string {
  switch (status) {
    case "ready":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
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

const CHANNELS_WITHOUT_DOCS = new Set([
  "pico",
  "wecom",
  "matrix",
  "irc",
  "whatsapp",
  "whatsapp_native",
  "mqtt",
])

export function ChannelConfigPage({ channelName }: ChannelConfigPageProps) {
  const { t, i18n } = useTranslation()
  const { state: gatewayState } = useGateway()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const [fetchError, setFetchError] = useState("")
  const [serverError, setServerError] = useState("")
  const [probeError, setProbeError] = useState("")
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const [channel, setChannel] = useState<SupportedChannel | null>(null)
  const [probeResult, setProbeResult] =
    useState<ChannelRuntimeProbeResponse | null>(null)
  const [baseConfig, setBaseConfig] = useState<ChannelConfig>({})
  const [editConfig, setEditConfig] = useState<ChannelConfig>({})
  const [configuredSecrets, setConfiguredSecrets] = useState<string[]>([])
  const [enabled, setEnabled] = useState(false)
  const [arrayFieldResetVersion, setArrayFieldResetVersion] = useState(0)
  const arrayFieldFlushersRef = useRef(new Map<string, ArrayFieldFlusher>())
  const loadRequestIdRef = useRef(0)

  const resetPageState = useCallback(() => {
    arrayFieldFlushersRef.current.clear()
    setChannel(null)
    setBaseConfig({})
    setEditConfig({})
    setConfiguredSecrets([])
    setEnabled(false)
    setFetchError("")
    setServerError("")
    setProbeError("")
    setProbeResult(null)
    setFieldErrors({})
    setArrayFieldResetVersion((version) => version + 1)
  }, [])

  const loadData = useCallback(
    async (silent = false) => {
      const requestId = loadRequestIdRef.current + 1
      loadRequestIdRef.current = requestId
      if (!silent) setLoading(true)
      try {
        const catalog = await getChannelsCatalog()
        if (loadRequestIdRef.current !== requestId) return
        const matched =
          catalog.channels.find((item) => item.name === channelName) ?? null

        if (!matched) {
          resetPageState()
          setFetchError(
            t("channels.page.notFound", {
              name: channelName,
            }),
          )
          return
        }

        const channelConfig = await getChannelConfig(channelName)
        if (loadRequestIdRef.current !== requestId) return
        const raw = asRecord(channelConfig.config)
        const normalized = normalizeConfig(matched, raw)

        setChannel(matched)
        setBaseConfig(normalized)
        setEditConfig(buildEditConfig(matched.name, normalized))
        setConfiguredSecrets(channelConfig.configured_secrets ?? [])
        setEnabled(asBool(normalized.enabled))
        setFetchError("")
        setServerError("")
        setProbeError("")
        setProbeResult(null)
        setFieldErrors({})
      } catch (e) {
        if (loadRequestIdRef.current !== requestId) return
        setConfiguredSecrets([])
        setFetchError(e instanceof Error ? e.message : t("channels.loadError"))
      } finally {
        if (!silent && loadRequestIdRef.current === requestId) {
          setLoading(false)
        }
      }
    },
    [channelName, resetPageState, t],
  )

  useEffect(() => {
    resetPageState()
    setLoading(true)
    loadData()
  }, [loadData, resetPageState])

  const previousGatewayStatusRef = useRef(gatewayState)
  useEffect(() => {
    const previousStatus = previousGatewayStatusRef.current
    if (previousStatus !== "running" && gatewayState === "running") {
      void loadData()
    }
    previousGatewayStatusRef.current = gatewayState
  }, [gatewayState, loadData])

  const isDirty = useMemo(() => {
    if (loading || !channel || channel.name !== channelName) return false
    const basePayload = buildSavePayload(
      channel,
      buildEditConfig(channel.name, baseConfig),
      asBool(baseConfig.enabled),
    )
    const currentPayload = buildSavePayload(channel, editConfig, enabled)
    return JSON.stringify(basePayload) !== JSON.stringify(currentPayload)
  }, [baseConfig, channel, channelName, editConfig, enabled, loading])
  useUnsavedChangesGuard(isDirty)

  const docsUrl = useMemo(() => {
    if (!channel) return ""
    if (CHANNELS_WITHOUT_DOCS.has(channel.name)) return ""
    const language = (
      i18n.resolvedLanguage ??
      i18n.language ??
      ""
    ).toLowerCase()
    const base = language.startsWith("zh")
      ? "https://docs.Hiro.io/zh-Hans/docs/channels"
      : "https://docs.Hiro.io/docs/channels"
    return `${base}/${getChannelDocSlug(channel.name)}`
  }, [channel, i18n.language, i18n.resolvedLanguage])

  const channelDisplayName = useMemo(() => {
    if (!channel) return channelName
    return getChannelDisplayName(channel, t)
  }, [channel, channelName, t])

  const hidesPageLevelEnableToggle = false

  const hiddenKeys = useMemo(() => {
    if (!channel) return []
    if (channel.name === "whatsapp") {
      return ["use_native"]
    }
    return []
  }, [channel])
  const requiredKeys = useMemo(
    () => getRequiredFieldKeys(channelName),
    [channelName],
  )

  const handleChange = useCallback((key: string, value: unknown) => {
    const normalizedKey = key.startsWith("_") ? key.slice(1) : key
    setEditConfig((prev) => ({ ...prev, [key]: value }))
    setFieldErrors((prev) => {
      if (!(key in prev) && !(normalizedKey in prev)) {
        return prev
      }
      const next = { ...prev }
      delete next[key]
      delete next[normalizedKey]
      return next
    })
  }, [])

  const registerArrayFieldFlusher = useCallback(
    (fieldPath: string, flusher: ArrayFieldFlusher | null) => {
      if (flusher) {
        arrayFieldFlushersRef.current.set(fieldPath, flusher)
        return
      }
      arrayFieldFlushersRef.current.delete(fieldPath)
    },
    [],
  )

  const flushPendingArrayFieldDrafts = useCallback(
    (sourceConfig: ChannelConfig): ChannelConfig => {
      let nextConfig = sourceConfig
      for (const [fieldPath, flusher] of arrayFieldFlushersRef.current) {
        const flushedValue = flusher()
        if (flushedValue === null) {
          continue
        }
        nextConfig = setConfigValueByPath(nextConfig, fieldPath, flushedValue)
      }
      return nextConfig
    },
    [],
  )

  const handleReset = () => {
    if (!channel) return
    setEditConfig(buildEditConfig(channel.name, baseConfig))
    setEnabled(asBool(baseConfig.enabled))
    setServerError("")
    setFieldErrors({})
    setArrayFieldResetVersion((version) => version + 1)
  }

  const handleSave = async () => {
    if (!channel) return

    const preparedEditConfig = flushPendingArrayFieldDrafts(editConfig)
    if (preparedEditConfig !== editConfig) {
      setEditConfig(preparedEditConfig)
    }

    const nextFieldErrors: Record<string, string> = {}
    const missingRequiredFields = getMissingRequiredFieldKeys(
      channel.name,
      preparedEditConfig,
      configuredSecrets,
      enabled,
    )
    if (missingRequiredFields.length > 0) {
      const requiredFieldError = t("channels.validation.requiredField")
      for (const key of missingRequiredFields) {
        nextFieldErrors[key] = requiredFieldError
      }
    }
    for (const key of requiredKeys) {
      const error = getChannelFieldValidationError(
        channel.name,
        key,
        getFieldValueForValidation(preparedEditConfig, configuredSecrets, key),
      )
      if (error) {
        nextFieldErrors[key] = error
      }
    }
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors)
      setServerError("")
      return
    }

    setSaving(true)
    setServerError("")
    setFieldErrors({})
    try {
      const savePayload = buildSavePayload(channel, preparedEditConfig, enabled)
      await patchAppConfig({
        channel_list: {
          [channel.config_key]: savePayload,
        },
      })
      await loadData()
      const gateway = await refreshGatewayState({ force: true })
      showSaveSuccessOrRestartToast(
        t,
        t("channels.page.saveSuccess"),
        channelDisplayName,
        gateway?.restartRequired === true,
      )
    } catch (e) {
      const message =
        e instanceof Error ? e.message : t("channels.page.saveError")
      setServerError(message)
    } finally {
      setSaving(false)
    }
  }

  const handleProbe = async (
    mode?: ChannelRuntimeProbeResponse["check_mode"],
  ) => {
    if (!channel || isDirty) return
    setProbing(true)
    setProbeError("")
    try {
      const result = await probeChannelRuntime(channel.name, mode)
      setProbeResult(result)
    } catch (e) {
      setProbeError(
        e instanceof Error ? e.message : t("channels.page.probeError"),
      )
    } finally {
      setProbing(false)
    }
  }

  const handleQrBindingComplete = useCallback(() => {
    void loadData(true)
    void refreshGatewayState({ force: true })
  }, [loadData])

  const renderForm = () => {
    if (!channel) return null

    switch (channel.name) {
      case "telegram":
        return (
          <TelegramForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
            registerArrayFieldFlusher={registerArrayFieldFlusher}
            arrayFieldResetVersion={arrayFieldResetVersion}
          />
        )
      case "discord":
        return (
          <DiscordForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
            registerArrayFieldFlusher={registerArrayFieldFlusher}
            arrayFieldResetVersion={arrayFieldResetVersion}
          />
        )
      case "slack":
        return (
          <SlackForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
            registerArrayFieldFlusher={registerArrayFieldFlusher}
            arrayFieldResetVersion={arrayFieldResetVersion}
          />
        )
      case "feishu":
        return (
          <FeishuForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
            registerArrayFieldFlusher={registerArrayFieldFlusher}
            arrayFieldResetVersion={arrayFieldResetVersion}
          />
        )
      case "dingtalk":
        return (
          <DingTalkForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
          />
        )
      case "qq":
        return (
          <QQForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
          />
        )
      case "mqtt":
        return (
          <MqttForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
          />
        )
      case "weixin":
        return (
          <WeixinForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
            registerArrayFieldFlusher={registerArrayFieldFlusher}
            arrayFieldResetVersion={arrayFieldResetVersion}
            onBindingComplete={handleQrBindingComplete}
          />
        )
      case "wecom":
        return (
          <WecomForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
            registerArrayFieldFlusher={registerArrayFieldFlusher}
            arrayFieldResetVersion={arrayFieldResetVersion}
            onBindingComplete={handleQrBindingComplete}
          />
        )
      case "line":
        return (
          <LineForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
          />
        )
      case "onebot":
        return (
          <OneBotForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
            registerArrayFieldFlusher={registerArrayFieldFlusher}
            arrayFieldResetVersion={arrayFieldResetVersion}
          />
        )
      case "whatsapp":
        return (
          <WhatsAppForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
            registerArrayFieldFlusher={registerArrayFieldFlusher}
            arrayFieldResetVersion={arrayFieldResetVersion}
          />
        )
      case "whatsapp_native":
        return (
          <WhatsAppNativeForm
            config={editConfig}
            onChange={handleChange}
            fieldErrors={fieldErrors}
          />
        )
      case "matrix":
        return (
          <MatrixForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            fieldErrors={fieldErrors}
          />
        )
      case "irc":
        return (
          <IRCForm
            config={editConfig}
            onChange={handleChange}
            fieldErrors={fieldErrors}
          />
        )
      default:
        return (
          <GenericForm
            config={editConfig}
            onChange={handleChange}
            configuredSecrets={configuredSecrets}
            hiddenKeys={hiddenKeys}
            requiredKeys={requiredKeys}
            supportsStreaming={channel?.name === "pico"}
            fieldErrors={fieldErrors}
            registerArrayFieldFlusher={registerArrayFieldFlusher}
            arrayFieldResetVersion={arrayFieldResetVersion}
          />
        )
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={channelDisplayName}
        titleExtra={
          channel && (
            <div className="flex min-w-0 items-center gap-2">
              {channel.runtime_status && (
                <Badge
                  variant="outline"
                  className={runtimeStatusClass(channel.runtime_status)}
                  title={channel.runtime_note}
                >
                  {runtimeStatusLabel(channel.runtime_status)}
                </Badge>
              )}
              {docsUrl && (
                <a
                  href={docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground hidden text-xs underline underline-offset-2 sm:inline-flex"
                >
                  {t("channels.page.docLink")}
                </a>
              )}
            </div>
          )
        }
      />

      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 pb-8 sm:px-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <IconLoader2 className="text-muted-foreground size-6 animate-spin" />
          </div>
        ) : fetchError ? (
          <div className="text-destructive bg-destructive/10 rounded-lg px-4 py-3 text-sm">
            {fetchError}
          </div>
        ) : (
          <div className="w-full max-w-4xl space-y-6 pt-5">
            {!hidesPageLevelEnableToggle && (
              <div className="bg-card text-card-foreground border-border/60 flex items-center justify-between rounded-xl border px-6 py-4 shadow-sm">
                <p className="text-sm font-medium">
                  {t("channels.page.enableLabel")}
                </p>
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-label={t("channels.page.enableLabel")}
                />
              </div>
            )}

            {renderForm()}

            <div className="border-border/60 bg-card text-card-foreground rounded-lg border px-4 py-3 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">
                      {t("channels.page.probeTitle")}
                    </p>
                    {probeResult && (
                      <Badge
                        variant="outline"
                        className={probeStatusClass(probeResult.probe_status)}
                      >
                        {probeStatusLabel(probeResult.probe_status)}
                      </Badge>
                    )}
                  </div>
                  {probeError && (
                    <p className="text-destructive mt-1 text-sm">
                      {probeError}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleProbe()}
                  disabled={!channel || probing || isDirty}
                  title={
                    isDirty
                      ? t("channels.page.probeSaveFirst")
                      : t("channels.page.probeRun")
                  }
                >
                  {probing ? (
                    <IconLoader2 className="size-4 animate-spin" />
                  ) : (
                    <IconActivityHeartbeat className="size-4" />
                  )}
                  {probing
                    ? t("channels.page.probing")
                    : t("channels.page.probeRun")}
                </Button>
                {channel?.name === "telegram" && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleProbe("live")}
                    disabled={!channel || probing || isDirty}
                    title={
                      isDirty
                        ? t("channels.page.probeSaveFirst")
                        : t("channels.page.telegramLiveTest", {
                            defaultValue: "Run Telegram live test",
                          })
                    }
                  >
                    {probing ? (
                      <IconLoader2 className="size-4 animate-spin" />
                    ) : (
                      <IconActivityHeartbeat className="size-4" />
                    )}
                    {t("channels.page.telegramLiveTest", {
                      defaultValue: "Telegram live test",
                    })}
                  </Button>
                )}
              </div>

              {probeResult && (
                <div className="mt-3 space-y-2 border-t pt-3">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="outline">
                      {t("channels.page.probeMode", {
                        mode: probeResult.check_mode,
                        defaultValue: "Mode: {{mode}}",
                      })}
                    </Badge>
                    <Badge variant="outline">
                      {t("channels.page.probeLatency", {
                        latency: probeResult.latency_ms,
                        defaultValue: "{{latency}}ms",
                      })}
                    </Badge>
                    {probeResult.send_check && (
                      <Badge variant="outline">
                        {t("channels.page.sendCheck", {
                          status: probeResult.send_check.status,
                          defaultValue: "Send: {{status}}",
                        })}
                      </Badge>
                    )}
                    {probeResult.failure_code && (
                      <Badge variant="outline">
                        {probeResult.failure_code}
                      </Badge>
                    )}
                  </div>
                  <div className="grid gap-2 text-xs sm:grid-cols-2">
                    {probeResult.checks.map((check) => (
                      <div key={check.id} className="min-w-0">
                        <span
                          className={`font-medium uppercase ${checkStatusClass(
                            check.status,
                          )}`}
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
                  {probeResult.next_steps.length > 0 && (
                    <div className="text-muted-foreground space-y-1 text-xs">
                      {probeResult.next_steps.map((step) => (
                        <p key={step}>{step}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {serverError && (
              <p className="text-destructive text-sm">{serverError}</p>
            )}

            {isDirty && (
              <ConfigChangeNotice
                kind="save"
                title={t("common.saveChangesTitle")}
                description={t("channels.page.savePrompt")}
              />
            )}

            <div className="border-border/60 flex justify-end gap-2 border-t py-4">
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={!isDirty || saving}
              >
                {t("common.reset")}
              </Button>
              <Button onClick={handleSave} disabled={!isDirty || saving}>
                {saving ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
