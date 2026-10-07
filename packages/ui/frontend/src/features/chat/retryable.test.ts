import { describe, expect, it } from "vitest"

import type { ChatMessage } from "@/store/chat"

import { getRetryableMessageIds, messageHasRetryPrompt } from "./retryable"

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
})
