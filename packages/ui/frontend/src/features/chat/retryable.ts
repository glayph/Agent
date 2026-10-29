import type { ChatMessage } from "@/store/chat"

export function messageHasRetryPrompt(message: ChatMessage): boolean {
  return Boolean(
    message.content.trim() ||
    message.voice?.transcript.trim() ||
    message.attachments?.some((attachment) => Boolean(attachment.url.trim())),
  )
}

/**
 * A user message whose turn failed (timeout, provider error). The failed turn leaves an error
 * message after it, so it is no longer the last message but must stay retryable, as long as the
 * user has not said anything newer. Mirrors the gateway rule for `message.retry`.
 */
export function findFailedUserTurn(
  messages: ChatMessage[],
): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "user") continue
    return message.deliveryStatus === "failed" && messageHasRetryPrompt(message)
      ? message
      : undefined
  }
  return undefined
}

/**
 * A user message that never got its answer: its run failed, or the run was stopped before it was read.
 * Mirrors the gateway rule for `message.retry` on an older message.
 */
export function isUnansweredUserMessage(message: ChatMessage): boolean {
  return (
    message.role === "user" &&
    (message.deliveryStatus === "failed" ||
      message.deliveryStatus === "cancelled") &&
    messageHasRetryPrompt(message)
  )
}

export function getRetryableMessageIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>()
  const lastMessage = messages.at(-1)
  if (lastMessage && messageHasRetryPrompt(lastMessage)) ids.add(lastMessage.id)
  const failedTurn = findFailedUserTurn(messages)
  if (failedTurn) ids.add(failedTurn.id)
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== "user" || !isUnansweredUserMessage(message)) continue
    const hasNewerUserMessage = messages
      .slice(index + 1)
      .some((candidate) => candidate.role === "user")
    if (!hasNewerUserMessage || message.deliveryStatus === "cancelled")
      ids.add(message.id)
  }
  return ids
}
