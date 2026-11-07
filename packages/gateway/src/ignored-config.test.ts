import { findIgnoredConfigKeys, heartbeatLaneModel } from "./ignored-config.js"

describe("ignored config keys", () => {
  it("reports only keys that are present and unused", () => {
    const config = {
      concurrency: { maxConcurrentTasks: 8 },
      agent: { model_router: { lanes: { default: { primary: "a", fallbacks: ["b"] }, complex: { primary: "c" }, heartbeat: { primary: "d" } } } },
      autonomy: { tool_policy: { max_retries: 2 } },
    }
    expect(findIgnoredConfigKeys(config).sort()).toEqual([
      "autonomy.tool_policy.max_retries",
    ])
  })

  it("reports nothing for an empty config", () => {
    expect(findIgnoredConfigKeys({})).toEqual([])
    expect(findIgnoredConfigKeys(undefined)).toEqual([])
  })

  it("consumes heartbeat lane configuration unless the router is disabled", () => {
    const lane = { lanes: { heartbeat: { primary: " gemini/x " } } }
    expect(heartbeatLaneModel({ agent: { model_router: { enabled: true, ...lane } } })).toBe("gemini/x")
    expect(heartbeatLaneModel({ agent: { model_router: { enabled: false, ...lane } } })).toBeUndefined()
    expect(heartbeatLaneModel({})).toBeUndefined()
  })

  it("does not classify consumed model-router settings as ignored", () => {
    expect(findIgnoredConfigKeys({ agent: { model_router: {
      lanes: { default: { primary: "openai/main", fallbacks: ["gemini/flash"] }, complex: "openai/pro", heartbeat: "gemini/flash" },
      roles: { forge: "complex" }, credential_profiles: { openai: ["OPENAI_API_KEY_BACKUP"] },
    } } })).toEqual([])
  })
})
