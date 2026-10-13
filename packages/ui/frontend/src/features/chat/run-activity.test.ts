import { describe, expect, it } from "vitest"

import { describeRunActivity, formatElapsed } from "./run-activity"
import type { RunActivity } from "@/store/chat"

const activity = (patch: Partial<RunActivity>): RunActivity => ({
  runId: "r1",
  elapsedSeconds: 0,
  idleSeconds: 0,
  activity: "model",
  activitySeconds: 0,
  turn: 1,
  receivedAt: 0,
  ...patch,
})

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(9)).toBe("9s")
    expect(formatElapsed(125)).toBe("2m 05s")
    expect(formatElapsed(3780)).toBe("1h 03m")
    expect(formatElapsed(-4)).toBe("0s")
  })
})

describe("describeRunActivity", () => {
  it("is calm while the model is answering normally", () => {
    expect(describeRunActivity(activity({}), 20)).toEqual({ text: "Waiting for the model", slow: false })
  })
  it("calls out a slow model with the quiet time and the Stop option", () => {
    const result = describeRunActivity(activity({}), 95)
    expect(result.slow).toBe(true)
    expect(result.text).toContain("1m 35s")
    expect(result.text).toContain("Stop")
  })
  it("never calls a running command slow, and says it is not stopped automatically", () => {
    const result = describeRunActivity(activity({ activity: "tool", label: "terminal_run" }), 600)
    expect(result.slow).toBe(false)
    expect(result.text).toContain("never stopped automatically")
  })
  it("names other tools, approvals and writing", () => {
    expect(describeRunActivity(activity({ activity: "tool", label: "web_search" }), 3).text).toBe("Using web_search")
    expect(describeRunActivity(activity({ activity: "approval", label: "file_write" }), 3).text).toBe("Waiting for your approval")
    expect(describeRunActivity(activity({ activity: "writing" }), 3).text).toBe("Writing the answer")
  })
})
