import type { ChannelConfig, SupportedChannel } from "@/api/channels"
import { CHANNEL_CONFIG_METADATA } from "@miki/config/channel-meta"
import {
  normalizeAllowFromValues,
  serializeStringArrayForSubmit,
} from "@/features/channels/components/channel-array-utils"
import {
  SECRET_FIELD_MAP,
  isSecretField,
} from "@/features/channels/components/channel-config-fields"

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function normalizeConfig(
  channel: SupportedChannel,
  rawConfig: ChannelConfig,
): ChannelConfig {
  const config = { ...rawConfig }
  if (channel.name === "whatsapp_native") {
    config.use_native = true
  }
  if (channel.name === "whatsapp") {
    config.use_native = false
  }
  return config
}

function serializeGroupTriggerForSubmit(value: unknown): unknown {
  const groupTrigger = asRecord(value)
  if (Object.keys(groupTrigger).length === 0) {
    return value
  }
  return {
    ...groupTrigger,
    prefixes: serializeStringArrayForSubmit(groupTrigger.prefixes),
  }
}

const CHANNEL_COMMON_CONFIG_KEYS = new Set([
  "allow_from",
  "group_trigger",
  "placeholder",
  "reasoning_channel_id",
  "typing",
])

export function buildSavePayload(
  channel: SupportedChannel,
  editConfig: ChannelConfig,
  enabled: boolean,
): ChannelConfig {
  const payload: ChannelConfig = { enabled, type: channel.config_key }
  const settings: ChannelConfig = {}

  for (const [key, value] of Object.entries(editConfig)) {
    if (key.startsWith("_")) continue
    if (key === "enabled") continue
    if (CHANNEL_COMMON_CONFIG_KEYS.has(key)) {
      if (key === "allow_from") {
        payload[key] = serializeStringArrayForSubmit(
          normalizeAllowFromValues(value),
        )
      } else if (key === "group_trigger") {
        payload[key] = serializeGroupTriggerForSubmit(value)
      } else {
        payload[key] = value
      }
      continue
    }
    if (isSecretField(key)) continue

    settings[key] = serializeStringArrayForSubmit(value)
  }

  for (const [secretKey, editKey] of Object.entries(SECRET_FIELD_MAP)) {
    const incoming = asString(editConfig[editKey])
    if (incoming !== "") {
      settings[secretKey] = incoming
      continue
    }
    const existing = asString(editConfig[secretKey]).trim()
    if (existing !== "") {
      settings[secretKey] = existing
    }
  }

  if (channel.name === "whatsapp_native") {
    settings.use_native = true
  }
  if (channel.name === "whatsapp") {
    settings.use_native = false
  }

  if (Object.keys(settings).length > 0) {
    payload.settings = settings
  }

  return payload
}

export function getRequiredFieldKeys(channelName: string): string[] {
  return [...(CHANNEL_CONFIG_METADATA[channelName]?.requiredFields ?? [])]
}

export function isMissingRequiredValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  if (typeof value === "string") {
    return value.trim() === ""
  }
  if (Array.isArray(value)) {
    return value.length === 0
  }
  return false
}

export function getMissingRequiredFieldKeys(
  channelName: string,
  config: ChannelConfig,
  configuredSecrets: readonly string[],
  enabled: boolean,
): string[] {
  if (!enabled) return []

  return getRequiredFieldKeys(channelName).filter((key) => {
    const editKey = SECRET_FIELD_MAP[key as keyof typeof SECRET_FIELD_MAP]
    if (editKey) {
      const incomingSecret = asString(config[editKey]).trim()
      if (incomingSecret !== "") return false
      if (configuredSecrets.includes(key)) return false
    }
    return isMissingRequiredValue(config[key])
  })
}

export function getChannelFieldValidationError(
  channelName: string,
  field: string,
  value: unknown,
): string | null {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) return null

  if (channelName === "feishu" && field === "app_id") {
    return /^[A-Za-z0-9._-]+$/.test(text)
      ? null
      : "Feishu app_id can only contain letters, numbers, dots, underscores, or hyphens."
  }

  if (channelName === "dingtalk" && field === "webhook_url") {
    try {
      const url = new URL(text)
      return ["http:", "https:"].includes(url.protocol) &&
        url.hostname === "oapi.dingtalk.com" &&
        url.pathname === "/robot/send" &&
        url.searchParams.has("access_token")
        ? null
        : "DingTalk webhook URL must target oapi.dingtalk.com/robot/send with access_token."
    } catch {
      return "DingTalk webhook URL must be a valid HTTP(S) URL."
    }
  }

  if (channelName === "qq" && field === "bot_id") {
    return /^\d{5,20}$/.test(text)
      ? null
      : "QQ bot_id must be a 5-20 digit bot account ID."
  }

  return null
}
