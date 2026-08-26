/**
 * Unit tests for claude-native.ts
 *
 * Covers:
 * (a) plain text response
 * (b) single tool_use response
 * (c) multiple tool_use in one response
 * (d) tool result in the next turn (consecutive merging)
 * (e) multi-turn conversation with mixed roles
 * (f) error class availability check
 * (g) tool schema translation
 * (h) system prompt extraction
 */

import {
  extractSystemPrompt,
  translateMessagesToAnthropic,
  translateToolsToAnthropic,
  translateResponseToLLM,
} from "../../src/providers/claude-native.js";

// ─────────────────────────────────────────────────────────────────────────────
// Local type helpers (mirror Anthropic SDK shapes without importing the real SDK)
// ─────────────────────────────────────────────────────────────────────────────

interface TextBlock {
  type: "text";
  text: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
type ContentBlock = TextBlock | ToolUseBlock;

interface MockAnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

/** Build a minimal Anthropic.Message-shaped fixture */
function makeAnthropicResponse(
  content: ContentBlock[],
  stopReason: MockAnthropicMessage["stop_reason"] = "end_turn",
  inputTokens = 10,
  outputTokens = 20,
): MockAnthropicMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content,
    model: "claude-sonnet-4-5",
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function asAnthropicMessage(
  response: MockAnthropicMessage,
): Parameters<typeof translateResponseToLLM>[0] {
  return response as unknown as Parameters<typeof translateResponseToLLM>[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// extractSystemPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe("extractSystemPrompt", () => {
  it("returns empty string when no system message", () => {
    expect(extractSystemPrompt([{ role: "user", content: "Hello" }])).toBe("");
  });

  it("returns the system message content", () => {
    const msgs = [
      { role: "system" as const, content: "You are Miki." },
      { role: "user" as const, content: "Hi" },
    ];
    expect(extractSystemPrompt(msgs)).toBe("You are Miki.");
  });

  it("joins multiple system messages with double newline", () => {
    const msgs = [
      { role: "system" as const, content: "Part 1" },
      { role: "system" as const, content: "Part 2" },
    ];
    expect(extractSystemPrompt(msgs)).toBe("Part 1\n\nPart 2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) translateToolsToAnthropic
// ─────────────────────────────────────────────────────────────────────────────

describe("translateToolsToAnthropic", () => {
  it("returns undefined for empty/undefined input", () => {
    expect(translateToolsToAnthropic(undefined)).toBeUndefined();
    expect(translateToolsToAnthropic([])).toBeUndefined();
  });

  it("converts OpenAI tool schema to Anthropic format", () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "read_file",
          description: "Reads a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ];
    const result = translateToolsToAnthropic(tools);
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      name: "read_file",
      description: "Reads a file",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    });
  });

  it("handles missing description gracefully", () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "noop",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const result = translateToolsToAnthropic(tools);
    expect(result![0].description).toBe("");
  });

  it("converts multiple tools", () => {
    const tools = [
      {
        type: "function" as const,
        function: { name: "a", parameters: { type: "object", properties: {} } },
      },
      {
        type: "function" as const,
        function: { name: "b", parameters: { type: "object", properties: {} } },
      },
    ];
    expect(translateToolsToAnthropic(tools)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// translateMessagesToAnthropic
// ─────────────────────────────────────────────────────────────────────────────

describe("translateMessagesToAnthropic", () => {
  it("filters out system messages", () => {
    const msgs = [
      { role: "system" as const, content: "system prompt" },
      { role: "user" as const, content: "Hello" },
    ];
    const result = translateMessagesToAnthropic(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("translates a plain user message", () => {
    const msgs = [{ role: "user" as const, content: "What is 2+2?" }];
    const result = translateMessagesToAnthropic(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "What is 2+2?" });
  });

  it("translates an assistant text-only message", () => {
    const msgs = [
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: "Hello!" },
    ];
    const result = translateMessagesToAnthropic(msgs);
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
    });
  });

  it("(b) translates assistant message with a single tool call", () => {
    const msgs = [
      { role: "user" as const, content: "Read config.yaml" },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_001",
            type: "function" as const,
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "config.yaml" }),
            },
          },
        ],
      },
    ];
    const result = translateMessagesToAnthropic(msgs);
    const assistantMsg = result[1];
    expect(assistantMsg.role).toBe("assistant");
    const content = assistantMsg.content as Array<{
      type: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
    // Empty text is skipped, only tool_use block
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("tool_use");
    expect(content[0].id).toBe("call_001");
    expect(content[0].name).toBe("read_file");
    expect(content[0].input).toEqual({ path: "config.yaml" });
  });

  it("(c) translates assistant message with multiple tool calls", () => {
    const msgs = [
      { role: "user" as const, content: "Do two things" },
      {
        role: "assistant" as const,
        content: "Sure",
        tool_calls: [
          {
            id: "call_001",
            type: "function" as const,
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "a.txt" }),
            },
          },
          {
            id: "call_002",
            type: "function" as const,
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "b.txt", content: "hi" }),
            },
          },
        ],
      },
    ];
    const result = translateMessagesToAnthropic(msgs);
    const content = result[1].content as Array<{ type: string; id?: string }>;
    // text "Sure" + 2 tool_use blocks
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "text", text: "Sure" });
    expect(content[1].type).toBe("tool_use");
    expect(content[2].type).toBe("tool_use");
    expect(content[1].id).toBe("call_001");
    expect(content[2].id).toBe("call_002");
  });

  it("(d) merges consecutive tool result messages into one user message", () => {
    const msgs = [
      { role: "user" as const, content: "Do two things" },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_001",
            type: "function" as const,
            function: { name: "read_file", arguments: "{}" },
          },
          {
            id: "call_002",
            type: "function" as const,
            function: { name: "write_file", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "call_001",
        content: "file content here",
      },
      { role: "tool" as const, tool_call_id: "call_002", content: "write ok" },
    ];
    const result = translateMessagesToAnthropic(msgs);

    // user, assistant, user(merged tool results) = 3 messages
    expect(result).toHaveLength(3);
    const mergedUser = result[2];
    expect(mergedUser.role).toBe("user");
    const blocks = mergedUser.content as Array<{
      type: string;
      tool_use_id?: string;
      content?: string;
    }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[1].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("call_001");
    expect(blocks[0].content).toBe("file content here");
    expect(blocks[1].tool_use_id).toBe("call_002");
    expect(blocks[1].content).toBe("write ok");
  });

  it("(e) handles a full multi-turn conversation with mixed roles", () => {
    const msgs = [
      { role: "system" as const, content: "You are Miki." },
      { role: "user" as const, content: "What files are here?" },
      {
        role: "assistant" as const,
        content: "Let me check.",
        tool_calls: [
          {
            id: "call_001",
            type: "function" as const,
            function: { name: "list_files", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "call_001",
        content: "config.yaml, readme.md",
      },
      { role: "assistant" as const, content: "Found 2 files." },
      { role: "user" as const, content: "Thanks" },
    ];

    const result = translateMessagesToAnthropic(msgs);
    // system filtered → user, assistant(tool_use), user(tool_result), assistant(text), user = 5
    expect(result).toHaveLength(5);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user"); // merged tool result
    expect(result[3].role).toBe("assistant");
    expect(result[4].role).toBe("user");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// translateResponseToLLM
// ─────────────────────────────────────────────────────────────────────────────

describe("translateResponseToLLM", () => {
  it("(a) translates a plain text response", () => {
    const response = makeAnthropicResponse(
      [{ type: "text", text: "Hello, I am Miki!" }],
      "end_turn",
      5,
      15,
    );
    const result = translateResponseToLLM(asAnthropicMessage(response));

    expect(result.choices).toHaveLength(1);
    const msg = result.choices![0].message;
    expect(msg?.content).toBe("Hello, I am Miki!");
    expect(msg?.tool_calls).toBeUndefined();
    expect(result.choices![0].finish_reason).toBe("stop");
    expect(result.usage?.prompt_tokens).toBe(5);
    expect(result.usage?.completion_tokens).toBe(15);
    expect(result.usage?.total_tokens).toBe(20);
  });

  it("(b) translates a single tool_use response", () => {
    const response = makeAnthropicResponse(
      [
        {
          type: "tool_use",
          id: "toolu_01",
          name: "read_file",
          input: { path: "config.yaml" },
        },
      ],
      "tool_use",
    );
    const result = translateResponseToLLM(asAnthropicMessage(response));

    const msg = result.choices![0].message;
    expect(msg?.content).toBeNull();
    expect(msg?.tool_calls).toHaveLength(1);
    const tc = msg!.tool_calls![0];
    expect(tc.id).toBe("toolu_01");
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("read_file");
    // arguments MUST be a JSON string — not an object
    expect(typeof tc.function.arguments).toBe("string");
    expect(JSON.parse(tc.function.arguments)).toEqual({ path: "config.yaml" });
    expect(result.choices![0].finish_reason).toBe("tool_calls");
  });

  it("(c) translates multiple tool_use blocks in one response", () => {
    const response = makeAnthropicResponse(
      [
        {
          type: "tool_use",
          id: "toolu_01",
          name: "read_file",
          input: { path: "a.txt" },
        },
        {
          type: "tool_use",
          id: "toolu_02",
          name: "write_file",
          input: { path: "b.txt", content: "hello" },
        },
      ],
      "tool_use",
    );
    const result = translateResponseToLLM(asAnthropicMessage(response));

    const tc = result.choices![0].message?.tool_calls;
    expect(tc).toHaveLength(2);
    expect(tc![0].id).toBe("toolu_01");
    expect(tc![1].id).toBe("toolu_02");
    expect(JSON.parse(tc![0].function.arguments)).toEqual({ path: "a.txt" });
    expect(JSON.parse(tc![1].function.arguments)).toEqual({
      path: "b.txt",
      content: "hello",
    });
  });

  it("maps stop_reason=max_tokens to finish_reason=length", () => {
    const response = makeAnthropicResponse(
      [{ type: "text", text: "Truncated..." }],
      "max_tokens",
    );
    expect(
      translateResponseToLLM(asAnthropicMessage(response)).choices![0]
        .finish_reason,
    ).toBe("length");
  });

  it("maps stop_reason=tool_use to finish_reason=tool_calls", () => {
    const response = makeAnthropicResponse(
      [{ type: "tool_use", id: "t", name: "fn", input: {} }],
      "tool_use",
    );
    expect(
      translateResponseToLLM(asAnthropicMessage(response)).choices![0]
        .finish_reason,
    ).toBe("tool_calls");
  });

  it("concatenates multiple text blocks into a single string", () => {
    const response = makeAnthropicResponse([
      { type: "text", text: "Hello " },
      { type: "text", text: "World" },
    ]);
    expect(
      translateResponseToLLM(asAnthropicMessage(response)).choices![0].message
        ?.content,
    ).toBe("Hello World");
  });

  it("includes both text content and tool_calls for mixed-block response", () => {
    const response = makeAnthropicResponse(
      [
        { type: "text", text: "Let me do that." },
        {
          type: "tool_use",
          id: "toolu_03",
          name: "shell_exec",
          input: { cmd: "ls" },
        },
      ],
      "tool_use",
    );
    const msg = translateResponseToLLM(asAnthropicMessage(response)).choices![0]
      .message;
    expect(msg?.content).toBe("Let me do that.");
    expect(msg?.tool_calls).toHaveLength(1);
    expect(msg?.tool_calls![0].function.name).toBe("shell_exec");
  });

  it("returns correct token usage totals", () => {
    const response = makeAnthropicResponse(
      [{ type: "text", text: "Hi" }],
      "end_turn",
      100,
      50,
    );
    const usage = translateResponseToLLM(asAnthropicMessage(response)).usage;
    expect(usage?.prompt_tokens).toBe(100);
    expect(usage?.completion_tokens).toBe(50);
    expect(usage?.total_tokens).toBe(150);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) Error class availability
// ─────────────────────────────────────────────────────────────────────────────

describe("LLM error classes (f)", () => {
  it("error classes are exported from llm.ts", async () => {
    const mod = await import("../../src/llm.js");
    expect(typeof mod.LLMRateLimitError).toBe("function");
    expect(typeof mod.LLMTimeoutError).toBe("function");
    expect(typeof mod.LLMAPIError).toBe("function");
    expect(typeof mod.LLMMissingCredentialError).toBe("function");
  });

  it("LLMRateLimitError is instanceof LLMProviderError", async () => {
    const { LLMRateLimitError, LLMProviderError } =
      await import("../../src/llm.js");
    const err = new LLMRateLimitError("rate limited");
    expect(err).toBeInstanceOf(LLMProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LLMRateLimitError");
  });

  it("LLMMissingCredentialError has correct name", async () => {
    const { LLMMissingCredentialError } = await import("../../src/llm.js");
    const err = new LLMMissingCredentialError("no key");
    expect(err.name).toBe("LLMMissingCredentialError");
    expect(err.message).toBe("no key");
  });
});
