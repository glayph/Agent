import type { ChatMessage } from "@miki/config";
import type { AgentTaskComplexity } from "./task-profile.js";

/**
 * Selects durable history that is safe to send to the next provider request.
 *
 * Simple turns deliberately receive only the current user turn. This avoids
 * replaying stale tool errors, old task instructions, or unrelated assistant
 * claims into a small local model. Standard and complex turns retain the
 * existing bounded history because those workflows may need continuity.
 */
export function selectAgentPromptHistory(
  history: readonly ChatMessage[],
  complexity: AgentTaskComplexity,
  historyMode: string,
  historyLimit: number,
): ChatMessage[] {
  if (historyMode === "off") return [];

  if (complexity === "simple") {
    const currentUserMessage = [...history]
      .reverse()
      .find((message) => message.role === "user");
    return currentUserMessage ? [{ ...currentUserMessage }] : [];
  }

  return history.slice(-Math.max(0, historyLimit)).map((message) => ({
    ...message,
  }));
}
