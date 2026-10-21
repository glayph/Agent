import { publicChannelConfig, splitChannelConfig } from "./channel-config-helpers.js"

describe("channel config secret serialization", () => {
  it("flattens stored settings without leaking secrets through a nested settings object", () => {
    const raw = { enabled: true, allow_from: ["123"], settings: { token: "telegram-secret", other: "visible" } }
    expect(splitChannelConfig(raw).settings).toEqual({ token: "telegram-secret", other: "visible" })
    const serialized = JSON.stringify(publicChannelConfig(raw, "telegram"))
    expect(serialized).not.toContain("telegram-secret")
    expect(serialized).not.toContain('"settings"')
    expect(JSON.parse(serialized)).toMatchObject({
      config: { enabled: true, allow_from: ["123"], other: "visible" },
      configured_secrets: ["token"],
    })
  })

  it("never emits nested secrets when legacy top-level fields and settings coexist", () => {
    const result = publicChannelConfig({ token: "top-secret", settings: { token: "nested-secret", app_token: "app-secret" }, enabled: true }, "slack")
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("top-secret")
    expect(serialized).not.toContain("nested-secret")
    expect(serialized).not.toContain("app-secret")
    expect(result.configured_secrets.sort()).toEqual(["app_token", "token"])
  })

  it("reports a channel as enabled unless it was explicitly disabled", () => {
    expect(publicChannelConfig({ settings: { token: "t" } }, "telegram").config.enabled).toBe(true)
    expect(publicChannelConfig({ enabled: false }, "telegram").config.enabled).toBe(false)
  })
})
