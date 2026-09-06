import { normalizeGeminiExtra, normalizeGeminiMessages } from "./compat.js";

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

  it("converts tool continuations into provider-safe execution summaries", () => {
    const normalized = normalizeGeminiMessages([
      { role: "user", content: "Create a page." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "file_write",
              arguments: '{"path":"index.html"}',
            },
            extra_content: { internal_signature: "do-not-send" },
          },
        ],
        extra_content: { provider_private: true },
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "file_write",
        content: "File written",
      },
    ]);

    expect(normalized).toEqual([
      { role: "user", content: "Create a page." },
      {
        role: "assistant",
        content: "The requested tool operation was executed.",
      },
      {
        role: "user",
        content: "Tool result (file_write): File written",
      },
    ]);
  });
});
