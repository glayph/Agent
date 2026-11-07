import { describe, expect, it } from "vitest"

import { parseAttachments } from "../protocol"
import { isPlayableAttachment } from "./attachment-kind"

describe("agent-sent media attachments", () => {
  it("keeps image, video, audio and document types from a message payload", () => {
    const attachments = parseAttachments({
      attachments: [
        {
          type: "image",
          url: "/api/chat-media?path=a",
          filename: "a.png",
          content_type: "image/png",
        },
        {
          type: "video",
          url: "/api/chat-media?path=b",
          filename: "b.mp4",
          content_type: "video/mp4",
        },
        {
          type: "audio",
          url: "/api/chat-media?path=c",
          filename: "c.mp3",
          content_type: "audio/mpeg",
        },
        {
          type: "file",
          url: "/api/chat-media?path=d",
          filename: "d.pdf",
          content_type: "application/pdf",
        },
        { type: "video" },
      ],
    })
    expect(attachments?.map((item) => item.type)).toEqual([
      "image",
      "video",
      "audio",
      "file",
    ])
  })

  it("plays only video and audio inline", () => {
    const base = { url: "/x", filename: "x" }
    expect(isPlayableAttachment({ ...base, type: "video" })).toBe(true)
    expect(isPlayableAttachment({ ...base, type: "audio" })).toBe(true)
    expect(isPlayableAttachment({ ...base, type: "image" })).toBe(false)
    expect(isPlayableAttachment({ ...base, type: "file" })).toBe(false)
  })
})
