import type { ChannelConfig } from "@/api/channels"
import { CHANNEL_CONFIG_METADATA, CHANNEL_SECRET_FIELD_MAP } from "@miki/config/channel-meta"

export const SECRET_FIELD_MAP = CHANNEL_SECRET_FIELD_MAP

const CHANNEL_SECRET_FIELDS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(CHANNEL_CONFIG_METADATA).map(([name, meta]) => [name, meta.secretFields]),
)

const SECRET_FIELD_SET = new Set(Object.keys(SECRET_FIELD_MAP))

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function isSecretField(key: string): boolean {
  return SECRET_FIELD_SET.has(key)
}

export function buildEditConfig(
  channelName: string,
  config: ChannelConfig,
  /** Saved credentials (authenticated owner view) to show again in the secret inputs. */
  secretValues: Readonly<Record<string, string>> = {},
): ChannelConfig {
  const edit: ChannelConfig = { ...config }

  for (const key of CHANNEL_SECRET_FIELDS[channelName] ?? []) {
    if (!(key in edit)) {
      edit[key] = ""
    }
    const editKey = SECRET_FIELD_MAP[key as keyof typeof SECRET_FIELD_MAP]
    if (editKey) {
      edit[editKey] = secretValues[key] ?? ""
    }
  }

  return edit
}

export function hasConfiguredSecret(
  configuredSecrets: readonly string[],
  key: string,
): boolean {
  return configuredSecrets.includes(key)
}

export function getFieldValueForValidation(
  config: ChannelConfig,
  configuredSecrets: readonly string[],
  key: string,
): unknown {
  const editKey = SECRET_FIELD_MAP[key as keyof typeof SECRET_FIELD_MAP]
  if (editKey) {
    const incoming = asString(config[editKey]).trim()
    if (incoming !== "") {
      return incoming
    }
    if (hasConfiguredSecret(configuredSecrets, key)) {
      return true
    }
  }
  return config[key]
}

export function getSecretInputPlaceholder(
  configuredSecrets: readonly string[],
  key: string,
  configuredPlaceholder: string,
  fallback = "",
): string {
  return hasConfiguredSecret(configuredSecrets, key)
    ? configuredPlaceholder
    : fallback
}
