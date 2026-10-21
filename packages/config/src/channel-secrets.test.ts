import { hydrateChannelSecrets, stripChannelSecrets } from "./channel-secrets.js"
import type { SecretVault } from "./secret-vault.js"

function memoryVault(): SecretVault {
  const secrets = new Map<string, string>()
  return {
    get: (key) => secrets.get(key),
    set: (key, value) => { if (value) secrets.set(key, value); else secrets.delete(key) },
    delete: (key) => secrets.delete(key),
    list: () => [...secrets.keys()].sort(),
  }
}

describe("channel secret storage", () => {
  it("moves channel secrets out of config and hydrates them only for runtime use", () => {
    const vault = memoryVault()
    const original = {
      channel_list: {
        telegram: { enabled: true, allow_from: ["42"], settings: { token: "123456:telegram-test-token" } },
        slack: { enabled: true, settings: { bot_token: "xoxb-test", app_token: "xapp-test" } },
      },
    }
    const stripped = stripChannelSecrets(original, vault)
    const serialized = JSON.stringify(stripped.config)
    expect(serialized).not.toContain("telegram-test-token")
    expect(serialized).not.toContain("xoxb-test")
    expect(serialized).not.toContain("xapp-test")
    expect(vault.get("channel/telegram/token")).toBe("123456:telegram-test-token")
    expect(vault.get("channel/slack/bot_token")).toBe("xoxb-test")
    expect(vault.get("channel/slack/app_token")).toBe("xapp-test")

    const runtime = hydrateChannelSecrets(stripped.config, vault)
    expect(runtime.channel_list).toMatchObject({
      telegram: { settings: { token: "123456:telegram-test-token" } },
      slack: { settings: { bot_token: "xoxb-test", app_token: "xapp-test" } },
    })
  })

  it("preserves existing vault entries when a secret form submits a blank or mask", () => {
    const vault = memoryVault()
    stripChannelSecrets({ channel_list: { telegram: { settings: { token: "existing-token" } } } }, vault)
    const result = stripChannelSecrets({ channel_list: { telegram: { settings: { token: "••••••••" } } } }, vault)
    expect(result.config).toEqual({ channel_list: { telegram: {} } })
    expect(vault.get("channel/telegram/token")).toBe("existing-token")
  })

  it("migrates secrets from the legacy channels map without keeping a plaintext copy", () => {
    const vault = memoryVault()
    const result = stripChannelSecrets({ channels: { discord: { token: "discord-test-token" } } }, vault)
    expect(JSON.stringify(result.config)).not.toContain("discord-test-token")
    expect(vault.get("channel/discord/token")).toBe("discord-test-token")
  })
})
