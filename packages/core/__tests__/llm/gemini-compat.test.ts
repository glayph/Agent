import {
  normalizeGeminiExtra,
  normalizeGeminiSchema,
  normalizeGeminiTools,
} from "../../src/llm/provider/gemini-compat.js";

describe("Gemini OpenAI compatibility", () => {
  it("rewrites oneOf into a supported schema branch", () => {
    const result = normalizeGeminiSchema({
      type: "object",
      properties: {
        keys: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description: "A shortcut or key array",
        },
      },
      required: [],
    });

    expect(result).toEqual({
      type: "object",
      properties: {
        keys: { type: "string", description: "A shortcut or key array" },
      },
    });
  });

  it("preserves tool names and strips local-only metadata", () => {
    const result = normalizeGeminiTools([
      {
        type: "function",
        risk: { level: "high", label: "local", reason: "not for provider" },
        function: {
          name: "file_write",
          description: "Write a file",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ]);

    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "file_write",
          description: "Write a file",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("normalizes only tools and removes undefined payload fields", () => {
    const result = normalizeGeminiExtra({
      tools: [
        {
          function: {
            name: "shell_execute",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: undefined,
    });

    expect(result.tool_choice).toBe("auto");
    expect(result.max_tokens).toBeUndefined();
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "shell_execute",
          description: "",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });
});
