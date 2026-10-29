import { launcherFetch } from "@/api/http"
import type { ChatAttachment } from "@/store/chat"

export interface ChatAttachmentUpload extends ChatAttachment {
  sizeBytes: number
}

/** Uploads the binary file first, keeping large base64 payloads out of the chat WebSocket. */
export async function uploadChatAttachment(file: File): Promise<ChatAttachmentUpload> {
  const params = new URLSearchParams({ filename: file.name })
  const response = await launcherFetch(`/api/chat-uploads?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(payload.error || `Upload failed (${response.status}).`)
  }

  const payload = (await response.json()) as {
    type: ChatAttachment["type"]
    filename: string
    content_type: string
    url: string
  }

  return {
    type: payload.type,
    filename: payload.filename,
    contentType: payload.content_type,
    url: payload.url,
    sizeBytes: file.size,
  }
}
