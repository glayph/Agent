import type { ChatAttachment } from "@/store/chat"

/** True for attachments the browser can play inline (video and audio). */
export function isPlayableAttachment(attachment: ChatAttachment): boolean {
  return attachment.type === "video" || attachment.type === "audio"
}
