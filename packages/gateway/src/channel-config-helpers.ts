import { CHANNEL_SECRET_FIELD_KEYS } from "@miki/config/channel-meta"

type PlainRecord = Record<string, unknown>
const SECRET_FIELDS = new Set<string>(CHANNEL_SECRET_FIELD_KEYS)
const isRecord = (value: unknown): value is PlainRecord => Boolean(value && typeof value === "object" && !Array.isArray(value))
const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : ""

/** Flatten a channel config for server-side consumers without keeping a nested raw `settings` object. */
export function splitChannelConfig(raw: PlainRecord): { common: PlainRecord; settings: PlainRecord } {
  const common: PlainRecord = {}
  const settings: PlainRecord = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === "settings") continue
    if (["enabled", "type", "allow_from", "group_trigger", "placeholder", "reasoning_channel_id", "typing"].includes(key)) common[key] = value
    else settings[key] = value
  }
  if (isRecord(raw.settings)) Object.assign(settings, raw.settings)
  return { common, settings }
}

/** API serializer: reports which secrets exist but never returns their values, even nested. */
export function publicChannelConfig(raw: PlainRecord, channelName: string): { config: PlainRecord; configured_secrets: string[] } {
  const { common, settings } = splitChannelConfig(raw)
  const configuredSecrets = Object.keys(settings).filter((key) => SECRET_FIELDS.has(key) && Boolean(stringValue(settings[key])))
  const safeSettings = Object.fromEntries(Object.entries(settings).filter(([key]) => !SECRET_FIELDS.has(key)))
  return {
    config: {
      ...common,
      ...safeSettings,
      // Active by default; only an explicit `enabled: false` turns a channel off.
      enabled: raw.enabled !== false,
      type: raw.type ?? channelName,
    },
    configured_secrets: configuredSecrets,
  }
}
