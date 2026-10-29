import { describe, expect, it } from "vitest"

import type { SupportedChannel } from "@/api/channels"

import {
  filterChannels,
  groupCatalogChannels,
  isLiveChannel,
} from "./channel-catalog"

const channel = (overrides: Partial<SupportedChannel>): SupportedChannel => ({
  name: "x",
  config_key: "x",
  ...overrides,
})

describe("channel catalog grouping", () => {
  const channels = [
    channel({ name: "telegram", runtime_status: "functional", configured: true, runtime_connected: true }),
    channel({ name: "slack", runtime_status: "functional", configured: true, runtime_connected: false }),
    channel({ name: "discord", runtime_status: "functional", configured: false }),
    channel({ name: "line", runtime_status: "partial", configured: true }),
    channel({ name: "whatsapp", runtime_status: "config_only", configured: false }),
  ]

  it("marks only configured and connected functional adapters as live", () => {
    expect(channels.filter(isLiveChannel).map((item) => item.name)).toEqual(["telegram"])
  })

  it("orders groups Live, Needs setup, Partial, Not configured", () => {
    expect(
      groupCatalogChannels(channels).map((group) => [
        group.key,
        group.channels.map((item) => item.name),
      ]),
    ).toEqual([
      ["live", ["telegram"]],
      ["needsSetup", ["slack", "discord"]],
      ["partial", ["line"]],
      ["notConfigured", ["whatsapp"]],
    ])
  })

  it("drops empty groups", () => {
    expect(groupCatalogChannels([channels[0]]).map((group) => group.key)).toEqual(["live"])
  })

  it("never shows a non-functional channel as live even if flagged connected", () => {
    const fake = channel({ name: "line", runtime_status: "partial", configured: true, runtime_connected: true })
    expect(isLiveChannel(fake)).toBe(false)
    expect(groupCatalogChannels([fake])[0].key).toBe("partial")
  })

  it("filters by name, display name and runtime note", () => {
    const list = [
      channel({ name: "telegram", display_name: "Telegram" }),
      channel({ name: "slack", runtime_note: "Socket mode" }),
    ]
    expect(filterChannels(list, "  TELE ").map((item) => item.name)).toEqual(["telegram"])
    expect(filterChannels(list, "socket").map((item) => item.name)).toEqual(["slack"])
    expect(filterChannels(list, "")).toEqual(list)
  })
})
