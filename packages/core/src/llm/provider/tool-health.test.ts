import {
  AGENT_READINESS_TOOL_NAME,
  probeProviderTools,
} from "./tool-health.js";
import { LLMRateLimitError } from "./errors.js";
import type { OpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import type { DirectProviderConfig } from "./catalog.js";

const provider: DirectProviderConfig = {
  id: "opencode",
  displayName: "OpenCode Zen",
  baseUrl: "https://opencode.example/v1",
  apiKeyEnv: "OPENCODE_API_KEY",
  emptyApiKeyAllowed: false,
};

function adapterWith(...responses: unknown[]) {
  const complete = jest.fn();
  for (const response of responses) {
    if (response instanceof Error) complete.mockRejectedValueOnce(response);
    else complete.mockResolvedValueOnce(response);
  }
  return {
    adapter: { complete } as unknown as OpenAICompatibleAdapter,
    complete,
  };
}

describe("provider tool capability health", () => {
  it("reports agent_ready after a dry-run tool call and final continuation", async () => {
    const { adapter, complete } = adapterWith(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: AGENT_READINESS_TOOL_NAME,
                    arguments: '{"marker":"agent-ready"}',
                  },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: "Dry run complete." } }] },
    );

    const result = await probeProviderTools(
      {
        provider,
        model: "opencode/mimo-v2.5-free",
        apiKey: "test-key",
      },
      adapter,
    );

    expect(result).toMatchObject({
      status: "agent_ready",
      modelId: "mimo-v2.5-free",
      toolTested: true,
      dryRunExecuted: true,
      finalResponseReceived: true,
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0][0].extra.tools[0].function.name).toBe(
      AGENT_READINESS_TOOL_NAME,
    );
    expect(complete.mock.calls[1][0].messages[2].role).toBe("tool");
  });

  it("reports tools_degraded when the provider ignores the required tool", async () => {
    const { adapter, complete } = adapterWith({
      choices: [{ message: { content: "I cannot call tools." } }],
    });

    const result = await probeProviderTools(
      { provider, model: "opencode/mimo-v2.5-free", apiKey: "test-key" },
      adapter,
    );

    expect(result.status).toBe("tools_degraded");
    expect(result.dryRunExecuted).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("preserves a typed rate-limit outcome without retrying the probe", async () => {
    const { adapter, complete } = adapterWith(
      new LLMRateLimitError("quota reached", {
        providerId: "opencode",
        status: 429,
      }),
    );

    const result = await probeProviderTools(
      { provider, model: "opencode/mimo-v2.5-free", apiKey: "test-key" },
      adapter,
    );

    expect(result.status).toBe("rate_limited");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
