import { CHANNEL_CONFIG_METADATA } from "./channel-meta.js"
import type { SecretVault } from "./secret-vault.js"

type PlainRecord = Record<string, unknown>
const SECRET_MASKS = new Set(["••••••••", "[REDACTED]"])
const isRecord = (value: unknown): value is PlainRecord => Boolean(value && typeof value === "object" && !Array.isArray(value))

export const channelSecretRef = (channel: string, field: string): string => `channel/${channel}/${field}`

export interface StripChannelSecretsResult {
  config: PlainRecord
  changed: boolean
  foundSecret: boolean
}

/** Store plaintext channel credentials in the encrypted vault and return a credential-free config. */
export function stripChannelSecrets(input: PlainRecord, vault: Pick<SecretVault, "set">): StripChannelSecretsResult {
  const config = JSON.parse(JSON.stringify(input)) as PlainRecord
  let changed = false
  let foundSecret = false
  // Read both maps because this also runs while migrating older configuration.
  for (const mapName of ["channel_list", "channels"]) {
    const channels = isRecord(config[mapName]) ? config[mapName] as PlainRecord : undefined
    if (!channels) continue
    for (const [channel, rawValue] of Object.entries(channels)) {
      if (!isRecord(rawValue)) continue
      const raw = rawValue
      const settings = isRecord(raw.settings) ? raw.settings : undefined
      const fields = CHANNEL_CONFIG_METADATA[channel]?.secretFields ?? []
      for (const field of fields) {
        const candidates = [settings?.[field], raw[field]]
        const supplied = candidates.find((value) => typeof value === "string" && value.trim() !== "" && !SECRET_MASKS.has(value.trim()))
        if (typeof supplied === "string") {
          // A vault write failure throws; callers must not persist this config.
          vault.set(channelSecretRef(channel, field), supplied)
          foundSecret = true
        }
        if (settings && Object.prototype.hasOwnProperty.call(settings, field)) { delete settings[field]; changed = true }
        if (Object.prototype.hasOwnProperty.call(raw, field)) { delete raw[field]; changed = true }
      }
      if (settings && Object.keys(settings).length === 0) { delete raw.settings; changed = true }
    }
  }
  return { config, changed, foundSecret }
}

/** Hydrate channel secrets for trusted server-side runtime consumers only. */
export function hydrateChannelSecrets(input: PlainRecord, vault: Pick<SecretVault, "get">): PlainRecord {
  const config = JSON.parse(JSON.stringify(input)) as PlainRecord
  const channels = isRecord(config.channel_list) ? config.channel_list : {}
  for (const [channel, rawValue] of Object.entries(channels)) {
    if (!isRecord(rawValue)) continue
    const raw = rawValue
    const settings = isRecord(raw.settings) ? { ...raw.settings } : {}
    for (const field of CHANNEL_CONFIG_METADATA[channel]?.secretFields ?? []) {
      const secret = vault.get(channelSecretRef(channel, field))
      if (secret) settings[field] = secret
      else delete settings[field]
      delete raw[field]
    }
    if (Object.keys(settings).length > 0) raw.settings = settings
    else delete raw.settings
  }
  return config
}
