/**
 * Jest mock for @anthropic-ai/sdk.
 * Replaces the real SDK in all unit tests so no actual API calls are made.
 * Tests that need specific responses should call jest.spyOn or override
 * AnthropicMock.prototype.messages.create directly.
 */

/** Minimal stub that mirrors the real Anthropic.Message shape */
const defaultResponse = {
  id: "msg_mock",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "mock response" }],
  model: "claude-sonnet-4-5",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 20 },
};

class AnthropicMock {
  // Expose the create spy so tests can override return values
  messages = {
    create: jest.fn().mockResolvedValue(defaultResponse),
  };

  constructor(_opts?: unknown) {}
}

// Expose error classes so classifyAnthropicError can instanceof-check them
class APIError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "APIError";
    this.status = status;
  }
}
class APIConnectionError extends Error {
  constructor(message = "connection error") {
    super(message);
    this.name = "APIConnectionError";
  }
}
class APIConnectionTimeoutError extends Error {
  constructor(message = "timeout") {
    super(message);
    this.name = "APIConnectionTimeoutError";
  }
}

// Default export mirrors `import Anthropic from "@anthropic-ai/sdk"`
export default AnthropicMock;

// Named exports mirror the real SDK's error classes
export { APIError, APIConnectionError, APIConnectionTimeoutError };
