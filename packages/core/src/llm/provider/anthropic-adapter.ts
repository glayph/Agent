/**
 * Native Anthropic Claude adapter using @anthropic-ai/sdk.
 *
 * Why this exists: Anthropic's own OpenAI-compatible endpoint is documented
 * for testing/comparison only — it doesn't guarantee strict tool-call JSON
 * schema conformance, has no prompt caching, and has multi-tool-result
 * translation gaps. Since this agent relies heavily on the ReAct
 * Thought-Action-Observation loop (many tool calls per turn), the native
 * Messages API is the correct long-term path.
 *
 * Contract: inputs and outputs are identical to achatCompletion() in llm.ts.
 * Callers (agent.ts) are completely unaware of which path is active.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletionTool,
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions/completions.js";
import type { LLMResponse } from "@miki/config";
import {
  LLMRateLimitError,
  LLMTimeoutError,
  LLMAPIError,
  LLMMissingCredentialError,
} from "./errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Client cache — keyed by API key to avoid re-instantiation
// ─────────────────────────────────────────────────────────────────────────────

const clientCache = new Map<string, Anthropic>();

function getAnthropicClient(apiKey: string): Anthropic {
  const existing = clientCache.get(apiKey);
  if (existing) return existing;
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 120_000 });
  clientCache.set(apiKey, client);
  return client;
}

export function clearAnthropicClientCache(): void {
  clientCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool schema translation: OpenAI → Anthropic
// ─────────────────────────────────────────────────────────────────────────────

type AnthropicTool = Anthropic.Tool;

/**
 * Converts an array of OpenAI function-calling tool definitions to the
 * Anthropic Messages API tool format.
 *
 * OpenAI shape: { type: "function", function: { name, description, parameters } }
 * Anthropic shape: { name, description, input_schema }
 */
export function translateToolsToAnthropic(
  tools: ChatCompletionTool[] | undefined,
): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: (t.function.parameters ?? {
      type: "object",
      properties: {},
    }) as Anthropic.Tool["input_schema"],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Message translation: OpenAI → Anthropic
// ─────────────────────────────────────────────────────────────────────────────

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicContentBlock = Anthropic.ContentBlockParam;

/**
 * Extracts and joins the system prompt(s) from an OpenAI messages array.
 * Anthropic puts the system prompt at top level, not inside messages[].
 */
export function extractSystemPrompt(
  messages: ChatCompletionMessageParam[],
): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n\n")
    .trim();
}

/**
 * Translates an OpenAI messages array (excluding system messages) into
 * Anthropic's MessageParam array.
 *
 * Key differences handled:
 * - "system" role → removed (handled separately as top-level param)
 * - "assistant" with tool_calls → content array with tool_use blocks
 * - "tool" role → "user" role with tool_result content block
 * - Consecutive "tool" messages → merged into one "user" message with
 *   multiple tool_result blocks (Anthropic requires this)
 */
export function translateMessagesToAnthropic(
  messages: ChatCompletionMessageParam[],
): AnthropicMessage[] {
  const nonSystem = messages.filter((m) => m.role !== "system");
  const result: AnthropicMessage[] = [];

  let i = 0;
  while (i < nonSystem.length) {
    const msg = nonSystem[i];

    // ── Assistant message ───────────────────────────────────────────────────
    if (msg.role === "assistant") {
      const content: AnthropicContentBlock[] = [];

      // Text portion (may be null/empty when the assistant only calls tools)
      const textContent = typeof msg.content === "string" ? msg.content : "";
      if (textContent) {
        content.push({ type: "text", text: textContent });
      }

      // Tool calls → tool_use blocks
      const openaiMsg = msg as ChatCompletionAssistantMessageParam;
      if (openaiMsg.tool_calls && openaiMsg.tool_calls.length > 0) {
        for (const tc of openaiMsg.tool_calls) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput =
              typeof tc.function.arguments === "string"
                ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
                : {};
          } catch {
            // Malformed JSON arguments — pass empty object; tool will handle it
            parsedInput = {};
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }

      // An assistant message must have at least one content block
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }

      result.push({ role: "assistant", content });
      i++;
      continue;
    }

    // ── Tool result message(s) ──────────────────────────────────────────────
    // Collect consecutive "tool" messages and merge them into a single
    // Anthropic "user" message with multiple tool_result blocks.
    if (msg.role === "tool") {
      const toolResultBlocks: AnthropicContentBlock[] = [];

      while (i < nonSystem.length && nonSystem[i].role === "tool") {
        const toolMsg = nonSystem[i] as ChatCompletionToolMessageParam;
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolMsg.tool_call_id,
          content: typeof toolMsg.content === "string" ? toolMsg.content : "",
        });
        i++;
      }

      result.push({ role: "user", content: toolResultBlocks });
      continue;
    }

    // ── User message ────────────────────────────────────────────────────────
    if (msg.role === "user") {
      const textContent =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as Array<{ type: string; text?: string }>)
                .filter((b) => b.type === "text")
                .map((b) => b.text ?? "")
                .join("")
            : "";
      result.push({ role: "user", content: textContent });
      i++;
      continue;
    }

    // Skip anything else (shouldn't occur in normal agent flow)
    i++;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response translation: Anthropic → LLMResponse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts an Anthropic Messages API response to the LLMResponse shape
 * expected by achatCompletion() callers throughout the codebase.
 *
 * tool_calls[].function.arguments MUST be a JSON string (not an object),
 * because agent.ts reads it as a string and parses it itself.
 */
export function translateResponseToLLM(
  response: Anthropic.Message,
): LLMResponse {
  // Collect text blocks into a single string
  const textParts = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text);
  const textContent = textParts.join("") || null;

  // Collect tool_use blocks → OpenAI-shaped tool_calls
  const toolUseBlocks = response.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );

  const toolCalls =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((b) => ({
          id: b.id,
          type: "function" as const,
          function: {
            name: b.name,
            // Serialize input back to a JSON string — agent.ts expects this
            arguments: JSON.stringify(b.input),
          },
        }))
      : undefined;

  // Map Anthropic stop_reason → OpenAI finish_reason
  const stopReason = response.stop_reason;
  let finishReason: string;
  if (stopReason === "tool_use") finishReason = "tool_calls";
  else if (stopReason === "max_tokens") finishReason = "length";
  else finishReason = "stop";

  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: textContent,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps Anthropic SDK errors to the same LLMProviderError subclasses used by
 * the OpenAI-compat path in llm.ts, so callers see consistent error types.
 */
function classifyAnthropicError(err: unknown): never {
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const msg = err.message ?? String(err);

    // Auth failures
    if (
      status === 401 ||
      status === 403 ||
      msg.toLowerCase().includes("authentication") ||
      msg.toLowerCase().includes("unauthorized") ||
      msg.toLowerCase().includes("invalid api key")
    ) {
      throw new LLMMissingCredentialError(
        `Anthropic API key rejected (HTTP ${status}): ${msg}`,
      );
    }

    // Rate limit / quota
    if (
      status === 429 ||
      msg.toLowerCase().includes("rate limit") ||
      msg.toLowerCase().includes("quota")
    ) {
      throw new LLMRateLimitError(
        `Anthropic rate limit hit (HTTP ${status}): ${msg}`,
      );
    }

    // Timeout (408 or SDK timeout)
    if (
      status === 408 ||
      err instanceof Anthropic.APIConnectionTimeoutError ||
      msg.toLowerCase().includes("timeout")
    ) {
      throw new LLMTimeoutError(`Anthropic request timed out: ${msg}`);
    }

    throw new LLMAPIError(`Anthropic API error (HTTP ${status}): ${msg}`);
  }

  // Non-SDK error (network issue, JSON parse, etc.)
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.toLowerCase().includes("timeout")) {
    throw new LLMTimeoutError(`Anthropic timeout: ${msg}`);
  }
  throw new LLMAPIError(`Unexpected error calling Anthropic: ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

/**
 * Drop-in replacement for the OpenAI-compat path in achatCompletion().
 *
 * Accepts OpenAI-shaped messages and tool definitions, calls the native
 * Anthropic Messages API, and returns an LLMResponse with the same shape
 * that the OpenAI path would have returned. Callers (agent.ts) see no
 * difference.
 *
 * @param messages  OpenAI-shaped chat messages (system/user/assistant/tool)
 * @param model     Anthropic model name, e.g. "claude-sonnet-4-5"
 * @param apiKey    ANTHROPIC_API_KEY resolved by the caller
 * @param extra     Additional overrides (temperature, max_tokens, tools, …)
 */
export async function claudeNativeCompletion(
  messages: ChatCompletionMessageParam[],
  model: string,
  apiKey: string,
  extra?: Record<string, unknown>,
): Promise<LLMResponse> {
  const client = getAnthropicClient(apiKey);

  // Extract system prompt and translate remaining messages
  const system = extractSystemPrompt(messages);
  const anthropicMessages = translateMessagesToAnthropic(messages);

  // Translate tools if provided in extra
  const rawTools = extra?.tools as ChatCompletionTool[] | undefined;
  const anthropicTools = translateToolsToAnthropic(rawTools);

  // Build the request payload
  const temperature =
    typeof extra?.temperature === "number" ? extra.temperature : 0.7;
  const maxTokens =
    typeof extra?.max_tokens === "number" ? extra.max_tokens : 4096;

  // Validate: Anthropic requires at least one non-system message
  if (anthropicMessages.length === 0) {
    throw new LLMAPIError(
      "Cannot call Anthropic API with no user/assistant messages.",
    );
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        temperature,
        messages: anthropicMessages,
        ...(system ? { system } : {}),
        ...(anthropicTools ? { tools: anthropicTools } : {}),
      };

      const response = await client.messages.create(requestParams);
      return translateResponseToLLM(response);
    } catch (err: unknown) {
      lastError = err;

      // Classify the error — if it's terminal (auth, quota), throw now
      const isRateLimit =
        err instanceof Anthropic.APIError &&
        (err.status === 429 ||
          err.message?.toLowerCase().includes("rate limit") ||
          err.message?.toLowerCase().includes("quota"));

      const isAuth =
        err instanceof Anthropic.APIError &&
        (err.status === 401 || err.status === 403);

      // Auth errors: no point retrying
      if (isAuth) classifyAnthropicError(err);

      // Rate-limit: throw immediately (caller decides what to do)
      if (isRateLimit) classifyAnthropicError(err);

      // Retryable (transient network/timeout errors) — exponential backoff
      const isRetryable =
        err instanceof Anthropic.APIConnectionError ||
        err instanceof Anthropic.APIConnectionTimeoutError ||
        (err instanceof Anthropic.APIError &&
          err.status !== undefined &&
          err.status >= 500);

      if (attempt < MAX_RETRIES - 1 && isRetryable) {
        const baseMs = Math.pow(2, attempt) * 1000;
        const waitMs = baseMs / 2 + Math.random() * (baseMs / 2);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      // Final attempt or non-retryable error
      classifyAnthropicError(err);
    }
  }

  // Should never reach here, but satisfy the compiler
  classifyAnthropicError(lastError);
}
