import type { ChatMessage } from "@/store/chat"

export function messageHasRetryPrompt(message: ChatMessage): boolean {
  return Boolean(
    message.content.trim() ||
      message.voice?.transcript.trim() ||
      message.attachments?.some((attachment) => Boolean(attachment.url.trim())),
  )
}

export function getRetryableMessageIds(messages: ChatMessage[]): Set<string> {
  const lastMessage = messages.at(-1)
  return lastMessage && messageHasRetryPrompt(lastMessage)
    ? new Set([lastMessage.id])
    : new Set()
}
