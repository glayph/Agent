import { describe, expect, it } from "vitest"

import { canEditChatInput } from "./chat-composer"

describe("chat composer editability", () => {
  it("keeps the draft editable while the WebSocket is reconnecting or down", () => {
    expect(canEditChatInput("websocketConnecting")).toBe(true)
    expect(canEditChatInput("websocketDisconnected")).toBe(true)
    expect(canEditChatInput("websocketError")).toBe(true)
  })

  it("still blocks drafting while the gateway itself is unavailable", () => {
    expect(canEditChatInput("gatewayStarting")).toBe(false)
    expect(canEditChatInput("gatewayStopped")).toBe(false)
    expect(canEditChatInput("gatewayError")).toBe(false)
  })

  it("allows normal drafting when no disabled reason exists", () => {
    expect(canEditChatInput(null)).toBe(true)
  })
})
