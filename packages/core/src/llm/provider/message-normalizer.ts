import type { ProviderCompletionRequest } from "./contracts.js";

export function normalizeToolMessageSequence(
  messages: ProviderCompletionRequest["messages"],
): ProviderCompletionRequest["messages"] {
  const normalized: ProviderCompletionRequest["messages"] = [];
  const pendingToolCallIds = new Set<string>();

  for (const message of messages) {
    if (
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      normalized.push(message);
      for (const call of message.tool_calls) {
        if (typeof call !== "object" || call === null) continue;
        const id = (call as { id?: unknown }).id;
        if (typeof id === "string" && id.trim()) {
          pendingToolCallIds.add(id.trim());
        }
      }
      continue;
    }

    if (message.role === "tool") {
      const toolCallId =
        typeof message.tool_call_id === "string"
          ? message.tool_call_id.trim()
          : "";
      if (toolCallId && pendingToolCallIds.has(toolCallId)) {
        normalized.push(message);
        pendingToolCallIds.delete(toolCallId);
        continue;
      }

      // Summarization, retries, or provider adapters can leave a tool result
      // without its preceding assistant tool_calls message. Some compatible
      // endpoints reject that history with HTTP 400. Preserve the result as a
      // user-visible context message instead of sending an invalid sequence.
      const content =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? "");
      normalized.push({
        role: "user",
        content: `[Tool result${toolCallId ? ` ${toolCallId}` : ""}] ${content}`,
      });
      continue;
    }

    normalized.push(message);
  }
  return normalized;
}
