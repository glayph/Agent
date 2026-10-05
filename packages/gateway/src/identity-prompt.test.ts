import { describe, expect, it } from "@jest/globals"
import { buildIdentityContext } from "./identity-prompt.js"

describe("buildIdentityContext", () => {
  it("declares the agent identity and the live capabilities", () => {
    const text = buildIdentityContext({ groups: [{ key: "terminal", enabled: true }, { key: "browser", enabled: true }, { key: "web_search", enabled: false }] })
    expect(text).toMatch(/autonomous AI agent/)
    expect(text).toMatch(/terminal_run/)
    expect(text).toMatch(/browser_\*/)
    expect(text).toMatch(/CURRENTLY OFF[^\n]*web_search/)
  })
  it("includes the configured persona", () => {
    expect(buildIdentityContext({ groups: [], persona: "Speak Bengali." })).toMatch(/Speak Bengali\./)
  })
})
