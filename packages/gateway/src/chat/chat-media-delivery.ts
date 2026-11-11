import { randomUUID } from "node:crypto"
import type Database from "better-sqlite3"
import type { ChatMediaDelivery } from "./chat-send-file-tool.js"
import type { RunStream } from "./stream-hub.js"

interface SocketLike {
  readyState: number
  OPEN: number
  send(data: string): void
}

export interface ChatMediaDeliveryDeps {
  db: Database.Database
  now: () => string
  /** Live stream of a chat run, if the run is still streaming to a conversation. */
  getStream: (runId: string) => RunStream | undefined
  publish: (stream: RunStream, type: string, payload: Record<string, unknown>) => void
  ensureSession: (sessionId: string) => void
  /** Browsers that receive messages from runs that have no chat stream. */
  proactiveSockets: Iterable<SocketLike>
}

/**
 * Shows files the agent sent with chat_send_file as their own chat message.
 * A run streaming to a chat posts it live into that conversation; a background run
 * (autonomy, scheduler) posts it to the main chat as a proactive message. Either way the
 * row is stored first, so the files are still there after a refresh or restart.
 */
export function createChatMediaDelivery(deps: ChatMediaDeliveryDeps): (delivery: ChatMediaDelivery) => Promise<void> {
  return async (delivery) => {
    const messageId = randomUUID()
    const createdAt = deps.now()
    const attachmentsJson = JSON.stringify(delivery.attachments)
    const stream = deps.getStream(delivery.runId)

    if (stream && !stream.done) {
      deps.db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,model_name,context_id,attachments_json,reply_to_message_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(messageId, stream.sessionId, "assistant", delivery.caption, createdAt, "normal", null, stream.contextId, attachmentsJson, stream.replyToMessageId ?? null)
      deps.db.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").run(createdAt, stream.sessionId)
      deps.publish(stream, "message.create", {
        message_id: messageId,
        content: delivery.caption,
        kind: "normal",
        attachments: delivery.attachments,
      })
      return
    }

    const sessionId = delivery.sessionId || "miki-main-chat"
    deps.ensureSession(sessionId)
    // `proactive:result:*` rows stay visible in the chat history after a refresh.
    deps.db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,model_name,context_id,attachments_json) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(messageId, sessionId, "assistant", delivery.caption, createdAt, "normal", null, `proactive:result:${delivery.runId}`, attachmentsJson)
    deps.db.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").run(createdAt, sessionId)
    const frame = JSON.stringify({
      type: "proactive.message",
      timestamp: Date.now(),
      payload: {
        message_id: messageId,
        session_id: sessionId,
        content: delivery.caption,
        kind: "normal",
        proactive: true,
        source: "chat_send_file",
        run_id: delivery.runId,
        attachments: delivery.attachments,
      },
    })
    for (const socket of deps.proactiveSockets) {
      if (socket.readyState !== socket.OPEN) continue
      try { socket.send(frame) } catch { /* a dead socket must not lose the stored message */ }
    }
  }
}
