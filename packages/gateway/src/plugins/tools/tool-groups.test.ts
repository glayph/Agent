import { describe, expect, it } from "@jest/globals"
import { resolveToolGroupEnabled, resolveToolGroupKey } from "./tool-groups.js"

describe("resolveToolGroupKey", () => {
  it("accepts config keys and display names", () => {
    expect(resolveToolGroupKey("web_search")).toBe("web_search")
    expect(resolveToolGroupKey("web-search")).toBe("web_search")
    expect(resolveToolGroupKey("agent-control")).toBe("control")
    expect(resolveToolGroupKey("models")).toBe("models")
    expect(resolveToolGroupKey("model-management")).toBe("models")
    expect(resolveToolGroupKey("terminal")).toBe("terminal")
    expect(resolveToolGroupKey(" Browser ")).toBe("browser")
    expect(resolveToolGroupKey("computer")).toBe("computer")
    expect(resolveToolGroupKey("computer-use")).toBe("computer")
    expect(resolveToolGroupKey("installed-plugins")).toBe("plugins")
    expect(resolveToolGroupKey("external-mcp")).toBe("mcp")
  })
  it("rejects unknown groups", () => {
    expect(resolveToolGroupKey("nope")).toBeUndefined()
  })
})


describe("resolveToolGroupEnabled", () => {
  it("keeps an explicitly disabled group disabled regardless of approval mode", () => {
    // Approval/no-confirm settings are deliberately not an input to this resolver.
    expect(resolveToolGroupEnabled(false, true)).toBe(false);
  });

  it("uses the configured default when no explicit state exists", () => {
    expect(resolveToolGroupEnabled(undefined, true)).toBe(true);
    expect(resolveToolGroupEnabled(undefined, false)).toBe(false);
  });

  it("applies hard policy as an additional deny-only gate", () => {
    expect(resolveToolGroupEnabled(true, true, false)).toBe(false);
    expect(resolveToolGroupEnabled(false, true, true)).toBe(false);
    expect(resolveToolGroupEnabled(true, true, true)).toBe(true);
  });
});
