import { describe, expect, it } from "vitest"

import { buildStatusPills } from "./chat-page"

const labels = {
  activeAgents: (count: number) => `${count} active agents`,
  paused: "Paused",
  ready: "Ready",
  running: "Running",
}

describe("Chat workspace status pills", () => {
  it("reports Ready and zero active agents when online and idle", () => {
    expect(
      buildStatusPills({
        connectionState: "connected",
        gatewayState: "running",
        isTyping: false,
        labels,
      }),
    ).toEqual([
      { label: "Ready", tone: "neutral" },
      { label: "0 active agents", tone: "neutral" },
    ])
  })

  it("reports Running and one active agent during a response", () => {
    expect(
      buildStatusPills({
        connectionState: "connected",
        gatewayState: "running",
        isTyping: true,
        labels,
      }),
    ).toEqual([
      { label: "Running", tone: "success" },
      { label: "1 active agents", tone: "info" },
    ])
  })

  it("reports paused warning and zero active agents when unavailable", () => {
    expect(
      buildStatusPills({
        connectionState: "disconnected",
        gatewayState: "stopped",
        isTyping: false,
        labels,
      }),
    ).toEqual([
      { label: "Paused", tone: "warning" },
      { label: "0 active agents", tone: "neutral" },
    ])
  })
})
