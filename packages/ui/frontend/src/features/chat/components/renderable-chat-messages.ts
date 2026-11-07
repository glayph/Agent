import type { ChatMessage } from "@/store/chat"

/**
 * Keep only user-facing conversation messages while preserving the canonical
 * transcript order supplied by the store/history API.
 *
 * Do not regroup assistant replies by replyToMessageId: a running assistant
 * turn can receive additional user messages after it has started. Its final
 * reply may still reference the original prompt, but moving that reply next to
 * the original prompt would place it above the newer user messages in the UI.
 * The chronological transcript already carries the correct display order.
 */
export function getRenderableChatMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.filter(
    (message) =>
      message.role === "user" ||
      (message.role === "assistant" &&
        message.kind === "normal" &&
        !message.notificationKind),
  )
}
