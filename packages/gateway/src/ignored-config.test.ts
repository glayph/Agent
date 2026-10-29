import { findIgnoredConfigKeys, heartbeatLaneModel } from "./ignored-config.js"

describe("ignored config keys", () => {
  it("reports only keys that are present and unused", () => {
    const config = {
      concurrency: { maxConcurrentTasks: 8, retryBaseDelayMs: 60000 },
      agent: { model_router: { lanes: { default: { primary: "a", fallbacks: ["b"] }, complex: { primary: "c" }, heartbeat: { primary: "d" } } } },
      autonomy: { tool_policy: { max_retries: 2 } },
    }
    expect(findIgnoredConfigKeys(config).sort()).toEqual([
      "agent.model_router.lanes.complex",
      "agent.model_router.lanes.default.primary",
      "autonomy.tool_policy.max_retries",
      "concurrency.retryBaseDelayMs",
    ])
  })

  it("reports nothing for an empty config", () => {
    expect(findIgnoredConfigKeys({})).toEqual([])
    expect(findIgnoredConfigKeys(undefined)).toEqual([])
  })

  it("reads the heartbeat lane model unless the router is disabled", () => {
    const lane = { lanes: { heartbeat: { primary: " gemini/x " } } }
    expect(heartbeatLaneModel({ agent: { model_router: { enabled: true, ...lane } } })).toBe("gemini/x")
    expect(heartbeatLaneModel({ agent: { model_router: { enabled: false, ...lane } } })).toBeUndefined()
    expect(heartbeatLaneModel({})).toBeUndefined()
  })
})
