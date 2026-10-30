import {
  IconAlertTriangle,
  IconLoader2,
} from "@tabler/icons-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
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
import { ConfigChangeNotice } from "@/app/layout/config-change-notice"
import { PageHeader } from "@/app/layout/page-header"
import { DingTalkForm } from "@/features/channels/channel-forms/dingtalk-form"
import { DiscordForm } from "@/features/channels/channel-forms/discord-form"
import { FeishuForm } from "@/features/channels/channel-forms/feishu-form"
import { GenericForm } from "@/features/channels/channel-forms/generic-form"
import { IRCForm } from "@/features/channels/channel-forms/irc-form"
import { LineForm } from "@/features/channels/channel-forms/line-form"
import { MatrixForm } from "@/features/channels/channel-forms/matrix-form"
import { MqttForm } from "@/features/channels/channel-forms/mqtt-form"
import { OneBotForm } from "@/features/channels/channel-forms/onebot-form"
import { QQForm } from "@/features/channels/channel-forms/qq-form"
import { SlackForm } from "@/features/channels/channel-forms/slack-form"
import { TelegramForm } from "@/features/channels/channel-forms/telegram-form"
import { WecomForm } from "@/features/channels/channel-forms/wecom-form"
import { WeixinForm } from "@/features/channels/channel-forms/weixin-form"
import {
  WhatsAppForm,
  WhatsAppNativeForm,
} from "@/features/channels/channel-forms/whatsapp-form"
import { type ArrayFieldFlusher } from "@/features/channels/components/channel-array-list-field"
import {
  filterChannels,
  groupCatalogChannels,
  isLiveChannel,
} from "@/features/channels/components/channel-catalog"
import { ChannelStatusBlock } from "@/features/channels/components/channel-status-block"
import {
  buildEditConfig,
  getFieldValueForValidation,
} from "@/features/channels/components/channel-config-fields"
import {
  buildSavePayload,
  getChannelFieldValidationError,
  getMissingRequiredFieldKeys,
  getRequiredFieldKeys,
  normalizeConfig,
} from "@/features/channels/components/channel-config-model"
import { getChannelDisplayName } from "@/features/channels/components/channel-display-name"
import { useGateway } from "@/hooks/use-gateway"
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard"
import { showSaveSuccessOrRestartToast } from "@/lib/restart-required"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"
import { refreshGatewayState } from "@/store/gateway"

interface ChannelConfigPageProps {
  channelName: string
}

function channelCatalogStatus(channel: SupportedChannel): {
  labelKey: "channels.page.statusLive" | "channels.page.statusSavedOnly" | "channels.page.statusNotConfigured"
  className: string
} {
  if (isLiveChannel(channel)) {
    return {
      labelKey: "channels.page.statusLive",
      className: "border-emerald-500/30 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300",
    }
  }
  if (channel.configured) {
    return {
      labelKey: "channels.page.statusSavedOnly",
      className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    }
  }
  return {
    labelKey: "channels.page.statusNotConfigured",
    className: "border-border bg-muted text-muted-foreground",
  }
}

export function ChannelCatalogPage() {
  const { t } = useTranslation()
  const [channels, setChannels] = useState<SupportedChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [search, setSearch] = useState("")

  useEffect(() => {
    let active = true
    void getChannelsCatalog()
      .then((response) => {
        if (active) setChannels(response.channels)
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : t("channels.loadError"))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [t])

  const configuredCount = channels.filter((channel) => channel.configured).length
  const filteredChannels = filterChannels(channels, search)
  const groups = groupCatalogChannels(filteredChannels).map((group) => ({
    ...group,
    title: t(`channels.catalog.groups.${group.key}`),
  }))
  const isLive = isLiveChannel

  return (
    <div className="flex h-full flex-col" data-miki-page="channels">
      <PageHeader
        title={t("channels.title", { defaultValue: "Channels" })}
        titleExtra={
          <Badge variant="outline" className="text-muted-foreground">
            {t("channels.catalog.configuredCount", {
              count: configuredCount,
              total: channels.length,
              defaultValue: "{{count}}/{{total}} configured",
            })}
          </Badge>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 sm:px-6" data-miki-page-body="true">
        <div className="mx-auto w-full max-w-4xl space-y-5 pt-4">
          <p className="text-muted-foreground text-sm">
            {t("channels.catalog.description")}
          </p>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("channels.catalog.searchPlaceholder")}
            aria-label={t("channels.catalog.searchPlaceholder")}
            className="h-9 max-w-md shadow-none"
          />

          {loading ? (
            <div className="text-muted-foreground flex justify-center py-16">
              <IconLoader2 className="size-6 animate-spin" />
            </div>
          ) : error ? (
            <div className="text-destructive bg-destructive/10 rounded-xl px-4 py-3 text-sm" role="alert">
              {error}
            </div>
          ) : filteredChannels.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-8 text-center text-sm">
              {t("channels.catalog.noResults")}
            </p>
          ) : (
            <div className="space-y-6">
              {groups.map((group) => (
                <section key={group.key} className="space-y-2" aria-labelledby={`channel-group-${group.key}`}>
                  <h2 id={`channel-group-${group.key}`} className="text-muted-foreground px-1 text-xs font-semibold tracking-wide uppercase">
                    {group.title} <span className="tabular-nums">({group.channels.length})</span>
                  </h2>
                  <div className="divide-border/70 overflow-hidden rounded-lg border">
                    {group.channels.map((channel) => {
                      const status = channelCatalogStatus(channel)
                      const capabilityLabel = channel.runtime_status === "functional"
                        ? t("channels.catalog.capabilityLiveAdapter")
                        : channel.runtime_status === "partial"
                          ? t("channels.catalog.capabilityPartial")
                          : t("channels.catalog.capabilityConfigOnly")
                      const capabilityClass = channel.runtime_status === "functional"
                        ? "border-emerald-500/30 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300"
                        : channel.runtime_status === "partial"
                          ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                          : "border-border text-muted-foreground"
                      return (
                        <Link
                          key={channel.name}
                          to="/channels/$name"
                          params={{ name: channel.name }}
                          className="hover:bg-muted/30 focus-visible:bg-muted/30 flex items-center gap-3 px-3 py-3 outline-none transition-colors sm:px-4"
                        >
                          <span
                            aria-hidden="true"
                            className={`size-2.5 shrink-0 rounded-full ${isLive(channel) ? "bg-emerald-500" : channel.runtime_status === "functional" ? "bg-amber-500" : channel.configured ? "bg-amber-500" : "bg-muted-foreground/40"}`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium">{getChannelDisplayName(channel, t)}</span>
                              <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-normal ${capabilityClass}`}>
                                {capabilityLabel}
                              </Badge>
                            </span>
                            <span className="text-muted-foreground mt-1 block truncate text-xs">
                              {channel.runtime_error || channel.runtime_note || t(status.labelKey)}
                            </span>
                          </span>
                          <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
                            {t("channels.catalog.configure")}
                          </span>
                        </Link>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
          {!loading && !error && channels.length > 0 && (
            <div className="text-muted-foreground flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs leading-5">
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
              <span>{t("channels.catalog.truthNotice")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
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

function hasAllowedPeers(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => String(item).trim() !== "")
  return typeof value === "string" && value.trim().length > 0
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

function runtimeStatusTranslationKey(
  status: SupportedChannel["runtime_status"],
): string {
  switch (status) {
    case "functional":
      return "channels.catalog.capabilityLiveAdapter"
    case "partial":
      return "channels.catalog.capabilityPartial"
    case "config_only":
      return "channels.catalog.capabilityConfigOnly"
    default:
      return "channels.catalog.capabilityConfigOnly"
  }
}

function runtimeStatusClass(
  status: SupportedChannel["runtime_status"],
): string {
  switch (status) {
    case "functional":
      return "border-emerald-500/30 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300"
    case "partial":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    case "config_only":
      return "border-muted-foreground/25 text-muted-foreground"
    default:
      return ""
  }
}

const CHANNELS_WITHOUT_DOCS = new Set([
  "miki",
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
  const [runtimeConnecting, setRuntimeConnecting] = useState(false)
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
    setRuntimeConnecting(false)
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
        // Never retrieve saved tokens into browser state. The safe config response
        // supplies configured_secrets so secret fields can show “already set” placeholders.
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
      ? "https://docs.Miki.io/zh-Hans/docs/channels"
      : "https://docs.Miki.io/docs/channels"
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
      const channelApply = await patchAppConfig({
        channel_list: {
          [channel.config_key]: savePayload,
        },
      })
      await loadData()
      const gateway = await refreshGatewayState({ force: true })
      if (
        channel.runtime_status === "functional" &&
        enabled &&
        channelApply.runtime_apply_status === "applied"
      ) {
        setRuntimeConnecting(true)
        try {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const catalog = await getChannelsCatalog()
            const runtimeChannel = catalog.channels.find(
              (item) => item.name === channel.name,
            )
            if (runtimeChannel) {
              setChannel((current) =>
                current?.name === runtimeChannel.name
                  ? { ...current, ...runtimeChannel }
                  : current,
              )
              if (
                runtimeChannel.runtime_connected ||
                runtimeChannel.runtime_error ||
                runtimeChannel.runtime_status !== "functional"
              ) {
                break
              }
            }
            if (attempt < 4) {
              await new Promise<void>((resolve) => window.setTimeout(resolve, 500))
            }
          }
        } catch {
          // Saving already succeeded; a temporary status refresh error must not undo it.
        } finally {
          setRuntimeConnecting(false)
        }
      }
      showSaveSuccessOrRestartToast(
        t,
        t("channels.page.saveSuccess"),
        channelDisplayName,
        channelApply.gateway_restart_required ??
          gateway?.restartRequired === true,
        channelApply.runtime_apply_status,
        channelApply.runtime_apply_error,
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
    if (!channel) return
    setProbing(true)
    setProbeError("")
    try {
      let result: ChannelRuntimeProbeResponse
      if (isDirty) {
        const preparedEditConfig = flushPendingArrayFieldDrafts(editConfig)
        if (preparedEditConfig !== editConfig) setEditConfig(preparedEditConfig)
        result = await probeChannelRuntime(
          channel.name,
          mode,
          buildSavePayload(channel, preparedEditConfig, enabled),
        )
      } else {
        result = await probeChannelRuntime(channel.name, mode)
      }
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
            supportsStreaming={channel?.name === "miki"}
            fieldErrors={fieldErrors}
            registerArrayFieldFlusher={registerArrayFieldFlusher}
            arrayFieldResetVersion={arrayFieldResetVersion}
          />
        )
    }
  }

  return (
    <div className="flex h-full flex-col" data-miki-page="channel-config">
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
                  {t(runtimeStatusTranslationKey(channel.runtime_status))}
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
      >
        <Link
          to="/channels"
          className="text-muted-foreground hover:text-foreground inline-flex h-8 items-center rounded-md px-2 text-xs font-medium transition-colors"
        >
          {t("common.back", { defaultValue: "Back" })}
        </Link>
      </PageHeader>

      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 pb-8 sm:px-6" data-miki-page-body="true">
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
            <ChannelStatusBlock
              channel={channel}
              enabled={enabled}
              onEnabledChange={setEnabled}
              showEnableSwitch={!hidesPageLevelEnableToggle}
              runtimeConnecting={runtimeConnecting}
              probing={probing}
              probeResult={probeResult}
              probeError={probeError}
              onProbe={(mode) => void handleProbe(mode)}
            />

            {channel && channel.runtime_status !== "functional" && (
              <div role="status" className="text-amber-800 dark:text-amber-200 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
                <IconAlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{t("channels.page.messagesNotDelivered", { defaultValue: "Settings are saved; messages are not delivered for this channel yet." })}</span>
              </div>
            )}
            {channel && enabled && ["telegram", "discord", "slack"].includes(channel.name) && !hasAllowedPeers(editConfig.allow_from) && (
              <div role="alert" className="text-amber-800 dark:text-amber-200 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
                <IconAlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{t("channels.page.allowFromWarning", { defaultValue: "allow_from is empty. The channel may appear connected but will ignore every sender until trusted sender IDs are added." })}</span>
              </div>
            )}

            {
              // Every channel form renders its own Credentials / Access /
              // Advanced sections.
              renderForm()
            }

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

            {isDirty && (
              <div className="border-border/60 bg-background sticky bottom-0 flex justify-end gap-2 border-t py-3">
                <Button
                  variant="outline"
                  onClick={handleReset}
                  disabled={saving}
                >
                  {t("common.reset")}
                </Button>
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? t("common.saving") : t("common.save")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export { ChannelConfigPage as ChannelsPage }
