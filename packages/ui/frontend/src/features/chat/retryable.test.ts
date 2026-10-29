import { describe, expect, it } from "vitest"

import type { ChatMessage } from "@/store/chat"

import { getRetryableMessageIds, isUnansweredUserMessage, messageHasRetryPrompt } from "./retryable"

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "user-1",
    role: "user",
    content: "",
    timestamp: 1,
    ...overrides,
  }
}

describe("chat prompt retryability", () => {
  it.each(["image", "audio", "video", "file"] as const)(
    "allows retry for an attachment-only %s prompt",
    (type) => {
      const message = userMessage({
        attachments: [{ type, url: "/miki/media/upload" }],
      })

      expect(messageHasRetryPrompt(message)).toBe(true)
      expect(getRetryableMessageIds([message])).toEqual(new Set(["user-1"]))
    },
  )

  it("allows retry for a voice prompt with a transcript", () => {
    expect(
      messageHasRetryPrompt(
        userMessage({
          voice: {
            source: "microphone",
            provider: "whisper.cpp",
            language: "en",
            transcript: "Turn this recording into notes",
          },
        }),
      ),
    ).toBe(true)
  })

  it("does not offer retry when the latest message has no prompt content", () => {
    expect(getRetryableMessageIds([userMessage()])).toEqual(new Set())
    expect(
      getRetryableMessageIds([
        userMessage({ content: "Earlier prompt" }),
        userMessage(),
      ]),
    ).toEqual(new Set())
  })

  it("keeps a failed user turn retryable even though an error message follows it", () => {
    const failed = userMessage({ id: "u-failed", content: "Do it", deliveryStatus: "failed" })
    const error: ChatMessage = { id: "error-run", role: "assistant", kind: "error", content: "timed out", timestamp: 2 }
    expect(getRetryableMessageIds([failed, error]).has("u-failed")).toBe(true)
  })

  it("does not offer retry for an older failed turn once the user wrote again", () => {
    const failed = userMessage({ id: "u-old", content: "Old", deliveryStatus: "failed" })
    const answer: ChatMessage = { id: "a-1", role: "assistant", content: "ok", timestamp: 2 }
    const next = userMessage({ id: "u-new", content: "New", timestamp: 3 })
    expect(getRetryableMessageIds([failed, answer, next])).toEqual(new Set(["u-new"]))
  })

  it("keeps an earlier unanswered message retryable when the user has written since, and not an answered one", () => {
    const cancelled = userMessage({ id: "u-stopped", content: "Also rename it", deliveryStatus: "cancelled" })
    const answered = userMessage({ id: "u-done", content: "Hello", deliveryStatus: undefined })
    const reply: ChatMessage = { id: "a-1", role: "assistant", content: "Hi", timestamp: 2 }
    const latest = userMessage({ id: "u-latest", content: "Thanks", timestamp: 3 })
    const ids = getRetryableMessageIds([cancelled, answered, reply, latest])
    expect(ids.has("u-stopped")).toBe(true)
    expect(ids.has("u-done")).toBe(false)
    expect(ids.has("u-latest")).toBe(true)
    expect(isUnansweredUserMessage(cancelled)).toBe(true)
    expect(isUnansweredUserMessage(answered)).toBe(false)
  })
})
