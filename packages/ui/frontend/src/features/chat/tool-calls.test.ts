import { describe, expect, it } from "vitest"

import {
  parseToolCallsValue,
  splitDuration,
  summarizeToolCalls,
  toolCallsSignature,
} from "./tool-calls"

describe("tool call status and duration", () => {
  it("parses status and duration_ms only when the gateway sent valid ones", () => {
    const parsed = parseToolCallsValue([
      { id: "a", function: { name: "x" }, status: "success", duration_ms: 1500 },
      { id: "b", function: { name: "y" }, status: "bogus", duration_ms: -1 },
      { id: "c", function: { name: "z" } },
    ])
    expect(parsed?.[0]).toMatchObject({ status: "success", durationMs: 1500 })
    expect(parsed?.[1]?.status).toBeUndefined()
    expect(parsed?.[1]?.durationMs).toBeUndefined()
    expect(parsed?.[2]?.status).toBeUndefined()
    expect(parsed?.[2]?.durationMs).toBeUndefined()
  })

  it("changes the signature when status or duration changes", () => {
    const running = [{ id: "a", status: "running" as const }]
    const done = [{ id: "a", status: "success" as const, durationMs: 10 }]
    expect(toolCallsSignature(running)).not.toBe(toolCallsSignature(done))
  })

  it("flags failures and totals durations only when every call has one", () => {
    const summary = summarizeToolCalls([
      { id: "a", status: "success", durationMs: 200 },
      { id: "b", status: "error", durationMs: 300 },
    ])
    expect(summary).toMatchObject({ count: 2, failed: 1, running: 0, allSucceeded: false, totalDurationMs: 500 })

    const partial = summarizeToolCalls([
      { id: "a", status: "success", durationMs: 200 },
      { id: "b", status: "success" },
    ])
    expect(partial.totalDurationMs).toBeUndefined()
    expect(partial.allSucceeded).toBe(true)
  })

  it("invents nothing when the data is absent", () => {
    const summary = summarizeToolCalls([{ id: "a" }, { id: "b" }])
    expect(summary.hasStatus).toBe(false)
    expect(summary.totalDurationMs).toBeUndefined()
    expect(summary.allSucceeded).toBe(false)
  })

  it("splits durations into display units", () => {
    expect(splitDuration(420)).toEqual({ unit: "ms", value: 420 })
    expect(splitDuration(1250)).toEqual({ unit: "s", value: "1.3" })
    expect(splitDuration(65_000)).toEqual({ unit: "m", minutes: 1, seconds: 5 })
  })
})
