import { parseControlIntent } from "./intent.js";

describe("parseControlIntent", () => {
  it("parses capability inspection", () => {
    const result = parseControlIntent("show available agent capabilities");
    expect(result.matched).toBe(true);
    expect(result.request).toEqual(
      expect.objectContaining({ capability: "capabilities", action: "list" }),
    );
  });

  it("parses a safe tool toggle", () => {
    const result = parseControlIntent("disable the web_search tool");
    expect(result.request).toEqual(
      expect.objectContaining({ capability: "tool_state", action: "set" }),
    );
    expect(result.request?.input).toEqual({
      name: "web_search",
      enabled: false,
    });
  });

  it("parses a resource profile change", () => {
    const result = parseControlIntent("change agent mode to eco");
    expect(result.request?.input).toEqual({
      patch: { agent: { resource: { mode: "eco" } } },
    });
  });

  it("does not guess ambiguous requests", () => {
    expect(
      parseControlIntent("install a model and configure everything").matched,
    ).toBe(false);
  });
});
