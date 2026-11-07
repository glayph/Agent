export const CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 96

export interface ChatScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export interface ChatMessageAnchor {
  id: string
  top: number
}

export function isNearChatScrollBottom(
  { scrollHeight, scrollTop, clientHeight }: ChatScrollMetrics,
  threshold = CHAT_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

/** Return the scrollTop needed to keep an existing message at the same viewport Y. */
export function preserveChatAnchorScrollTop(
  currentScrollTop: number,
  previousAnchorTop: number,
  nextAnchorTop: number,
): number {
  return Math.max(0, currentScrollTop + nextAnchorTop - previousAnchorTop)
}

/** Capture the first message intersecting the chat viewport. */
export function captureChatMessageAnchor(
  viewport: HTMLElement,
): ChatMessageAnchor | null {
  const viewportRect = viewport.getBoundingClientRect()
  const messages = viewport.querySelectorAll<HTMLElement>(
    "[data-chat-message-id]",
  )

  for (const message of messages) {
    const rect = message.getBoundingClientRect()
    if (rect.bottom > viewportRect.top && rect.top < viewportRect.bottom) {
      const id = message.dataset.chatMessageId
      if (id) return { id, top: rect.top }
    }
  }

  return null
}

/** Restore an existing message to its previous viewport-relative Y position. */
export function restoreChatMessageAnchor(
  viewport: HTMLElement,
  anchor: ChatMessageAnchor,
): boolean {
  const messages = viewport.querySelectorAll<HTMLElement>(
    "[data-chat-message-id]",
  )
  let anchorElement: HTMLElement | undefined
  for (const message of messages) {
    if (message.dataset.chatMessageId === anchor.id) {
      anchorElement = message
      break
    }
  }
  if (!anchorElement) return false

  const nextTop = anchorElement.getBoundingClientRect().top
  viewport.scrollTop = preserveChatAnchorScrollTop(
    viewport.scrollTop,
    anchor.top,
    nextTop,
  )
  return true
}
