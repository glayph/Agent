import type { ChatMessage } from "@/store/chat"

/**
 * Keep only user-facing conversation messages and place correlated assistant
 * replies after their user prompt. An assistant reply whose prompt was deleted
 * remains visible as an independent message instead of disappearing with it.
 */
export function getRenderableChatMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  const filtered = messages.filter(
    (message) =>
      message.role === "user" ||
      (message.role === "assistant" &&
        message.kind === "normal" &&
        !message.notificationKind),
  )

  const visibleUserMessageIds = new Set(
    filtered
      .filter((message) => message.role === "user")
      .map((message) => message.id),
  )
  const correlated = filtered.filter(
    (message) =>
      message.role === "assistant" &&
      message.replyToMessageId &&
      visibleUserMessageIds.has(message.replyToMessageId),
  )
  if (correlated.length === 0) return filtered

  const repliesByUser = new Map<string, ChatMessage[]>()
  for (const message of correlated) {
    const parentId = message.replyToMessageId
    if (!parentId) continue
    const replies = repliesByUser.get(parentId) ?? []
    replies.push(message)
    repliesByUser.set(parentId, replies)
  }

  const parentIds = new Set(repliesByUser.keys())
  const ordered: ChatMessage[] = []
  for (const message of filtered) {
    if (
      message.role === "assistant" &&
      message.replyToMessageId &&
      parentIds.has(message.replyToMessageId)
    ) {
      continue
    }
    ordered.push(message)
    if (message.role === "user") {
      ordered.push(...(repliesByUser.get(message.id) ?? []))
    }
  }
  return ordered
}
