import { getDefaultStore } from "jotai"
import { toast } from "sonner"

import {
  type PlatformProvider,
  completeConnectionFromOpaqueToken,
  listPlatforms,
  startBrowserPlatformConnection,
} from "@/api/automations"
import {
  deleteSessionMessage,
  forkSessionAtMessage,
  isSessionNotFoundError,
  retrySessionFromMessage,
  updateSessionMessage,
} from "@/api/sessions"
import {
  loadSessionMessages,
  mergeHistoryMessages,
} from "@/features/chat/history"
import { handlemikiMessage, type mikiMessage } from "@/features/chat/protocol"
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
  type ChatVoiceMetadata,
  getChatState,
  updateChatStore,
} from "@/store/chat"
import { type GatewayState, gatewayAtom } from "@/store/gateway"

const store = getDefaultStore()

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

function needsActiveSessionHydration(): boolean {
  const state = getChatState()
  const storedSessionId = readStoredSessionId()
  const hasExplicitSession = state.activeSessionId !== SINGLE_CHAT_SESSION_ID

  return Boolean(
    !state.hasHydratedActiveSession &&
    ((hasExplicitSession && state.activeSessionId) ||
      (storedSessionId && storedSessionId === state.activeSessionId)),
  )
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
      const currentState = getChatState()
      if (activeCheckpointId && currentState.isTyping) {
        socket.send(
          JSON.stringify({
            type: "resume",
            session_id: sessionId,
            checkpoint_id: activeCheckpointId,
            last_sequence: activeSequence,
          }),
        )
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
        const message = JSON.parse(raw) as mikiMessage & {
          checkpoint_id?: unknown
          sequence?: unknown
        }
        if (message.type === "stream_checkpoint") {
          activeCheckpointId =
            typeof message.checkpoint_id === "string"
              ? message.checkpoint_id
              : null
          activeSequence =
            typeof message.sequence === "number" ? message.sequence : -1
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
          updateChatStore({ isTyping: false })
          return
        }
        if (message.type === "resume") {
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
      updateChatStore({
        connectionState: "disconnected",
        isTyping: false,
      })
      scheduleReconnect(generation, sessionId)
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
      updateChatStore({ connectionState: "error" })
      scheduleReconnect(generation, sessionId)
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

  if (
    !storedSessionId ||
    state.hasHydratedActiveSession ||
    storedSessionId !== state.activeSessionId
  ) {
    if (!state.hasHydratedActiveSession) {
      updateChatStore({ hasHydratedActiveSession: true })
    }
    return
  }

  hydratePromise = loadSessionMessages(storedSessionId)
    .then((historyMessages) => {
      const currentState = getChatState()
      if (currentState.activeSessionId !== storedSessionId) {
        return
      }

      if (currentState.messages.length > 0) {
        updateChatStore({
          messages: mergeHistoryMessages(
            historyMessages,
            currentState.messages,
          ),
          hasHydratedActiveSession: true,
        })
        return
      }

      updateChatStore({
        messages: historyMessages,
        isTyping: false,
        hasHydratedActiveSession: true,
      })
    })
    .catch((error) => {
      const isMissingStoredSession = isSessionNotFoundError(error)
      if (!isMissingStoredSession) {
        console.error("Failed to restore last session history:", error)
      }

      const currentState = getChatState()
      if (currentState.activeSessionId !== storedSessionId) {
        return
      }

      if (currentState.messages.length > 0) {
        updateChatStore({ hasHydratedActiveSession: true })
        return
      }

      clearStoredSessionId()
      if (isMissingStoredSession) {
        setActiveSessionId(SINGLE_CHAT_SESSION_ID)
      }
      updateChatStore({
        messages: [],
        isTyping: false,
        hasHydratedActiveSession: true,
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
  voice?: ChatVoiceMetadata
  audio?: EphemeralAudioPayload
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
    .filter((attachment) => attachment.type === "image" && attachment.url)
    .map((attachment) => ({ ...attachment }))
}

function sendmikiMessage(
  socket: WebSocket,
  requestId: string,
  content: string,
  attachments: ChatAttachment[],
  voice?: ChatVoiceMetadata,
  audio?: EphemeralAudioPayload,
) {
  socket.send(
    JSON.stringify({
      type: "message.send",
      id: requestId,
      payload: {
        content,
        media: attachments.map((attachment) => attachment.url),
        ...(voice ? { voice } : {}),
        ...(audio ? { audio } : {}),
      },
    }),
  )
}

const PROVIDER_ALIASES: Array<{
  provider: PlatformProvider
  aliases: string[]
}> = [
  { provider: "facebook", aliases: ["facebook", "fb", "ফেসবুক"] },
  { provider: "youtube", aliases: ["youtube", "yt", "ইউটিউব"] },
  { provider: "x", aliases: ["twitter", "x.com", " x ", "টুইটার"] },
  { provider: "telegram", aliases: ["telegram", "tg", "টেলিগ্রাম"] },
  { provider: "whatsapp", aliases: ["whatsapp", "wa", "হোয়াটসঅ্যাপ"] },
  { provider: "instagram", aliases: ["instagram", "ig", "ইনস্টাগ্রাম"] },
  { provider: "linkedin", aliases: ["linkedin", "লিংকডইন"] },
  { provider: "discord", aliases: ["discord"] },
  { provider: "slack", aliases: ["slack"] },
  { provider: "webhook", aliases: ["webhook", "ওয়েবহুক"] },
]

function detectPlatform(content: string): PlatformProvider | null {
  const normalized = ` ${content.toLowerCase()} `
  for (const item of PROVIDER_ALIASES) {
    if (item.aliases.some((alias) => normalized.includes(alias))) {
      return item.provider
    }
  }
  return null
}

function extractPlatformToken(content: string): string | null {
  const match = content.match(
    /(?:token|api\s*key|access\s*token|bot\s*token|টোকেন|এপিআই\s*কি)\s*(?:is|হলো|হচ্ছে|:|=)?\s*(?:["'`]([^"'`]+)["'`]|([A-Za-z0-9._~+/=-]{8,}))/i,
  )
  const token = match?.[1] ?? match?.[2]
  return token?.trim() || null
}

export function isPlatformConnectionIntent(content: string): boolean {
  // Only explicit connection/setup actions should leave Chat. Informational
  // questions such as "what is a Telegram bot token?" must be answered by
  // the agent rather than being intercepted as credential setup.
  return /(?:connect|সংযোগ|কানেক্ট|যোগ|link|লিংক|setup|সেটআপ|configure|কনফিগার|authorize|অনুমতি|integrat|ইন্টিগ্রেট)/i.test(
    content,
  )
}

async function handlePlatformConnectionIntent(
  content: string,
): Promise<boolean | null> {
  if (!isPlatformConnectionIntent(content)) return null
  const provider = detectPlatform(content)
  if (!provider) return null

  const token = extractPlatformToken(content)
  if (token) {
    try {
      const platforms = await listPlatforms()
      const descriptor = platforms.platforms.find(
        (item) => item.id === provider,
      )
      const result = await completeConnectionFromOpaqueToken(
        provider,
        `${descriptor?.label ?? provider} account`,
        token,
        descriptor?.requiredScopes,
      )
      toast.success(
        `${descriptor?.label ?? provider} token stored securely. Connection requires validation before external actions.`,
      )
      void result
      return true
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Platform token could not be stored securely.",
      )
      return false
    }
  }

  const popup =
    typeof window !== "undefined"
      ? window.open("about:blank", "_blank", "popup,width=960,height=760")
      : null
  if (!popup) {
    toast.error(
      "The browser popup was blocked. Open Automation Center → Connections and try again.",
    )
    return false
  }
  try {
    const result = await startBrowserPlatformConnection(provider)
    popup.location.href = result.browser.url
    toast.success(
      `${provider} official setup opened. Complete login and consent in the browser, then finish the connection in Connections.`,
    )
    return true
  } catch (error) {
    popup?.close()
    toast.error(
      error instanceof Error
        ? error.message
        : "Could not start the official browser setup.",
    )
    return false
  }
}

export async function sendChatMessage({
  content,
  attachments = [],
  voice,
  audio,
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

  if (normalizedContent && normalizedAttachments.length === 0) {
    const connectionResult =
      await handlePlatformConnectionIntent(normalizedContent)
    if (connectionResult !== null) {
      return connectionResult
    }
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
      voice,
      audio,
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
  try {
    const retry = await retrySessionFromMessage(activeSessionIdRef, messageId)
    await switchChatSession(retry.session_id)
    const attachments = (retry.message.image_urls ?? []).map((url) => ({
      type: "image" as const,
      url,
    }))
    return sendChatMessage({
      content: retry.message.content,
      attachments,
    })
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
      hasHydratedActiveSession: true,
      contextUsage: undefined,
    })

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
  if (getChatState().messages.length === 0) {
    return
  }

  disconnectChatInternal({ clearDesiredConnection: false })
  const nextSessionId = crypto.randomUUID()
  setActiveSessionId(nextSessionId)
  writeStoredSessionId(nextSessionId)
  updateChatStore({
    messages: [],
    isTyping: false,
    hasHydratedActiveSession: true,
    contextUsage: undefined,
  })

  if (store.get(gatewayAtom).status === "running") {
    shouldMaintainConnection = true
    await connectChat()
  }
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
