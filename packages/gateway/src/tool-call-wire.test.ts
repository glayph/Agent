import { wireToolCallExtras, wireToolStatus } from "./tool-call-wire.js"

describe("tool call wire format", () => {
  it("collapses engine states to running | success | error", () => {
    expect(["requested", "awaiting_approval", "running"].map(wireToolStatus)).toEqual(["running", "running", "running"])
    expect(wireToolStatus("succeeded")).toBe("success")
    expect(["failed", "denied", "blocked", "cancelled"].map(wireToolStatus)).toEqual(["error", "error", "error", "error"])
  })

  it("leaves unknown states out instead of guessing", () => {
    expect(wireToolStatus("mystery")).toBeUndefined()
    expect(wireToolCallExtras({ status: "mystery" })).toEqual({})
  })

  it("forwards a real duration and omits missing or invalid ones", () => {
    expect(wireToolCallExtras({ status: "succeeded", durationMs: 1234.6 })).toEqual({ status: "success", duration_ms: 1235 })
    expect(wireToolCallExtras({ status: "running" })).toEqual({ status: "running" })
    expect(wireToolCallExtras({ status: "failed", durationMs: Number.NaN })).toEqual({ status: "error" })
    expect(wireToolCallExtras({ status: "failed", durationMs: -5 })).toEqual({ status: "error" })
  })
})
