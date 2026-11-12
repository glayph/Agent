import { getDefaultStore } from "jotai"
import { notify } from "@/lib/notify"

import {
  deleteSessionMessage,
  forkSessionAtMessage,
  isSessionNotFoundError,
  updateSessionMessage,
} from "@/api/sessions"
import {
  loadSessionMessages,
  mergeHistoryMessages,
} from "@/features/chat/history"
import {
  type MikiWsClientMessage,
  type MikiWsServerMessage,
  handlemikiMessage,
} from "@/features/chat/protocol"
import {
  findFailedUserTurn,
  isUnansweredUserMessage,
} from "@/features/chat/retryable"
import {
  SINGLE_CHAT_SESSION_ID,
  clearStoredSessionId,
  readStoredSessionId,
  writeStoredSessionId,
} from "@/features/chat/state"
import { invalidateSocket, isCurrentSocket } from "@/features/chat/websocket"
import { handleMonitorMessage } from "@/features/monitor/protocol"
import i18n from "@/i18n"
import {
  type ChatAttachment,
  type ChatMessage,
  type ChatVoiceMetadata,
  getChatState,
  thinkingModeAtom,
  updateChatStore,
} from "@/store/chat"
import { type GatewayState, gatewayAtom } from "@/store/gateway"
import { CHAT_INPUT_LIMITS } from "@miki/config"

const store = getDefaultStore()

function providerForRunModel(
  modelName: string | undefined,
): string | undefined {
  if (!modelName) return undefined
  const normalized = modelName.toLowerCase()
  if (normalized.startsWith("gemini/") || normalized.startsWith("google/")) {
    return "gemini"
  }
  if (
    normalized.startsWith("llama.cpp/") ||
    normalized.startsWith("llama-cpp/") ||
    normalized.startsWith("local/") ||
    normalized.startsWith("local-llama/")
  ) {
    return "llama.cpp"
  }
  return undefined
}

function latestRunIdentity(messages: ChatMessage[]): {
  model?: string
  provider?: string
} {
  const message = [...messages]
    .reverse()
    .find((candidate) => candidate.role === "assistant" && candidate.modelName)
  const model = message?.modelName
  return { model, provider: providerForRunModel(model) }
}

function hideResolvedErrors(messages: ChatMessage[]): ChatMessage[] {
  // Errors are user-facing assistant messages. Keep them in the transcript so
  // a later successful run cannot erase the explanation for the failed run.
  return messages
}

let wsRef: WebSocket | null = null
let isConnecting = false
let msgIdCounter = 0
let retryRequestCounter = 0
let activeSessionIdRef = getChatState().activeSessionId
let initialized = false
let hydratePromise: Promise<void> | null = null
let connectionGeneration = 0
let reconnectTimer: number | null = null
let reconnectAttempts = 0
let shouldMaintainConnection = false
let activeCheckpointId: string | null = null
let activeSequence = -1

let customWsFactory: ((url: string) => WebSocket) | null = null
// Keep unacknowledged frames in memory and replay them with the same id after reconnect.
// The gateway deduplicates by client message id, so this closes the send/ack race safely.
const pendingOutgoing = new Map<string, { sessionId: string; frame: string }>()
// Retry requests are retained until the gateway acknowledges the exact request id.
// Replaying the same frame is safe because the gateway persists retry idempotency keys.
const pendingRetries = new Map<string, { sessionId: string; frame: string; targetMessageId: string; userMessageId: string }>()

export function setWebSocketFactory(
  factory: ((url: string) => WebSocket) | null,
) {
  customWsFactory = factory
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function shouldReconnectFor(generation: number, sessionId: string): boolean {
  return (
    shouldMaintainConnection &&
    generation === connectionGeneration &&
    sessionId === activeSessionIdRef &&
    store.get(gatewayAtom).status === "running"
  )
}

function scheduleReconnect(generation: number, sessionId: string) {
  if (!shouldReconnectFor(generation, sessionId) || reconnectTimer !== null) {
    return
  }

  const delay = Math.min(1000 * 2 ** reconnectAttempts, 5000)
  reconnectAttempts += 1
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    if (!shouldReconnectFor(generation, sessionId)) {
      return
    }
    void connectChat()
  }, delay)
}

async function isGatewaySessionAuthenticated(): Promise<boolean> {
  try {
    const { getLauncherAuthStatus } = await import("@/api/launcher-auth")
    const status = await getLauncherAuthStatus()
    return status.authenticated === true
  } catch {
    return true
  }
}

function needsActiveSessionHydration(): boolean {
  const state = getChatState()

  return Boolean(!state.hasHydratedActiveSession && state.activeSessionId)
}

function setActiveSessionId(sessionId: string) {
  activeSessionIdRef = sessionId
  updateChatStore({ activeSessionId: sessionId })
}

function disconnectChatInternal({
  clearDesiredConnection,
}: {
  clearDesiredConnection: boolean
}) {
  connectionGeneration += 1
  clearReconnectTimer()

  if (clearDesiredConnection) {
    shouldMaintainConnection = false
  }

  const socket = wsRef
  wsRef = null
  isConnecting = false

  invalidateSocket(socket)

  updateChatStore({
    connectionState: "disconnected",
    isTyping: false,
  })
}

export async function connectChat() {
  if (
    store.get(gatewayAtom).status !== "running" ||
    needsActiveSessionHydration()
  ) {
    return
  }

  if (
    isConnecting ||
    (wsRef &&
      (wsRef.readyState === WebSocket.OPEN ||
        wsRef.readyState === WebSocket.CONNECTING))
  ) {
    return
  }

  const generation = connectionGeneration + 1
  connectionGeneration = generation
  isConnecting = true
  clearReconnectTimer()
  updateChatStore({ connectionState: "connecting" })

  try {
    const sessionId = activeSessionIdRef

    if (generation !== connectionGeneration) {
      isConnecting = false
      return
    }

    const isHttps =
      typeof window !== "undefined" && window.location?.protocol === "https:"
    const host =
      typeof window !== "undefined" && window.location?.host
        ? window.location.host
        : "localhost:18800"
    const wsScheme = isHttps ? "wss:" : "ws:"
    const wsUrl = `${wsScheme}//${host}/miki/ws`
    const url = `${wsUrl}?session_id=${encodeURIComponent(sessionId)}`
    const socket = customWsFactory ? customWsFactory(url) : new WebSocket(url)
    const pendingDeltas: MikiWsServerMessage[] = []
    let pendingDeltaTimer: number | null = null
    const flushPendingDeltas = () => {
      if (pendingDeltaTimer !== null) {
        window.clearTimeout(pendingDeltaTimer)
        pendingDeltaTimer = null
      }
      const queued = pendingDeltas.splice(0)
      if (
        activeSessionIdRef !== sessionId ||
        generation !== connectionGeneration
      )
        return
      for (const delta of queued) handlemikiMessage(delta, sessionId)
    }
    const queueDelta = (delta: MikiWsServerMessage) => {
      const payload = delta.payload ?? {}
      const id =
        typeof payload.message_id === "string" ? payload.message_id : ""
      const text = typeof payload.delta === "string" ? payload.delta : ""
      if (!id || !text) {
        handlemikiMessage(delta, sessionId)
        return
      }
      const previous = pendingDeltas[pendingDeltas.length - 1]
      const previousId = previous?.payload?.message_id
      if (previous && previousId === id) {
        const priorText =
          typeof previous.payload?.delta === "string"
            ? previous.payload.delta
            : ""
        pendingDeltas[pendingDeltas.length - 1] = {
          ...delta,
          payload: { ...previous.payload, ...payload, delta: priorText + text },
        }
      } else {
        pendingDeltas.push(delta)
      }
      if (pendingDeltaTimer === null)
        pendingDeltaTimer = window.setTimeout(flushPendingDeltas, 16)
    }

    if (generation !== connectionGeneration) {
      isConnecting = false
      invalidateSocket(socket)
      return
    }

    socket.onopen = () => {
      if (
        !isCurrentSocket({
          socket,
          currentSocket: wsRef,
          generation,
          currentGeneration: connectionGeneration,
          sessionId,
          currentSessionId: activeSessionIdRef,
        })
      ) {
        return
      }
      updateChatStore({ connectionState: "connected", runError: undefined })
      isConnecting = false
      reconnectAttempts = 0
      try {
        socket.send(
          JSON.stringify({
            type: "authenticate",
            session_id: sessionId,
            payload: { resume_active: !activeCheckpointId },
          }),
        )
      } catch {
        try { socket.close() } catch { /* the close event will schedule a new connection */ }
        return
      }
      for (const [messageId, pending] of pendingOutgoing) {
        if (pending.sessionId !== sessionId) continue
        try {
          socket.send(pending.frame)
          updateChatStore((prev) => ({
            messages: prev.messages.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    deliveryStatus: "sending",
                    deliveryDetail: undefined,
                  }
                : message,
            ),
          }))
        } catch {
          updateChatStore((prev) => ({
            messages: prev.messages.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    deliveryStatus: "uncertain",
                    deliveryDetail:
                      "Waiting for a chat connection to confirm delivery.",
                  }
                : message,
            ),
          }))
          try { socket.close() } catch { /* the close event will schedule a new connection */ }
          return
        }
      }
      for (const pending of pendingRetries.values()) {
        if (pending.sessionId !== sessionId) continue
        try {
          socket.send(pending.frame)
          updateChatStore((prev) => ({
            isTyping: true,
            messages: prev.messages.map((message) =>
              message.id === pending.userMessageId
                ? { ...message, deliveryStatus: "retrying", deliveryDetail: undefined }
                : message,
            ),
          }))
        } catch {
          updateChatStore((prev) => ({
            isTyping: true,
            messages: prev.messages.map((message) =>
              message.id === pending.userMessageId
                ? { ...message, deliveryStatus: "retrying", deliveryDetail: "Retry is safely queued until the chat connection returns." }
                : message,
            ),
          }))
          try { socket.close() } catch { /* the close event will schedule a new connection */ }
          return
        }
      }
      const currentState = getChatState()
      if (activeCheckpointId && currentState.isTyping) {
        const resumeMessage: MikiWsClientMessage = {
          type: "resume",
          session_id: sessionId,
          checkpoint_id: activeCheckpointId,
          last_sequence: activeSequence,
        }
        socket.send(JSON.stringify(resumeMessage))
      }
    }

    socket.onmessage = async (event) => {
      if (
        !isCurrentSocket({
          socket,
          currentSocket: wsRef,
          generation,
          currentGeneration: connectionGeneration,
          sessionId,
          currentSessionId: activeSessionIdRef,
        })
      ) {
        return
      }

      try {
        const raw =
          event.data instanceof Blob
            ? await event.data.text()
            : event.data instanceof ArrayBuffer
              ? new TextDecoder().decode(event.data)
              : String(event.data)
        const message = JSON.parse(raw) as MikiWsServerMessage & {
          checkpoint_id?: unknown
          sequence?: unknown
        }
        if (message.type !== "message.delta") flushPendingDeltas()
        if (message.type === "proactive.message") {
          const proactivePayload = message.payload ?? {}
          const notificationKind =
            typeof proactivePayload.notification_kind === "string"
              ? proactivePayload.notification_kind
              : ""
          // Progress and warning notices are status noise. Result and discovery
          // notices are user-facing Agent messages and belong in the transcript.
          if (notificationKind !== "result" && notificationKind !== "discovery") {
            return
          }
          handlemikiMessage(
            {
              ...message,
              type: "message.create",
              session_id: sessionId,
              payload: { ...proactivePayload, role: "assistant" },
            },
            sessionId,
          )
          return
        }
        if (message.type === "auth.ok") {
          updateChatStore({ runError: undefined })
          return
        }
        if (
          message.type === "error" &&
          typeof message.payload === "object" &&
          message.payload !== null &&
          "code" in message.payload &&
          String(message.payload.code) === "authentication_required"
        ) {
          shouldMaintainConnection = false
          clearReconnectTimer()
          updateChatStore({ connectionState: "error", isTyping: false })
          if (typeof globalThis.location !== "undefined") {
            globalThis.location.assign("/launcher-login")
          }
          return
        }
        if (
          ["message.accepted", "message.duplicate", "message.status"].includes(
            message.type,
          )
        ) {
          const payload = message.payload ?? {}
          const messageId =
            typeof payload.message_id === "string" ? payload.message_id : ""
          const clientId =
            typeof payload.client_message_id === "string"
              ? payload.client_message_id
              : ""
          const status = payload.status ?? (message.type === "message.accepted" ? "queued" : undefined)
          if (
            messageId &&
            [
              "queued",
              "processing",
              "retrying",
              "failed",
              "cancelled",
              "completed",
            ].includes(String(status))
          ) {
            pendingOutgoing.delete(clientId)
            pendingOutgoing.delete(messageId)
            const pendingRetry = pendingRetries.get(clientId)
            if (pendingRetry) {
              pendingRetries.delete(clientId)
              const deliveryStatus = ["queued", "processing", "retrying", "failed", "cancelled"].includes(String(status))
                ? (String(status) as "queued" | "processing" | "retrying" | "failed" | "cancelled")
                : undefined
              updateChatStore((prev) => ({
                messages: prev.messages.map((candidate) =>
                  candidate.id === pendingRetry.userMessageId
                    ? { ...candidate, deliveryStatus, deliveryDetail: undefined }
                    : candidate,
                ),
              }))
              if (message.type === "message.duplicate") {
                void loadSessionMessages(sessionId).then((historyMessages) => {
                  if (activeSessionIdRef !== sessionId) return
                  updateChatStore((prev) => ({ messages: hideResolvedErrors(mergeHistoryMessages(historyMessages, prev.messages)) }))
                }).catch((error) => console.warn("Could not reconcile chat after a duplicate retry:", error))
              }
            }
          }
        }
        // A rejected send must be correlated with its optimistic user bubble.
        // Otherwise the pending frame survives reconnects and is replayed even
        // when the gateway has already rejected it (for example, invalid media).
        if (message.type === "error") {
          const requestId =
            typeof message.payload?.request_id === "string"
              ? message.payload.request_id
              : ""
          if (requestId) {
            const rejectedOutgoing = pendingOutgoing.get(requestId)
            pendingOutgoing.delete(requestId)
            if (rejectedOutgoing) {
              const detail = typeof message.payload?.message === "string" ? message.payload.message : "The gateway could not accept this message."
              updateChatStore((prev) => ({
                messages: prev.messages.map((candidate) =>
                  candidate.id === requestId
                    ? { ...candidate, deliveryStatus: "failed", deliveryDetail: detail }
                    : candidate,
                ),
              }))
            }
            const pendingRetry = pendingRetries.get(requestId)
            if (pendingRetry) {
              pendingRetries.delete(requestId)
              const detail = typeof message.payload?.message === "string" ? message.payload.message : "The gateway could not accept this retry."
              updateChatStore((prev) => ({
                isTyping: Boolean(activeCheckpointId) || [...pendingRetries.values()].some((item) => item.sessionId === sessionId),
                messages: prev.messages.map((candidate) =>
                  candidate.id === pendingRetry.userMessageId
                    ? { ...candidate, deliveryStatus: "failed", deliveryDetail: detail }
                    : candidate,
                ),
              }))
            }
          }
        }
        if (message.type === "stream_gap") {
          const payload = message.payload ?? {}
          const oldest = Number(payload.oldest_buffered_sequence)
          if (Number.isFinite(oldest) && oldest > 0) activeSequence = Math.max(activeSequence, oldest - 1)
          void loadSessionMessages(sessionId).then((historyMessages) => {
            if (activeSessionIdRef !== sessionId) return
            updateChatStore((prev) => ({ messages: hideResolvedErrors(mergeHistoryMessages(historyMessages, prev.messages)) }))
          }).catch((error) => console.warn("Could not reconcile chat history after a stream gap:", error))
          return
        }
        if (
          message.type === "error" &&
          message.payload?.code === "resume_not_found"
        ) {
          const payload = message.payload
          const missingRunId = typeof payload.run_id === "string" ? payload.run_id : ""
          activeCheckpointId = null
          activeSequence = -1
          updateChatStore((prev) => {
            const runningRunIds = missingRunId
              ? prev.runningRunIds.filter((runId) => runId !== missingRunId)
              : prev.runningRunIds
            return {
              runningRunIds,
              isTyping: runningRunIds.length > 0,
              ...(runningRunIds.length === 0 ? { runStatus: "failed" as const } : {}),
            }
          })
          void loadSessionMessages(sessionId).then((historyMessages) => {
            if (activeSessionIdRef !== sessionId) return
            updateChatStore((prev) => ({ messages: hideResolvedErrors(mergeHistoryMessages(historyMessages, prev.messages)) }))
          }).catch((error) => console.warn("Could not reconcile chat history after a missing stream checkpoint:", error))
          return
        }
        if (message.type === "stream_checkpoint") {
          activeCheckpointId =
            typeof message.checkpoint_id === "string"
              ? message.checkpoint_id
              : null
          activeSequence =
            typeof message.sequence === "number" ? message.sequence : -1
          const checkpointRunId = typeof message.payload?.run_id === "string" ? message.payload.run_id : ""
          updateChatStore((prev) => ({
            isTyping: Boolean(activeCheckpointId),
            ...(checkpointRunId ? { runningRunIds: prev.runningRunIds.includes(checkpointRunId) ? prev.runningRunIds : [...prev.runningRunIds, checkpointRunId] } : {}),
          }))
          return
        }
        if (typeof message.checkpoint_id === "string") {
          activeCheckpointId = message.checkpoint_id
        }
        if (typeof message.sequence === "number") {
          activeSequence = Math.max(activeSequence, message.sequence)
        }
        if (message.type === "stream_done") {
          activeSequence =
            typeof message.sequence === "number"
              ? message.sequence
              : activeSequence
          activeCheckpointId = null
          activeSequence = -1
          const payload = message.payload ?? {}
          const runId = typeof payload.run_id === "string" ? payload.run_id : ""
          const terminalStatus = [
            "completed",
            "completed_with_warning",
            "failed",
            "cancelled",
          ].includes(String(payload.status))
            ? (String(payload.status) as
                "completed" | "completed_with_warning" | "failed" | "cancelled")
            : undefined
          updateChatStore((prev) => {
            if (!runId) return { isTyping: false }
            const runningRunIds = prev.runningRunIds.filter(
              (candidate) => candidate !== runId,
            )
            const isLastRun = runningRunIds.length === 0
            return {
              runningRunIds,
              isTyping: !isLastRun,
              runStatus: isLastRun
                ? (terminalStatus ?? prev.runStatus)
                : "running",
              ...(isLastRun
                ? {
                    runError:
                      typeof payload.error === "string"
                        ? payload.error
                        : undefined,
                  }
              : {}),
            }
          })
          // The gateway persists the final assistant message independently of
          // the live socket stream. Reconcile once at stream completion so a
          // dropped create/update event cannot make the reply appear only
          // after a full page reload.
          void loadSessionMessages(sessionId)
            .then((historyMessages) => {
              if (activeSessionIdRef !== sessionId) return
              updateChatStore((prev) => ({
                messages: hideResolvedErrors(
                  mergeHistoryMessages(historyMessages, prev.messages),
                ),
              }))
            })
            .catch((error) =>
              console.warn(
                "Could not reconcile chat history after stream completion:",
                error,
              ),
            )
          return
        }
        if (message.type === "resume") {
          return
        }
        if (message.type === "connection.ready" || message.type === "auth.ok") {
          return
        }
        if (message.type === "message.delta") {
          queueDelta(message)
        } else if (message.type?.startsWith("node.")) {
          handleMonitorMessage(message)
        } else {
          handlemikiMessage(message, sessionId)
        }
      } catch {
        console.warn("Non-JSON message from miki:", event.data)
      }
    }

    socket.onclose = () => {
      if (
        !isCurrentSocket({
          socket,
          currentSocket: wsRef,
          generation,
          currentGeneration: connectionGeneration,
          sessionId,
          currentSessionId: activeSessionIdRef,
        })
      ) {
        return
      }
      flushPendingDeltas()
      wsRef = null
      isConnecting = false
      void isGatewaySessionAuthenticated().then((authenticated) => {
        if (!authenticated) {
          updateChatStore({ connectionState: "error", isTyping: false })
          shouldMaintainConnection = false
          clearReconnectTimer()
          if (typeof globalThis.location !== "undefined") {
            globalThis.location.assign("/launcher-login")
          }
          return
        }
        updateChatStore((prev) => ({
          connectionState: "disconnected",
          isTyping: Boolean(activeCheckpointId) || [...pendingRetries.values()].some((item) => item.sessionId === sessionId),
          messages: prev.messages.map((message) => {
            const retryPending = [...pendingRetries.values()].some((item) => item.sessionId === sessionId && item.userMessageId === message.id)
            if (retryPending) {
              return { ...message, deliveryStatus: "retrying", deliveryDetail: "Retry is safely queued until the chat connection returns." }
            }
            return pendingOutgoing.has(message.id)
              ? {
                  ...message,
                  deliveryStatus: "uncertain",
                  deliveryDetail:
                    "Connection lost before the server confirmed delivery; it will be retried safely.",
                }
              : message
          }),
        }))
        scheduleReconnect(generation, sessionId)
      })
    }

    socket.onerror = () => {
      if (
        !isCurrentSocket({
          socket,
          currentSocket: wsRef,
          generation,
          currentGeneration: connectionGeneration,
          sessionId,
          currentSessionId: activeSessionIdRef,
        })
      ) {
        return
      }
      isConnecting = false
      void isGatewaySessionAuthenticated().then((authenticated) => {
        if (!authenticated) {
          updateChatStore({ connectionState: "error", isTyping: false })
          shouldMaintainConnection = false
          clearReconnectTimer()
          if (typeof globalThis.location !== "undefined") {
            globalThis.location.assign("/launcher-login")
          }
          return
        }
        updateChatStore({
          connectionState: "error",
          isTyping: Boolean(activeCheckpointId) || [...pendingRetries.values()].some((item) => item.sessionId === sessionId),
        })
        scheduleReconnect(generation, sessionId)
        try { socket.close() } catch { /* reconnect timer remains the fallback */ }
      })
    }

    wsRef = socket
  } catch (error) {
    if (generation !== connectionGeneration) {
      isConnecting = false
      return
    }
    console.error("Failed to connect to miki:", error)
    updateChatStore({ connectionState: "error" })
    isConnecting = false
    scheduleReconnect(generation, activeSessionIdRef)
  }
}

export function disconnectChat() {
  disconnectChatInternal({ clearDesiredConnection: true })
}

export async function hydrateActiveSession() {
  if (hydratePromise) {
    return hydratePromise
  }

  const state = getChatState()
  const storedSessionId = readStoredSessionId()

  const sessionId = state.activeSessionId || storedSessionId

  if (!sessionId || state.hasHydratedActiveSession) {
    if (!state.hasHydratedActiveSession) {
      updateChatStore({ hasHydratedActiveSession: true })
    }
    return
  }

  hydratePromise = loadSessionMessages(sessionId)
    .then((historyMessages) => {
      const currentState = getChatState()
      if (currentState.activeSessionId !== sessionId) {
        return
      }

      const hydratedMessages = hideResolvedErrors(
        currentState.messages.length > 0
          ? mergeHistoryMessages(historyMessages, currentState.messages)
          : historyMessages,
      )
      const identity = latestRunIdentity(hydratedMessages)
      updateChatStore({
        messages: hydratedMessages,
        isTyping: false,
        hasHydratedActiveSession: true,
        activeRunModel: identity.model,
        activeRunProvider: identity.provider,
      })
    })
    .catch((error) => {
      const isMissingStoredSession = isSessionNotFoundError(error)
      if (!isMissingStoredSession) {
        console.error("Failed to restore last session history:", error)
      }

      const currentState = getChatState()
      if (currentState.activeSessionId !== sessionId) {
        return
      }

      if (currentState.messages.length > 0) {
        const identity = latestRunIdentity(currentState.messages)
        updateChatStore({
          hasHydratedActiveSession: true,
          activeRunModel: identity.model,
          activeRunProvider: identity.provider,
        })
        return
      }

      if (storedSessionId === sessionId) {
        clearStoredSessionId()
      }
      if (isMissingStoredSession) {
        setActiveSessionId(SINGLE_CHAT_SESSION_ID)
      }
      updateChatStore({
        messages: [],
        isTyping: false,
        hasHydratedActiveSession: true,
        activeRunModel: undefined,
        activeRunProvider: undefined,
      })
    })
    .finally(() => {
      hydratePromise = null
    })

  return hydratePromise
}

interface EphemeralAudioPayload {
  data: string
  mimeType: string
  filename?: string
}

interface SendChatMessageInput {
  content: string
  attachments?: ChatAttachment[]
  requestedModel?: string
  requestedModelIndex?: number
  voice?: ChatVoiceMetadata
  audio?: EphemeralAudioPayload
  thinkingMode?: "auto" | "off" | "low" | "medium" | "high"
}

interface EditChatMessageInput {
  messageId: string
  content: string
  attachments?: ChatAttachment[]
}

function normalizeOutgoingAttachments(
  attachments: ChatAttachment[] = [],
): ChatAttachment[] {
  return attachments
    .filter((attachment) => Boolean(attachment.url))
    .map((attachment) => ({ ...attachment }))
}

function sendmikiMessage(
  requestId: string,
  content: string,
  attachments: ChatAttachment[],
  requestedModel?: string,
  requestedModelIndex?: number,
  voice?: ChatVoiceMetadata,
  audio?: EphemeralAudioPayload,
  thinkingMode?: "auto" | "off" | "low" | "medium" | "high",
): string {
  return JSON.stringify({
    type: "message.send",
    id: requestId,
    payload: {
      content,
      media: attachments.map((attachment) => attachment.url),
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((attachment) => ({
              type: attachment.type,
              url: attachment.url,
              ...(attachment.filename ? { filename: attachment.filename } : {}),
              ...(attachment.contentType
                ? { content_type: attachment.contentType }
                : {}),
            })),
          }
        : {}),
      ...(requestedModel?.trim()
        ? { requested_model: requestedModel.trim() }
        : {}),
      ...(Number.isSafeInteger(requestedModelIndex) && Number(requestedModelIndex) > 0
        ? { requested_model_index: requestedModelIndex }
        : {}),
      ...(voice ? { voice } : {}),
      ...(audio ? { audio } : {}),
      ...(thinkingMode ? { thinking_mode: thinkingMode } : {}),
    },
  })
}
export async function sendChatMessage({
  content,
  attachments = [],
  requestedModel,
  requestedModelIndex,
  voice,
  audio,
  thinkingMode = "auto",
}: SendChatMessageInput): Promise<boolean> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    console.warn("WebSocket not connected")
    return false
  }

  const normalizedContent = content.trim()
  const normalizedAttachments = normalizeOutgoingAttachments(attachments)
  if (normalizedContent.length > CHAT_INPUT_LIMITS.textCharacters) {
    notify.error(
      `Messages are limited to ${CHAT_INPUT_LIMITS.textCharacters.toLocaleString()} characters.`,
      { id: "chat:text-limit" },
    )
    return false
  }
  if (normalizedAttachments.length > CHAT_INPUT_LIMITS.attachmentCount || normalizedAttachments.some((attachment) => attachment.url.length > CHAT_INPUT_LIMITS.attachmentUrlCharacters)) {
    notify.error(
      i18n.t("chat.attachmentLimit", {
        defaultValue:
          `You can send up to ${CHAT_INPUT_LIMITS.attachmentCount} attachments at a time. Each URL must be at most ${CHAT_INPUT_LIMITS.attachmentUrlCharacters} characters.`,
      }),
      { id: "chat:attachment-limit" },
    )
    return false
  }

  if (!normalizedContent && normalizedAttachments.length === 0 && !audio) {
    return false
  }

  const socket = wsRef
  // A message sent while the agent is already working is steered into that run:
  // keep the live stream's checkpoint so the ongoing run is not disturbed.
  if (!getChatState().isTyping) {
    activeCheckpointId = null
    activeSequence = -1
  }
  const id = `msg-${++msgIdCounter}-${Date.now()}`

  updateChatStore((prev) => ({
    messages: [
      ...prev.messages,
      {
        id,
        role: "user",
        content: normalizedContent,
        attachments:
          normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
        voice: voice ? { ...voice, transcript: normalizedContent } : undefined,
        timestamp: Date.now(),
        deliveryStatus: "sending",
      },
    ],
    isTyping: true,
  }))

  try {
    const frame = sendmikiMessage(
      id,
      normalizedContent,
      normalizedAttachments,
      requestedModel,
      requestedModelIndex,
      voice,
      audio,
      thinkingMode,
    )
    pendingOutgoing.set(id, { sessionId: activeSessionIdRef, frame })
    socket.send(frame)
    return true
  } catch (error) {
    console.error("Could not confirm message send:", error)
    updateChatStore((prev) => ({
      messages: prev.messages.map((message) =>
        message.id === id
          ? {
              ...message,
              deliveryStatus: "uncertain",
              deliveryDetail:
                "Could not confirm delivery. It will be retried when chat reconnects.",
            }
          : message,
      ),
    }))
    return true
  }
}

export async function deleteChatMessage(messageId: string): Promise<boolean> {
  try {
    // The store is the source shown to the UI; prefer its active session so an
    // externally restored session cannot be deleted against a stale socket ref.
    const sessionId = getChatState().activeSessionId || activeSessionIdRef
    await deleteSessionMessage(sessionId, messageId)
    updateChatStore((prev) => ({
      messages: prev.messages.filter((message) => message.id !== messageId),
    }))
    return true
  } catch (error) {
    console.error("Failed to delete chat message:", error)
    return false
  }
}

export async function editChatMessage({
  messageId,
  content,
  attachments = [],
}: EditChatMessageInput): Promise<boolean> {
  const normalizedContent = content.trim()
  const normalizedAttachments = normalizeOutgoingAttachments(attachments)
  if (normalizedContent.length > CHAT_INPUT_LIMITS.textCharacters
    || normalizedAttachments.length > CHAT_INPUT_LIMITS.attachmentCount
    || normalizedAttachments.some((attachment) => attachment.url.length > CHAT_INPUT_LIMITS.attachmentUrlCharacters)) return false
  if (!normalizedContent && normalizedAttachments.length === 0) return false

  const state = getChatState()
  if (!state.messages.some((message) => message.id === messageId)) return false

  try {
    await updateSessionMessage(activeSessionIdRef, messageId, {
      content: normalizedContent,
      media: normalizedAttachments.map((attachment) => attachment.url),
      attachments: normalizedAttachments.map((attachment) => ({
        type: attachment.type,
        url: attachment.url,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
        ...(attachment.contentType
          ? { content_type: attachment.contentType }
          : {}),
      })),
    })
    updateChatStore((prev) => ({
      messages: prev.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: normalizedContent,
              attachments:
                normalizedAttachments.length > 0
                  ? normalizedAttachments
                  : undefined,
            }
          : message,
      ),
    }))
    return true
  } catch (error) {
    console.error("Failed to edit chat message:", error)
    return false
  }
}

export async function forkChatSessionFromMessage(
  messageId: string,
): Promise<boolean> {
  try {
    const fork = await forkSessionAtMessage(activeSessionIdRef, messageId)
    await switchChatSession(fork.session_id)
    return true
  } catch (error) {
    console.error("Failed to fork chat session:", error)
    return false
  }
}

export async function retryChatMessage(messageId: string): Promise<boolean> {
  const gatewayRunning = store.get(gatewayAtom).status === "running"
  if (!gatewayRunning) return false

  const state = getChatState()
  const targetIndex = state.messages.findIndex((message) => message.id === messageId)
  if (targetIndex < 0) return false
  const target = state.messages[targetIndex]
  const isFailedTurn = findFailedUserTurn(state.messages)?.id === messageId
  const isUnanswered = isUnansweredUserMessage(target)
  if (targetIndex !== state.messages.length - 1 && !isFailedTurn && !isUnanswered) return false

  const promptMessage = target.role === "user"
    ? target
    : state.messages.slice(0, targetIndex).reverse().find((message) => message.role === "user")
  if (!promptMessage || (!promptMessage.content.trim() && !promptMessage.attachments?.length && !promptMessage.voice?.transcript.trim())) {
    return false
  }
  const attachments = normalizeOutgoingAttachments(promptMessage.attachments)
  const requestId = `retry-${Date.now()}-${++retryRequestCounter}-${Math.random().toString(36).slice(2, 9)}`
  const frame = JSON.stringify({
    type: "message.retry",
    id: requestId,
    payload: {
      message_id: messageId,
      prompt_message_id: promptMessage.id,
      content: promptMessage.content || promptMessage.voice?.transcript || "",
      thinking_mode: store.get(thinkingModeAtom),
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((attachment) => ({
              type: attachment.type,
              url: attachment.url,
              ...(attachment.filename ? { filename: attachment.filename } : {}),
              ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
            })),
          }
        : {}),
    },
  })

  // Keep the retry until an accepted/duplicate acknowledgement arrives. If the
  // socket drops at any point, the exact same id is replayed on reconnect.
  pendingRetries.set(requestId, {
    sessionId: activeSessionIdRef,
    frame,
    targetMessageId: messageId,
    userMessageId: promptMessage.id,
  })
  activeCheckpointId = null
  activeSequence = -1
  updateChatStore((prev) => ({
    messages: target.role === "assistant"
      ? prev.messages.filter((message) => message.id !== messageId)
      : isFailedTurn
        ? prev.messages.slice(0, targetIndex + 1).map((message) =>
            message.id === promptMessage.id
              ? { ...message, deliveryStatus: "retrying" as const, deliveryDetail: undefined }
              : message,
          )
        : prev.messages.map((message) =>
            message.id === promptMessage.id
              ? { ...message, deliveryStatus: "retrying" as const, deliveryDetail: undefined }
              : message,
          ),
    isTyping: true,
  }))

  shouldMaintainConnection = true
  const socket = wsRef
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    updateChatStore((prev) => ({
      connectionState: prev.connectionState === "connected" ? "connecting" : prev.connectionState,
      messages: prev.messages.map((message) =>
        message.id === promptMessage.id
          ? { ...message, deliveryStatus: "retrying", deliveryDetail: "Retry is safely queued until the chat connection returns." }
          : message,
      ),
    }))
    void connectChat()
    return true
  }

  try {
    socket.send(frame)
    return true
  } catch (error) {
    console.warn("Retry send was interrupted; it will be replayed after reconnect:", error)
    updateChatStore((prev) => ({
      connectionState: "connecting",
      messages: prev.messages.map((message) =>
        message.id === promptMessage.id
          ? { ...message, deliveryStatus: "retrying", deliveryDetail: "Retry is safely queued until the chat connection returns." }
          : message,
      ),
    }))
    try { socket.close() } catch { void connectChat() }
    return true
  }
}

export async function switchChatSession(sessionId: string) {
  if (sessionId !== SINGLE_CHAT_SESSION_ID) {
    console.warn("Miki uses one canonical chat session; ignoring session switch:", sessionId)
    return
  }
  if (sessionId === activeSessionIdRef) {
    return
  }

  try {
    const historyMessages = await loadSessionMessages(sessionId)

    disconnectChatInternal({ clearDesiredConnection: false })
    setActiveSessionId(sessionId)
    updateChatStore({
      messages: historyMessages,
      isTyping: false,
      activeRunId: undefined,
      runningRunIds: [],
      recentRunIds: [],
      activeRunModel: undefined,
      activeRunProvider: undefined,
      runStatus: undefined,
      runError: undefined,
      deliveryOutcome: undefined,
      workStatus: undefined,
      hasHydratedActiveSession: true,
      contextUsage: undefined,
    })
    activeCheckpointId = null
    activeSequence = -1

    if (store.get(gatewayAtom).status === "running") {
      shouldMaintainConnection = true
      await connectChat()
    }
  } catch (error) {
    console.error("Failed to load session history:", error)
    notify.error(i18n.t("chat.historyOpenFailed"), { id: "chat:history-open-failed" })
  }
}

export async function newChatSession() {
  // Telegram-style conversations are intentionally single-session. A new run
  // or retry must append to the durable canonical transcript, never create a
  // second chat that can diverge after a restart.
  if (activeSessionIdRef !== SINGLE_CHAT_SESSION_ID) {
    await switchChatSession(SINGLE_CHAT_SESSION_ID)
  }
}

export async function stopChatGeneration(): Promise<boolean> {
  const state = getChatState()
  if (!state.isTyping) {
    return false
  }

  const taskId = state.activeRunId
  // Stop is terminal for the interactive turn. Do not let a reconnect replay
  // the old stream checkpoint while the server is still unwinding the abort.
  activeCheckpointId = null
  activeSequence = -1
  let cancelled = false

  if (wsRef && wsRef.readyState === WebSocket.OPEN && taskId) {
    try {
      wsRef.send(
        JSON.stringify({
          type: "cancel_task",
          task_id: taskId,
        }),
      )
      cancelled = true
    } catch (error) {
      console.error("Failed to send cancel_task over WebSocket:", error)
    }
  }

  if (taskId) {
    try {
      const { launcherFetch } = await import("@/api/http")
      const res = await launcherFetch(
        `/api/tasks/${encodeURIComponent(taskId)}`,
        { method: "DELETE", showErrorToast: false },
      )
      if (res.ok) {
        cancelled = true
      }
    } catch (error) {
      console.error("Failed to cancel task via HTTP:", error)
    }
  }

  // Optimistically end the local typing/run state so the UI unblocks even if
  // the backend already finished or the task id was not yet assigned.
  updateChatStore((prev) => ({
    runningRunIds: taskId
      ? prev.runningRunIds.filter((candidate) => candidate !== taskId)
      : prev.runningRunIds,
    isTyping: taskId
      ? prev.runningRunIds.some((candidate) => candidate !== taskId)
      : false,
    runStatus:
      taskId && prev.runningRunIds.some((candidate) => candidate !== taskId)
        ? "running"
        : prev.runStatus === "running" || prev.runStatus === "starting"
          ? "cancelled"
          : prev.runStatus,
    ...(taskId && prev.activeRunId === taskId
      ? {
          activeRunId:
            prev.runningRunIds.find((candidate) => candidate !== taskId) ??
            undefined,
        }
      : {}),
  }))

  return cancelled || !taskId
}

export function initializeChatStore() {
  if (initialized) {
    return
  }

  initialized = true
  const currentSessionId = getChatState().activeSessionId
  activeSessionIdRef = currentSessionId
  if (currentSessionId !== SINGLE_CHAT_SESSION_ID) {
    // Persist the hash-selected session after the hash is removed by the
    // store bootstrap, so reconnects keep using the shared session.
    writeStoredSessionId(currentSessionId)
  }
  let lastGatewayStatus: GatewayState | null = null

  const syncConnectionWithGateway = (force: boolean = false) => {
    const gatewayStatus = store.get(gatewayAtom).status
    if (!force && gatewayStatus === lastGatewayStatus) {
      return
    }
    lastGatewayStatus = gatewayStatus

    if (gatewayStatus === "running") {
      shouldMaintainConnection = true
      if (needsActiveSessionHydration()) {
        return
      }
      void connectChat()
      return
    }

    if (gatewayStatus === "stopped" || gatewayStatus === "error") {
      disconnectChatInternal({ clearDesiredConnection: true })
    }
  }

  store.sub(gatewayAtom, syncConnectionWithGateway)

  if (!needsActiveSessionHydration()) {
    updateChatStore({ hasHydratedActiveSession: true })
    syncConnectionWithGateway(true)
    return
  }

  void hydrateActiveSession().finally(() => {
    if (!initialized) {
      return
    }
    syncConnectionWithGateway(true)
  })
}
