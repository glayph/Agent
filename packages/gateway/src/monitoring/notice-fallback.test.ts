import { factualNoticeFromEvent } from "./notice-fallback.js"

describe("factualNoticeFromEvent", () => {
  it("lists the event type and its scalar fields without adding any wording", () => {
    expect(factualNoticeFromEvent({ type: "goal_blocked", goal_id: 3, title: "Backup logs", reason: "no write access" }))
      .toBe("[goal_blocked] goal_id=3; title=Backup logs; reason=no write access")
  })
  it("flattens goal lists by title", () => {
    expect(factualNoticeFromEvent({ type: "goal_queued", goals: [{ id: 1, title: "A" }, { id: 2, title: "B" }] })).toBe("[goal_queued] goals=A, B")
  })
  it("returns an empty string when there is no event, and truncates very long values", () => {
    expect(factualNoticeFromEvent(undefined)).toBe("")
    expect(factualNoticeFromEvent({ type: "x", reason: "y".repeat(1000) }).length).toBeLessThanOrEqual(600)
  })
})
