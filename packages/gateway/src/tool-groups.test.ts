import { describe, expect, it } from "@jest/globals"
import { resolveToolGroupKey } from "./tool-groups.js"

describe("resolveToolGroupKey", () => {
  it("accepts config keys and display names", () => {
    expect(resolveToolGroupKey("web_search")).toBe("web_search")
    expect(resolveToolGroupKey("web-search")).toBe("web_search")
    expect(resolveToolGroupKey("agent-control")).toBe("control")
    expect(resolveToolGroupKey("terminal")).toBe("terminal")
    expect(resolveToolGroupKey(" Browser ")).toBe("browser")
  })
  it("rejects unknown groups", () => {
    expect(resolveToolGroupKey("nope")).toBeUndefined()
  })
})
