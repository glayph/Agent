import { launcherFetch } from "./http"

export type AnswerRating = "up" | "down"

/** Sends a thumbs up or down for one assistant answer. Throws when the gateway did not record it. */
export async function rateAnswer(
  messageId: string,
  rating: AnswerRating,
): Promise<void> {
  const response = await launcherFetch("/api/chat/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message_id: messageId, rating }),
  })
  if (!response.ok) {
    let message = `Feedback was not recorded (${response.status}).`
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body.error === "string" && body.error.trim()) {
        message = body.error.trim()
      }
    } catch {
      // Keep the status-based message when the body is not JSON.
    }
    throw new Error(message)
  }
}
