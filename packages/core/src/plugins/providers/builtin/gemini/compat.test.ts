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

  it("preserves the assistant function call, thought signature, and paired tool result", () => {
    const messages = [
      { role: "user" as const, content: "Create a page." },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "file_write", arguments: '{"path":"index.html"}' },
            extra_content: { google: { thought_signature: "signature-123" } },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "call-1",
        name: "file_write",
        content: "File written",
      },
    ];

    expect(normalizeGeminiMessages(messages)).toEqual(messages);
  });

  it("preserves provider metadata attached to the assistant message", () => {
    const message = {
      role: "assistant" as const,
      content: "continuing",
      extra_content: { google: { thought_signature: "message-signature" } },
    };
    expect(normalizeGeminiMessages([message])).toEqual([message]);
  });
});
