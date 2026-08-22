import type { LLMResponse } from "@miki/config";
import {
  LLMEntitlementError,
  LLMProviderError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMMissingCredentialError,
} from "./errors.js";
import {
  normalizeDirectModelName,
  type DirectProviderConfig,
} from "./catalog.js";
import {
  openAICompatibleAdapter,
  type OpenAICompatibleAdapter,
} from "./openai-compatible-adapter.js";
import type { ProviderCompletionRequest } from "./contracts.js";

export type ToolHealthStatus =
  | "agent_ready"
  | "tools_degraded"
  | "invalid"
  | "entitlement_blocked"
  | "rate_limited"
  | "unreachable";

export interface ToolHealthResult {
  providerId: string;
  modelId: string;
  status: ToolHealthStatus;
  toolTested: boolean;
  dryRunExecuted: boolean;
  finalResponseReceived: boolean;
  latencyMs: number;
  toolName: string;
  diagnostic?: LLMProviderError["diagnostic"];
  error?: string;
}

export interface ToolHealthInput {
  provider: DirectProviderConfig;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  prompt?: string;
}

const TOOL_NAME = "miki_agent_readiness_probe";
const TOOL_DEFINITION = {
  type: "function",
  function: {
    name: TOOL_NAME,
    description:
      "A no-side-effect readiness probe. It only returns the supplied marker and never accesses files, networks, accounts, or external services.",
    parameters: {
      type: "object",
      properties: {
        marker: { type: "string" },
      },
      required: ["marker"],
      additionalProperties: false,
    },
  },
} as const;

function statusForError(error: unknown): ToolHealthStatus {
  if (error instanceof LLMMissingCredentialError) return "invalid";
  if (error instanceof LLMEntitlementError) return "entitlement_blocked";
  if (error instanceof LLMRateLimitError) return "rate_limited";
  if (error instanceof LLMTimeoutError) return "unreachable";
  return "unreachable";
}

function errorText(error: unknown): string {
  if (error instanceof LLMProviderError) return error.message;
  return "Tool capability probe failed.";
}

function messageOf(response: LLMResponse): Record<string, unknown> {
  const choice = response.choices?.[0] as unknown as
    Record<string, unknown> | undefined;
  return choice?.message && typeof choice.message === "object"
    ? (choice.message as Record<string, unknown>)
    : {};
}

function toolCallsOf(
  message: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return Array.isArray(message.tool_calls)
    ? message.tool_calls.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
      )
    : [];
}

function toolCallName(call: Record<string, unknown>): string {
  const fn = call.function;
  return fn &&
    typeof fn === "object" &&
    typeof (fn as Record<string, unknown>).name === "string"
    ? String((fn as Record<string, unknown>).name)
    : "";
}

function toolCallId(call: Record<string, unknown>): string {
  return typeof call.id === "string" && call.id.trim()
    ? call.id
    : "miki-probe-call";
}

export async function probeProviderTools(
  input: ToolHealthInput,
  adapter: OpenAICompatibleAdapter = openAICompatibleAdapter,
): Promise<ToolHealthResult> {
  const started = Date.now();
  const modelId = normalizeDirectModelName(input.provider.id, input.model);
  const base: Omit<ToolHealthResult, "status" | "latencyMs"> = {
    providerId: input.provider.id,
    modelId,
    toolTested: true,
    dryRunExecuted: false,
    finalResponseReceived: false,
    toolName: TOOL_NAME,
  };
  const common: Omit<ProviderCompletionRequest, "messages"> = {
    provider: input.provider,
    model: modelId,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs,
  };
  const prompt =
    input.prompt ||
    `Call ${TOOL_NAME} exactly once with marker "agent-ready". This is a no-side-effect dry run.`;

  try {
    const first = await adapter.complete({
      ...common,
      messages: [{ role: "user", content: prompt }],
      extra: {
        tools: [TOOL_DEFINITION],
        tool_choice: { type: "function", function: { name: TOOL_NAME } },
        max_tokens: 96,
        temperature: 0,
      },
    });
    const firstMessage = messageOf(first);
    const toolCalls = toolCallsOf(firstMessage).filter(
      (call) => toolCallName(call) === TOOL_NAME,
    );
    if (toolCalls.length === 0) {
      return {
        ...base,
        status: "tools_degraded",
        latencyMs: Date.now() - started,
        error:
          "Provider completed the prompt without the required dry-run tool call.",
      };
    }

    const toolCall = toolCalls[0];
    const second = await adapter.complete({
      ...common,
      messages: [
        { role: "user", content: prompt },
        {
          role: "assistant",
          content:
            typeof firstMessage.content === "string"
              ? firstMessage.content
              : null,
          tool_calls: toolCalls as never,
        } as never,
        {
          role: "tool",
          tool_call_id: toolCallId(toolCall),
          content: JSON.stringify({
            ok: true,
            dry_run: true,
            marker: "agent-ready",
          }),
        } as never,
      ],
      extra: { max_tokens: 96, temperature: 0 },
    });
    const secondMessage = messageOf(second);
    const finalContent =
      typeof secondMessage.content === "string"
        ? secondMessage.content.trim()
        : "";
    return {
      ...base,
      status: finalContent ? "agent_ready" : "tools_degraded",
      dryRunExecuted: true,
      finalResponseReceived: Boolean(finalContent),
      latencyMs: Date.now() - started,
      ...(finalContent
        ? {}
        : {
            error:
              "Provider accepted the dry-run tool but returned no final response.",
          }),
    };
  } catch (error) {
    return {
      ...base,
      status: statusForError(error),
      latencyMs: Date.now() - started,
      error: errorText(error),
      ...(error instanceof LLMProviderError && error.diagnostic
        ? { diagnostic: error.diagnostic }
        : {}),
    };
  }
}

export { TOOL_NAME as AGENT_READINESS_TOOL_NAME };
