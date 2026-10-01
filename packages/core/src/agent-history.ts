import type { ChatMessage } from "@miki/config";
import type { AgentTaskComplexity } from "./task-profile.js";

/**
 * Selects durable history that is safe to send to the next provider request.
 *
 * Simple turns normally receive only the current user turn. Continuity
 * questions are the exception: they explicitly ask about earlier messages,
 * so the model must receive a bounded recent window to answer from facts
 * instead of guessing.
 */
const CONTINUITY_QUERY =
  /(?:what did (?:i|we) say|what did (?:i|we) ask|what did you tell me|previous message|earlier|before|last conversation|what were we discussing|কিছুক্ষণ আগে|আগে কী|আগে কি|পূর্বের|শেষ কথোপকথন|কি বলেছিলাম|কী বলেছিলাম|কি আলোচনা|কী আলোচনা)/iu;

export function isConversationRecallQuery(message: string): boolean {
  return CONTINUITY_QUERY.test(message);
}

/**
 * Answer explicit recall questions from persisted messages, not model memory.
 * This prevents a small model from confidently inventing a prior exchange.
 */
export function buildConversationRecallReply(
  history: readonly ChatMessage[],
  query: string,
): string | null {
  if (!isConversationRecallQuery(query)) return null;
  const prior = history.slice(0, -1).filter((message) => {
    return (
      (message.role === "user" || message.role === "assistant") &&
      !message.is_error &&
      message.content.trim().length > 0
    );
  });
  if (prior.length === 0) {
    return "এই কথোপকথনে আপনার বর্তমান প্রশ্নের আগে কোনো সংরক্ষিত বার্তা নেই।";
  }

  const asksWhatUserSaid =
    /what did (?:i|we) (?:say|ask)|what did i tell you|কি বলেছিলাম|কী বলেছিলাম|আগে কী|আগে কি/i.test(
      query,
    );
  const preferredRole = asksWhatUserSaid ? "user" : "assistant";
  const candidates = prior.filter((message) => message.role === preferredRole);
  const selected = (candidates.length > 0 ? candidates : prior).slice(-3);
  const label = preferredRole === "user" ? "আপনি আগে বলেছিলেন" : "আমি আগে বলেছিলাম";
  return `${label}:\n${selected.map((message) => `- ${message.content.trim()}`).join("\n")}`;
}

export function selectAgentPromptHistory(
  history: readonly ChatMessage[],
  complexity: AgentTaskComplexity,
  historyMode: string,
  historyLimit: number,
): ChatMessage[] {
  if (historyMode === "off") return [];

  if (complexity === "simple") {
    if (isConversationRecallQuery(history.at(-1)?.content || "")) {
      return history
        .filter((message) => message.role !== "tool" && !message.is_error)
        .slice(-Math.max(6, Math.min(historyLimit, 12)))
        .map((message) => ({ ...message }));
    }
    const currentUserMessage = [...history]
      .reverse()
      .find((message) => message.role === "user");
    return currentUserMessage ? [{ ...currentUserMessage }] : [];
  }

  return history.slice(-Math.max(0, historyLimit)).map((message) => ({
    ...message,
  }));
}
