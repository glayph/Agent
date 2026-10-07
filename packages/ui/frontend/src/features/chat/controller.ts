import { getDefaultStore } from "jotai"
import { toast } from "sonner"

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
  handlemikiMessage,
  type MikiWsClientMessage,
  type MikiWsServerMessage,
} from "@/features/chat/protocol"
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

let wsRef: WebSocket | null = null
let isConnecting = false
let msgIdCounter = 0
let activeSessionIdRef = getChatState().activeSessionId
let initialized = false
let unsubscribeGateway: (() => void) | null = null
let hydratePromise: Promise<void> | null = null
let connectionGeneration = 0
let reconnectTimer: number | null = null
let reconnectAttempts = 0
let shouldMaintainConnection = false
let activeCheckpointId: string | null = null
let activeSequence = -1

let customWsFactory: ((url: string) => WebSocket) | null = null

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
      updateChatStore({ connectionState: "connected" })
      isConnecting = false
      reconnectAttempts = 0
      socket.send(JSON.stringify({ type: "authenticate", session_id: sessionId }))
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
        if (message.type === "proactive.message") {
          const payload = message.payload || {}
          const content = typeof payload.content === "string" ? payload.content.trim() : ""
          const messageId = typeof payload.message_id === "string" ? payload.message_id : `proactive-${Date.now()}`
          if (content) {
            updateChatStore((prev) => ({
              messages: prev.messages.some((candidate) => candidate.id === messageId)
                ? prev.messages
                : [...prev.messages, { id: messageId, role: "assistant" as const, content, kind: "normal" as const, ...(typeof payload.run_id === "string" ? { runId: payload.run_id } : {}), timestamp: message.timestamp ?? Date.now() }],
            }))
          }
          return
        }
        if (message.type === "auth.ok") {
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
        if (message.type === "stream_checkpoint") {
          activeCheckpointId =
            typeof message.checkpoint_id === "string"
              ? message.checkpoint_id
              : null
          activeSequence =
            typeof message.sequence === "number" ? message.sequence : -1
          updateChatStore({ isTyping: Boolean(activeCheckpointId) })
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
            ? (String(payload.status) as "completed" | "completed_with_warning" | "failed" | "cancelled")
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
                ? terminalStatus ?? prev.runStatus
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
          return
        }
        if (message.type === "resume") {
          return
        }
        if (message.type === "connection.ready" || message.type === "auth.ok") {
          return
        }
        if (message.type?.startsWith("node.")) {
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
        updateChatStore({ connectionState: "disconnected", isTyping: Boolean(activeCheckpointId) })
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
        updateChatStore({ connectionState: "error", isTyping: Boolean(activeCheckpointId) })
        scheduleReconnect(generation, sessionId)
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

      const hydratedMessages =
        currentState.messages.length > 0
          ? mergeHistoryMessages(historyMessages, currentState.messages)
          : historyMessages
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
    .slice(0, 16)
    .map((attachment) => ({ ...attachment }))
}

function sendmikiMessage(
  socket: WebSocket,
  requestId: string,
  content: string,
  attachments: ChatAttachment[],
  requestedModel?: string,
  voice?: ChatVoiceMetadata,
  audio?: EphemeralAudioPayload,
  thinkingMode?: "auto" | "off" | "low" | "medium" | "high",
) {
  socket.send(
    JSON.stringify({
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
        ...(voice ? { voice } : {}),
        ...(audio ? { audio } : {}),
        ...(thinkingMode ? { thinking_mode: thinkingMode } : {}),
      },
    }),
  )
}

export async function sendChatMessage({
  content,
  attachments = [],
  requestedModel,
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

  if (!normalizedContent && normalizedAttachments.length === 0 && !audio) {
    return false
  }

  const socket = wsRef
  activeCheckpointId = null
  activeSequence = -1
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
      },
    ],
    isTyping: true,
  }))

  try {
    sendmikiMessage(
      socket,
      id,
      normalizedContent,
      normalizedAttachments,
      requestedModel,
      voice,
      audio,
      thinkingMode,
    )
    return true
  } catch (error) {
    console.error("Failed to send miki message:", error)
    updateChatStore((prev) => ({
      messages: prev.messages.filter((message) => message.id !== id),
      isTyping: false,
    }))
    return false
  }
}

export async function deleteChatMessage(messageId: string): Promise<boolean> {
  try {
    await deleteSessionMessage(activeSessionIdRef, messageId)
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
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) return false
  const state = getChatState()
  const targetIndex = state.messages.findIndex((message) => message.id === messageId)
  if (targetIndex < 0 || targetIndex !== state.messages.length - 1) return false
  const target = state.messages[targetIndex]
  const promptMessage =
    target.role === "user"
      ? target
      : state.messages
          .slice(0, targetIndex)
          .reverse()
          .find((message) => message.role === "user")
  const attachments = normalizeOutgoingAttachments(promptMessage?.attachments)
  activeCheckpointId = null
  activeSequence = -1
  try {
    wsRef.send(
      JSON.stringify({
        type: "message.retry",
        id: messageId,
        payload: {
          message_id: messageId,
          thinking_mode: store.get(thinkingModeAtom),
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
        },
      }),
    )
    updateChatStore((prev) => ({
      messages:
        target.role === "assistant"
          ? prev.messages.filter((message) => message.id !== messageId)
          : prev.messages,
      isTyping: true,
    }))
    return true
  } catch (error) {
    console.error("Failed to retry chat message:", error)
    return false
  }
}

export async function switchChatSession(sessionId: string) {
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
    toast.error(i18n.t("chat.historyOpenFailed"))
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
    runStatus: taskId && prev.runningRunIds.some((candidate) => candidate !== taskId)
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

  unsubscribeGateway = store.sub(gatewayAtom, syncConnectionWithGateway)

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

export function teardownChatStore() {
  unsubscribeGateway?.()
  unsubscribeGateway = null
  initialized = false
  disconnectChat()
}
