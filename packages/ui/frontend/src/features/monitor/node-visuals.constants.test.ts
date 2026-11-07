import { describe, expect, it } from "vitest"

import { monitorNodeMotionTarget } from "./node-visuals.constants"

describe("monitor node visibility", () => {
  it.each(["completed", "failed"] as const)(
    "keeps %s cards visible while the run remains on the canvas",
    (status) => {
      expect(monitorNodeMotionTarget(status, "#FFB45C")).toMatchObject({
        opacity: 1,
        scale: 1,
      })
    },
  )

  it("retains the active-node glow", () => {
    expect(
      monitorNodeMotionTarget("running", "#FFB45C").boxShadow,
    ).toContain("#FFB45C")
  })
})
