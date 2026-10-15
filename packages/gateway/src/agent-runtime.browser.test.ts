import { describe, expect, it } from "@jest/globals"
import { ToolRegistry } from "@miki/core/engine"

describe("browser tool contracts", () => {
  it("keeps external browser navigation and interaction approval-gated", () => {
    const navigation = { name: "browser_navigate", risk: "write", approval: "required" as const }
    const click = { name: "browser_click", risk: "write", approval: "required" as const }
    const extract = { name: "browser_extract", risk: "read", approval: "auto" as const }
    expect(ToolRegistry.needsApproval(navigation as never)).toBe(true)
    expect(ToolRegistry.needsApproval(click as never)).toBe(true)
    expect(ToolRegistry.needsApproval(extract as never)).toBe(false)
  })
})
