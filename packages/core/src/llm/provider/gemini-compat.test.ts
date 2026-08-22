import { normalizeGeminiExtra } from "./gemini-compat.js";

describe("normalizeGeminiExtra", () => {
  it("removes OpenAI-only automatic tool_choice while preserving tools", () => {
    const result = normalizeGeminiExtra({
      tools: [
        {
          type: "function",
          function: {
            name: "write_file",
            description: "Write a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 256,
    });

    expect(result.tool_choice).toBeUndefined();
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.max_tokens).toBe(256);
  });
});
