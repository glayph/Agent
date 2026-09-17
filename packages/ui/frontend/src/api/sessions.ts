import { launcherFetch } from "@/api/http"

export class SessionApiError extends Error {
  public readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "SessionApiError"
    this.status = status
  }
}

export interface SessionSummary {
  id: string
  title: string
  preview: string
  message_count: number
  created: string
  updated: string
  pinned?: boolean
}

export interface SessionDetail {
  id: string
  messages: {
    id?: string
    role: "user" | "assistant"
    content: string
    created_at?: string
    kind?: "normal" | "thought" | "tool_calls"
    run_id?: string
    thought_category?:
      "Plan" | "Action" | "Verification" | "Progress" | "Decision" | "Thought"
    inspector_only?: boolean
    model_name?: string
    media?: string[]
    image_urls?: string[]
    attachments?: {
      type?: "image" | "audio" | "video" | "file"
      url: string
      filename?: string
      content_type?: string
    }[]
    voice?: {
      source: "microphone" | "upload"
      provider: "whisper.cpp"
      language: string
      transcript: string
      duration_ms?: number
      latency_ms?: number
      transport?: "endpoint" | "cli"
    }
    tool_calls?: {
      id?: string
      type?: string
      function?: {
        name?: string
        arguments?: string
      }
      extra_content?: {
        tool_feedback_explanation?: string
      }
    }[]
  }[]
  summary: string
  created: string
  updated: string
  title?: string
  pinned?: boolean
}

export async function getSessions(
  offset: number = 0,
  limit: number = 20,
): Promise<SessionSummary[]> {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString(),
  })

  const res = await launcherFetch(`/api/sessions?${params.toString()}`)
  if (!res.ok) {
    throw new SessionApiError(
      `Failed to fetch sessions: ${res.status}`,
      res.status,
    )
  }
  return res.json()
}

export async function getSessionHistory(id: string): Promise<SessionDetail> {
  const res = await launcherFetch(`/api/sessions/${encodeURIComponent(id)}`)
  if (!res.ok) {
    throw new SessionApiError(
      `Failed to fetch session ${id}: ${res.status}`,
      res.status,
    )
  }
  return res.json()
}

export function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof SessionApiError && error.status === 404
}

export async function updateSessionMetadata(
  id: string,
  patch: { title?: string; pinned?: boolean },
): Promise<{
  id: string
  created: string
  updated: string
  title?: string
  pinned?: boolean
}> {
  const res = await launcherFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    throw new SessionApiError(
      `Failed to update session ${id}: ${res.status}`,
      res.status,
    )
  }
  return res.json()
}

export async function updateSessionMessage(
  sessionId: string,
  messageId: string,
  patch: { content?: string; media?: string[] },
): Promise<{ session_id: string; message: SessionDetail["messages"][number] }> {
  const res = await launcherFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  )
  if (!res.ok) {
    throw new SessionApiError(
      `Failed to update message: ${res.status}`,
      res.status,
    )
  }
  return res.json()
}

export async function deleteSessionMessage(
  sessionId: string,
  messageId: string,
): Promise<void> {
  const res = await launcherFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE" },
  )
  if (!res.ok) {
    throw new SessionApiError(
      `Failed to delete message: ${res.status}`,
      res.status,
    )
  }
}

export async function forkSessionAtMessage(
  sessionId: string,
  messageId: string,
): Promise<{ session_id: string; messages: SessionDetail["messages"] }> {
  const res = await launcherFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_id: messageId }),
    },
  )
  if (!res.ok) {
    throw new SessionApiError(
      `Failed to fork session: ${res.status}`,
      res.status,
    )
  }
  return res.json()
}

export async function retrySessionFromMessage(
  sessionId: string,
  messageId: string,
): Promise<{ session_id: string; message: SessionDetail["messages"][number] }> {
  const res = await launcherFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/retry`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_id: messageId }),
    },
  )
  if (!res.ok) {
    throw new SessionApiError(
      `Failed to retry message: ${res.status}`,
      res.status,
    )
  }
  return res.json()
}

export async function deleteSession(id: string): Promise<void> {
  const res = await launcherFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Miki-Confirm": "delete-session" },
  })
  if (!res.ok) {
    throw new SessionApiError(
      `Failed to delete session ${id}: ${res.status}`,
      res.status,
    )
  }
}
