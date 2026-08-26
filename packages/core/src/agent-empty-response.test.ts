import { describe, expect, it } from "vitest";
import { buildEmptyModelResponse } from "./agent.js";

describe("buildEmptyModelResponse", () => {
  it("returns a visible, actionable reply for an empty provider response", () => {
    const message = buildEmptyModelResponse("openai/gpt-4o");

    expect(message).toContain("openai/gpt-4o");
    expect(message).toContain("empty response");
    expect(message).toContain("retry");
    expect(message.trim()).not.toHaveLength(0);
  });

  it("uses a safe label when the model name is blank", () => {
    expect(buildEmptyModelResponse("   ")).toContain("the selected model");
  });
});
