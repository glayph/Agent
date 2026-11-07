import { describe, expect, it } from "vitest"

import {
  CHAT_SCROLL_BOTTOM_THRESHOLD_PX,
  captureChatMessageAnchor,
  isNearChatScrollBottom,
  preserveChatAnchorScrollTop,
  restoreChatMessageAnchor,
} from "./chat-scroll-utils"

describe("chat scroll behavior", () => {
  it("considers the viewport following when it is within the bottom threshold", () => {
    expect(CHAT_SCROLL_BOTTOM_THRESHOLD_PX).toBe(96)
    expect(
      isNearChatScrollBottom({
        scrollHeight: 1800,
        scrollTop: 1610,
        clientHeight: 100,
      }),
    ).toBe(true)
  })

  it("stops auto-follow when the reader moves away from the latest messages", () => {
    expect(
      isNearChatScrollBottom({
        scrollHeight: 1800,
        scrollTop: 1200,
        clientHeight: 100,
      }),
    ).toBe(false)
  })

  it("preserves the visible message position when older history is prepended", () => {
    // The anchor moved 420px down after older messages were inserted above it.
    expect(preserveChatAnchorScrollTop(800, 120, 540)).toBe(1220)
  })

  it("captures the first message intersecting the viewport", () => {
    const message = {
      dataset: { chatMessageId: "msg-42" },
      getBoundingClientRect: () => ({ top: 145, bottom: 220 }),
    }
    const viewport = {
      getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
      querySelectorAll: () => [message],
    } as unknown as HTMLElement

    expect(captureChatMessageAnchor(viewport)).toEqual({
      id: "msg-42",
      top: 145,
    })
  })

  it("restores the captured message to its previous viewport position", () => {
    const message = {
      dataset: { chatMessageId: "msg-42" },
      getBoundingClientRect: () => ({ top: 245, bottom: 320 }),
    }
    const viewport = {
      scrollTop: 400,
      querySelectorAll: () => [message],
    } as unknown as HTMLElement

    expect(
      restoreChatMessageAnchor(viewport, { id: "msg-42", top: 145 }),
    ).toBe(true)
    expect(viewport.scrollTop).toBe(500)
  })

  it("does not create a negative scroll position while restoring an anchor", () => {
    expect(preserveChatAnchorScrollTop(10, 100, 0)).toBe(0)
  })
})
