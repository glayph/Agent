import { IconBrain, IconCheck, IconEye } from "@tabler/icons-react"
import { useAtomValue, useSetAtom } from "jotai"
import {
  type ChangeEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslation } from "react-i18next"
import type { SessionSummary } from "@/api/sessions"
import { uploadChatAttachment } from "@/api/chat-attachments"
import { type VoiceCloudAudioResult, transcribeVoiceAudio } from "@/api/voice"
import type { ChatInputDisabledReason } from "@/features/chat/components/chat-composer"
import { ChatInspector } from "@/features/chat/components/chat-inspector"
import { chatInspectorAtom } from "@/features/chat/components/chat-inspector-store"
import { ModelSelector } from "@/features/chat/components/model-selector"
import { SessionHistoryMenu } from "@/features/chat/components/session-history-menu"
import { ChatMessageList } from "@/features/chat/components/workspace/chat-message-list"
import { Composer } from "@/features/chat/components/workspace/composer"
import type { WorkspaceStatusPill } from "@/features/chat/components/workspace/types"
import { WorkspaceHeader } from "@/features/chat/components/workspace/workspace-header"
import { WorkspaceShell } from "@/features/chat/components/workspace/workspace-shell"
import { getRetryableMessageIds } from "@/features/chat/retryable"
import { monitorAtom } from "@/features/monitor/store"
import { useChatModels } from "@/hooks/use-chat-models"
import { useGateway } from "@/hooks/use-gateway"
import { useMikiChat } from "@/hooks/use-miki-chat"
import { useIsMobile } from "@/hooks/use-mobile"
import { useSessionHistory } from "@/hooks/use-session-history"
import { notify } from "@/lib/notify"
import { Button } from "@/shared/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu"
import type { ConnectionState } from "@/store/chat"
import type { ChatAttachment, ChatMessage } from "@/store/chat"
import { assistantDetailVisibilityAtom, thinkingModeAtom } from "@/store/chat"
import type { GatewayState } from "@/store/gateway"

const MAX_FILE_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024
const MAX_FILE_ATTACHMENT_SIZE_LABEL = "25 MB"
const MAX_TOTAL_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024
const MAX_ATTACHMENTS_PER_MESSAGE = 16
const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024
const MAX_AUDIO_SIZE_LABEL = "25 MB"
const MAX_AUDIO_DURATION_MS = 5 * 60 * 1000
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "application/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
])
const SESSION_HISTORY_REFRESH_DELAYS_MS = [500, 1800] as const


function preferredRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ]
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType))
}

function audioExtensionForMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0].toLowerCase()
  if (normalized.includes("ogg")) return "ogg"
  if (normalized.includes("mp4")) return "m4a"
  if (normalized.includes("mpeg")) return "mp3"
  if (normalized.includes("wav")) return "wav"
  if (normalized.includes("flac")) return "flac"
  return "webm"
}

function measureAudioDuration(file: Blob): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = document.createElement("audio")
    let settled = false
    const finish = (value?: number) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      audio.remove()
      resolve(value)
    }
    audio.preload = "metadata"
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration)
        ? audio.duration * 1000
        : undefined
      finish(duration)
    }
    audio.onerror = () => finish(undefined)
    window.setTimeout(() => finish(undefined), 4000)
    audio.src = url
  })
}

function resolveChatInputDisabledReason({
  hasDefaultModel,
  connectionState,
  gatewayState,
}: {
  hasDefaultModel: boolean
  connectionState: ConnectionState
  gatewayState: GatewayState
}): ChatInputDisabledReason | null {
  if (gatewayState === "unknown") {
    return "gatewayUnknown"
  }

  if (gatewayState === "starting") {
    return "gatewayStarting"
  }

  if (gatewayState === "restarting") {
    return "gatewayRestarting"
  }

  if (gatewayState === "stopping") {
    return "gatewayStopping"
  }

  if (gatewayState === "stopped") {
    return "gatewayStopped"
  }

  if (gatewayState === "error") {
    return "gatewayError"
  }

  if (connectionState === "connecting") {
    return "websocketConnecting"
  }

  if (connectionState === "error") {
    return "websocketError"
  }

  if (connectionState === "disconnected") {
    return "websocketDisconnected"
  }

  if (!hasDefaultModel) {
    return "noDefaultModel"
  }

  return null
}

function normalizePreview(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function truncatePreview(value: string, maxLength: number): string {
  const preview = normalizePreview(value)
  if (preview.length <= maxLength) {
    return preview
  }
  return `${preview.slice(0, Math.max(0, maxLength - 3))}...`
}

function timestampToIso(timestamp: ChatMessage["timestamp"] | undefined) {
  if (timestamp === undefined) {
    return new Date().toISOString()
  }

  if (typeof timestamp === "number") {
    const millis = timestamp < 1e12 ? timestamp * 1000 : timestamp
    const date = new Date(millis)
    return Number.isNaN(date.getTime())
      ? new Date().toISOString()
      : date.toISOString()
  }

  const trimmed = timestamp.trim()
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return timestampToIso(numeric)
    }
  }

  const date = new Date(trimmed)
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString()
}

// eslint-disable-next-line react-refresh/only-export-components -- kept exported for deterministic status tests
export function buildStatusPills({
  connectionState,
  gatewayState,
  isTyping,
  labels,
}: {
  connectionState: ConnectionState
  gatewayState: GatewayState
  isTyping: boolean
  labels: {
    activeAgents: (count: number) => string
    paused: string
    ready: string
    running: string
  }
}): WorkspaceStatusPill[] {
  const isOnline = gatewayState === "running" && connectionState === "connected"
  // Connectivity is not equivalent to active work. The previous implementation
  // reported one active agent whenever the socket was online, even while idle.
  const activeAgents = isTyping ? 1 : 0
  const statusLabel = isTyping
    ? labels.running
    : isOnline
      ? labels.ready
      : labels.paused

  return [
    {
      label: statusLabel,
      tone: isTyping ? "success" : isOnline ? "neutral" : "warning",
    },
    {
      label: labels.activeAgents(activeAgents),
      tone: activeAgents > 0 ? "info" : "neutral",
    },
  ]
}

function buildActiveSessionProjection({
  activeSessionId,
  fallbackSummary,
  messages,
}: {
  activeSessionId: string
  fallbackSummary: {
    attachment: string
    empty: string
  }
  messages: ChatMessage[]
}): SessionSummary | null {
  if (!activeSessionId || messages.length === 0) {
    return null
  }

  const firstVisibleMessage =
    messages.find(
      (message) => message.role === "user" && normalizePreview(message.content),
    ) ?? messages.find((message) => normalizePreview(message.content))
  const hasAttachment = messages.some(
    (message) => (message.attachments?.length ?? 0) > 0,
  )
  const summaryText =
    normalizePreview(firstVisibleMessage?.content ?? "") ||
    (hasAttachment ? fallbackSummary.attachment : fallbackSummary.empty)
  const firstMessage = messages[0]
  const lastMessage = messages[messages.length - 1]

  return {
    id: activeSessionId,
    title: truncatePreview(summaryText, 72),
    preview: truncatePreview(summaryText, 120),
    message_count: messages.length,
    created: timestampToIso(firstMessage?.timestamp),
    updated: timestampToIso(lastMessage?.timestamp),
  }
}

function mergeActiveSessionProjection(
  sessions: SessionSummary[],
  projection: SessionSummary | null,
): SessionSummary[] {
  if (!projection) {
    return sessions
  }

  const existingIndex = sessions.findIndex(
    (session) => session.id === projection.id,
  )
  if (existingIndex === -1) {
    return [projection, ...sessions]
  }

  const existingSession = sessions[existingIndex]
  const projectedSession: SessionSummary = {
    ...existingSession,
    title: normalizePreview(existingSession.title)
      ? existingSession.title
      : projection.title,
    preview: projection.preview,
    message_count: Math.max(
      existingSession.message_count,
      projection.message_count,
    ),
    updated: projection.updated,
  }
  const nextSessions = [...sessions]
  nextSessions[existingIndex] = projectedSession
  return nextSessions
}

export function ChatPage() {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderStreamRef = useRef<MediaStream | null>(null)
  const recorderChunksRef = useRef<Blob[]>([])
  const recorderStartedAtRef = useRef<number | null>(null)
  const recorderCancelledRef = useRef(false)
  const recorderMaxTimerRef = useRef<number | null>(null)
  const isAtBottomRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const historyRefreshTimersRef = useRef<number[]>([])
  const lastHistoryRefreshKeyRef = useRef("")
  const [input, setInput] = useState("")
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false)
  const [voiceState, setVoiceState] = useState<
    "idle" | "recording" | "transcribing"
  >("idle")
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const hasLoadedSessionsRef = useRef(false)
  const isMobile = useIsMobile()

  const {
    messages,
    connectionState,
    isTyping,
    activeSessionId,
    hasHydratedActiveSession,
    contextUsage,
    sendMessage,
    deleteMessage,
    editMessage,
    forkFromMessage,
    retryMessage,
    switchSession,
    newChat,
  } = useMikiChat()
  const monitorState = useAtomValue(monitorAtom)
  const setChatInspector = useSetAtom(chatInspectorAtom)
  const assistantDetailVisibility = useAtomValue(assistantDetailVisibilityAtom)
  const setAssistantDetailVisibility = useSetAtom(assistantDetailVisibilityAtom)
  const thinkingMode = useAtomValue(thinkingModeAtom)
  const setThinkingMode = useSetAtom(thinkingModeAtom)
  const liveActivityNodes = useMemo(() => {
    const messageRunIds = new Set(
      messages
        .map((message) => message.runId)
        .filter((id): id is string => Boolean(id)),
    )
    if (messageRunIds.size === 0) return []

    const latestRun = Object.values(monitorState.runs)
      .filter((run) => messageRunIds.has(run.id))
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    if (!latestRun) return []

    return Object.values(monitorState.nodes)
      .filter((node) => node.runId === latestRun.id)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(-3)
  }, [messages, monitorState.nodes, monitorState.runs])
  const retryableMessageIds = useMemo(
    () => getRetryableMessageIds(messages),
    [messages],
  )

  const {
    sessions,
    hasMore: hasMoreSessions,
    loadError: sessionHistoryLoadError,
    loadErrorMessage: sessionHistoryLoadErrorMessage,
    observerRef: sessionHistoryObserverRef,
    loadSessions,
    handleDeleteSession,
  } = useSessionHistory({
    activeSessionId,
    onDeletedActiveSession: () => {
      void newChat()
    },
  })

  useEffect(() => {
    if (hasLoadedSessionsRef.current) return

    hasLoadedSessionsRef.current = true
    void loadSessions(true)
  }, [loadSessions])

  useEffect(
    () => () => {
      historyRefreshTimersRef.current.forEach((timerId) =>
        window.clearTimeout(timerId),
      )
      historyRefreshTimersRef.current = []
    },
    [],
  )

  const scheduleSessionHistoryRefresh = useCallback(() => {
    historyRefreshTimersRef.current.forEach((timerId) =>
      window.clearTimeout(timerId),
    )
    historyRefreshTimersRef.current = []

    for (const delayMs of SESSION_HISTORY_REFRESH_DELAYS_MS) {
      const timerId = window.setTimeout(() => {
        historyRefreshTimersRef.current =
          historyRefreshTimersRef.current.filter((id) => id !== timerId)
        void loadSessions(true)
      }, delayMs)
      historyRefreshTimersRef.current.push(timerId)
    }
  }, [loadSessions])

  useEffect(() => {
    if (!activeSessionId || messages.length === 0) {
      lastHistoryRefreshKeyRef.current = ""
      return
    }

    const historyRefreshKey = `${activeSessionId}:${messages.length}`
    if (lastHistoryRefreshKeyRef.current === historyRefreshKey) {
      return
    }

    lastHistoryRefreshKeyRef.current = historyRefreshKey
    scheduleSessionHistoryRefresh()
  }, [activeSessionId, messages.length, scheduleSessionHistoryRefresh])

  const { state: gwState } = useGateway()
  const isGatewayRunning = gwState === "running"

  const {
    defaultModelName,
    defaultModelId,
    hasAvailableModels,
    hasAnyModels,
    unavailableModels,
    apiKeyModels,
    oauthModels,
    localModels,
    handleSetDefault,
  } = useChatModels({ isConnected: isGatewayRunning })
  const hasDefaultModel = Boolean(defaultModelName)
  const inputDisabledReason = resolveChatInputDisabledReason({
    hasDefaultModel,
    connectionState,
    gatewayState: gwState,
  })
  const canInput = inputDisabledReason === null
  const isEditingMessage = editingMessageId !== null

  const sendVoiceBlob = useCallback(
    async (
      blob: Blob,
      filename: string,
      source: "microphone" | "upload",
      durationMs?: number,
    ) => {
      setVoiceState("transcribing")
      try {
        const result = await transcribeVoiceAudio(
          blob,
          filename,
          durationMs,
          defaultModelId,
        )
        let sent: boolean
        if (result.mode === "local") {
          const transcript = result.transcript.trim()
          if (!transcript) {
            throw new Error("No speech was detected in the recording.")
          }
          sent = await sendMessage({
            content: transcript,
            requestedModel: defaultModelId,
            voice: {
              source,
              provider: result.provider,
              language: result.language,
              transcript,
              durationMs: result.duration_ms ?? durationMs,
              latencyMs: result.latency_ms,
              transport: result.transport,
            },
          })
        } else {
          const cloudResult = result as VoiceCloudAudioResult
          sent = await sendMessage({
            content: "",
            requestedModel: defaultModelId,
            voice: {
              source,
              provider: "cloud",
              language: cloudResult.voice.language,
              transcript: "",
              durationMs: cloudResult.voice.durationMs ?? durationMs,
              model: cloudResult.model,
              transport: "cloud",
            },
            audio: {
              data: cloudResult.audio.data,
              mimeType: cloudResult.audio.mimeType,
              filename: cloudResult.audio.filename,
            },
          })
        }
        if (!sent) {
          throw new Error("The voice message could not be sent to Agent Miki.")
        }
      } catch (error) {
        notify.error(
          error instanceof Error
            ? error.message
            : t("chat.voiceFailed", {
                defaultValue: "Voice message could not be processed.",
              }),
          { id: "chat:voice-send-failed" },
        )
      } finally {
        setVoiceState("idle")
        setVoiceElapsedMs(0)
      }
    },
    [defaultModelId, sendMessage, t],
  )

  const handleStopVoice = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder?.state === "recording") {
      recorder.stop()
    }
  }, [])

  const handleStartVoice = useCallback(async () => {
    if (!canInput || voiceState !== "idle" || isEditingMessage) return
    if (
      typeof navigator.mediaDevices?.getUserMedia !== "function" ||
      typeof MediaRecorder === "undefined"
    ) {
      notify.error(
        t("chat.voiceUnsupported", {
          defaultValue:
            "This browser does not support microphone recording. Use Upload audio instead.",
        }),
        { id: "chat:voice-unsupported" },
      )
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = preferredRecorderMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      recorderStreamRef.current = stream
      recorderChunksRef.current = []
      recorderCancelledRef.current = false
      recorderStartedAtRef.current = Date.now()
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recorderChunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop())
        recorderRef.current = null
        if (recorderMaxTimerRef.current !== null) {
          window.clearTimeout(recorderMaxTimerRef.current)
          recorderMaxTimerRef.current = null
        }
        setVoiceState("idle")
        notify.error(
          t("chat.voiceFailed", {
            defaultValue: "Voice message could not be processed.",
          }),
          { id: "chat:voice-recording-failed" },
        )
      }
      recorder.onstop = () => {
        const wasCancelled = recorderCancelledRef.current
        recorderCancelledRef.current = false
        const startedAt = recorderStartedAtRef.current
        const elapsedMs = startedAt
          ? Math.max(0, Date.now() - startedAt)
          : undefined
        const actualMimeType = recorder.mimeType || mimeType || "audio/webm"
        const blob = new Blob(recorderChunksRef.current, {
          type: actualMimeType,
        })
        recorderChunksRef.current = []
        recorderRef.current = null
        recorderStreamRef.current = null
        if (recorderMaxTimerRef.current !== null) {
          window.clearTimeout(recorderMaxTimerRef.current)
          recorderMaxTimerRef.current = null
        }
        stream.getTracks().forEach((track) => track.stop())
        if (!wasCancelled) {
          void sendVoiceBlob(
            blob,
            `voice-${Date.now()}.${audioExtensionForMimeType(actualMimeType)}`,
            "microphone",
            elapsedMs,
          )
        }
      }
      recorder.start()
      setVoiceElapsedMs(0)
      setVoiceState("recording")
      recorderMaxTimerRef.current = window.setTimeout(() => {
        if (recorderRef.current?.state === "recording")
          recorderRef.current.stop()
      }, MAX_AUDIO_DURATION_MS)
    } catch {
      recorderStreamRef.current?.getTracks().forEach((track) => track.stop())
      recorderStreamRef.current = null
      recorderRef.current = null
      notify.error(
        t("chat.voicePermissionDenied", {
          defaultValue: "Microphone access was not granted.",
        }),
        { id: "chat:voice-permission-denied" },
      )
    }
  }, [canInput, isEditingMessage, sendVoiceBlob, t, voiceState])

  const handleAddAudio = useCallback(() => {
    if (!canInput || isEditingMessage || voiceState !== "idle") return
    audioInputRef.current?.click()
  }, [canInput, isEditingMessage, voiceState])

  const handleAudioSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ""
      if (!file) return
      if (
        !ALLOWED_AUDIO_TYPES.has(file.type) &&
        !/\.(wav|mp3|m4a|mp4|ogg|oga|webm|flac)$/i.test(file.name)
      ) {
        notify.error(
          t("chat.invalidAudio", {
            defaultValue:
              "Choose a WAV, MP3, M4A, OGG, WebM, or FLAC audio file.",
          }),
          { id: "chat:invalid-audio" },
        )
        return
      }
      if (file.size > MAX_AUDIO_SIZE_BYTES) {
        notify.error(
          t("chat.audioTooLarge", {
            defaultValue: "Audio must be {{size}} or smaller.",
            size: MAX_AUDIO_SIZE_LABEL,
          }),
          { id: `chat:audio-too-large:${file.name}` },
        )
        return
      }
      const durationMs = await measureAudioDuration(file)
      if (durationMs !== undefined && durationMs > MAX_AUDIO_DURATION_MS) {
        notify.error(
          t("chat.audioTooLong", {
            defaultValue:
              "Voice messages must be {{seconds}} seconds or shorter.",
            seconds: Math.floor(MAX_AUDIO_DURATION_MS / 1000),
          }),
          { id: "chat:audio-too-long" },
        )
        return
      }
      await sendVoiceBlob(file, file.name, "upload", durationMs)
    },
    [sendVoiceBlob, t],
  )

  useEffect(() => {
    if (voiceState !== "recording") return
    const timer = window.setInterval(() => {
      const startedAt = recorderStartedAtRef.current
      setVoiceElapsedMs(startedAt ? Math.max(0, Date.now() - startedAt) : 0)
    }, 250)
    return () => window.clearInterval(timer)
  }, [voiceState])

  useEffect(
    () => () => {
      if (recorderMaxTimerRef.current !== null) {
        window.clearTimeout(recorderMaxTimerRef.current)
      }
      if (recorderRef.current?.state === "recording") {
        recorderCancelledRef.current = true
        recorderRef.current.stop()
      }
      recorderStreamRef.current?.getTracks().forEach((track) => track.stop())
    },
    [],
  )

  useEffect(() => {
    if (!editingMessageId) {
      return
    }

    if (messages.some((message) => message.id === editingMessageId)) {
      return
    }

    setEditingMessageId(null)
    setInput("")
    setAttachments([])
  }, [editingMessageId, messages])

  const syncScrollState = useCallback((element: HTMLDivElement) => {
    const { clientHeight, scrollHeight, scrollTop } = element
    isAtBottomRef.current = scrollHeight - scrollTop <= clientHeight + 10
  }, [])

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget
      if (scrollFrameRef.current !== null) return

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null
        syncScrollState(element)
      })
    },
    [syncScrollState],
  )

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (scrollRef.current) {
      if (messages.length === 0 && !isTyping) {
        syncScrollState(scrollRef.current)
        return
      }

      if (isAtBottomRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      syncScrollState(scrollRef.current)
    }
  }, [messages, isTyping, syncScrollState])

  const handleSend = async () => {
    if (
      voiceState !== "idle" ||
      isUploadingAttachments ||
      (!input.trim() && attachments.length === 0) ||
      (!isEditingMessage && !canInput)
    ) {
      return
    }

    if (editingMessageId) {
      if (
        await editMessage({
          messageId: editingMessageId,
          content: input,
          attachments,
        })
      ) {
        setInput("")
        setAttachments([])
        setEditingMessageId(null)
        return
      }

      notify.error(
        t("chat.actions.editUnavailable", {
          defaultValue: "Message no longer exists.",
        }),
        { id: "chat:edit-unavailable" },
      )
      return
    }

    if (
      await sendMessage({
        content: input,
        attachments,
        requestedModel: defaultModelId,
      })
    ) {
      setInput("")
      setAttachments([])
    }
  }

  const handleAddImages = () => {
    if (!canInput && !isEditingMessage) return
    fileInputRef.current?.click()
  }

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index))
  }

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      const composerInput = document.querySelector<HTMLTextAreaElement>(
        'textarea[name="message"]',
      )
      composerInput?.focus()
      composerInput?.setSelectionRange(
        composerInput.value.length,
        composerInput.value.length,
      )
    })
  }, [])

  const handleEditMessage = useCallback(
    (message: ChatMessage) => {
      setEditingMessageId(message.id)
      setInput(message.content)
      setAttachments(
        message.attachments?.filter((attachment) => attachment.url) ?? [],
      )
      focusComposer()
    },
    [focusComposer],
  )

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null)
    setInput("")
    setAttachments([])
    focusComposer()
  }, [focusComposer])

  const handleRetryMessage = useCallback(
    async (messageId: string) => {
      try {
        if (await retryMessage(messageId)) {
          return
        }
      } catch (error) {
        notify.error(
          t("chat.actions.retryError", {
            defaultValue:
              error instanceof Error
                ? error.message
                : "Connect chat before retrying",
          }),
          { id: `chat:retry-error:${messageId}` },
        )
        return
      }

      notify.error(
        t("chat.actions.retryUnavailable", {
          defaultValue: "Unable to retry this message",
        }),
        { id: `chat:retry-unavailable:${messageId}` },
      )
    },
    [retryMessage, t],
  )

  const handleFileSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (files.length === 0) return

    const availableSlots = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - attachments.length)
    if (availableSlots === 0) {
      notify.error(
        t("chat.attachmentLimit", { defaultValue: "You can attach up to 16 files to one message." }),
        { id: "chat:attachment-limit" },
      )
      return
    }
    if (files.length > availableSlots) {
      notify.error(
        t("chat.attachmentSlots", {
          count: availableSlots,
          defaultValue: `Only ${availableSlots} more file(s) can be attached.`,
        }),
        { id: "chat:attachment-slots" },
      )
    }

    let totalBytes = attachments.reduce(
      (sum, attachment) => sum + (attachment.sizeBytes ?? 0),
      0,
    )
    setIsUploadingAttachments(true)
    try {
      for (const file of files.slice(0, availableSlots)) {
        if (file.size > MAX_FILE_ATTACHMENT_SIZE_BYTES) {
          notify.error(
            t("chat.imageTooLarge", {
              name: file.name,
              size: MAX_FILE_ATTACHMENT_SIZE_LABEL,
            }),
            { id: `chat:attachment-too-large:${file.name}` },
          )
          continue
        }
        if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
          notify.error(
            t("chat.attachmentTotalTooLarge", { defaultValue: "Attachments must total 100 MB or less per message." }),
            { id: "chat:attachment-total-too-large" },
          )
          continue
        }

        try {
          const uploaded = await uploadChatAttachment(file)
          setAttachments((previous) =>
            [...previous, uploaded].slice(0, MAX_ATTACHMENTS_PER_MESSAGE),
          )
          totalBytes += file.size
        } catch (error) {
          notify.error(
            t("chat.attachmentUploadFailed", {
              name: file.name,
              defaultValue: error instanceof Error ? error.message : `Could not upload ${file.name}.`,
            }),
            { id: `chat:attachment-upload-failed:${file.name}` },
          )
        }
      }
    } finally {
      setIsUploadingAttachments(false)
    }
  }

  const canSubmit =
    !isUploadingAttachments &&
    (canInput || isEditingMessage) &&
    (Boolean(input.trim()) || attachments.length > 0)
  const activeSessionProjection = useMemo(
    () =>
      buildActiveSessionProjection({
        activeSessionId,
        fallbackSummary: {
          attachment: t("chat.workspace.attachmentConversation"),
          empty: t("chat.workspace.newConversation"),
        },
        messages,
      }),
    [activeSessionId, messages, t],
  )
  const displaySessions = useMemo(
    () => mergeActiveSessionProjection(sessions, activeSessionProjection),
    [activeSessionProjection, sessions],
  )
  const handleForkMessage = useCallback(
    async (messageId: string) => {
      if (!(await forkFromMessage(messageId))) {
        notify.error(
          t("chat.actions.forkUnavailable", {
            defaultValue: "Unable to fork this conversation",
          }),
          { id: `chat:fork-unavailable:${messageId}` },
        )
      }
    },
    [forkFromMessage, t],
  )

  const handleInspectMessage = useCallback(
    (messageId: string) => {
      if (!activeSessionId) return
      setChatInspector({
        chatId: activeSessionId,
        messageId,
        page: "outputs",
      })
    },
    [activeSessionId, setChatInspector],
  )

  const handleModeClick = useCallback(() => {
    window.dispatchEvent(new Event("Miki:command"))
  }, [])

  const headerControls = (
    <div className="flex items-center gap-2">
      <SessionHistoryMenu
        sessions={displaySessions}
        activeSessionId={activeSessionId}
        hasMore={hasMoreSessions}
        loadError={sessionHistoryLoadError}
        loadErrorMessage={sessionHistoryLoadErrorMessage}
        observerRef={sessionHistoryObserverRef}
        onOpenChange={(open) => {
          if (open) void loadSessions(true)
        }}
        onSwitchSession={(sessionId) => {
          void switchSession(sessionId)
        }}
        onDeleteSession={handleDeleteSession}
        compact={isMobile}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground size-8 px-0"
            aria-label={t("chat.thinkingMenuTitle", {
              defaultValue: "Thinking",
            })}
            title={t("chat.thinkingMenuTitle", { defaultValue: "Thinking" })}
          >
            <IconBrain className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-56">
          <div className="text-muted-foreground px-2 py-1.5 text-[11px] font-medium">
            {t("chat.thinkingMenuTitle", { defaultValue: "Thinking" })}
          </div>
          {(["auto", "low", "medium", "high", "off"] as const).map((option) => (
            <DropdownMenuItem
              key={option}
              onSelect={() => setThinkingMode(option)}
              className="gap-2"
            >
              <span className="flex size-4 items-center justify-center">
                {thinkingMode === option && (
                  <IconCheck className="size-3.5" aria-hidden="true" />
                )}
              </span>
              <span>
                {t(`chat.thinkingMode.${option}`, {
                  defaultValue: option[0].toUpperCase() + option.slice(1),
                })}
              </span>
            </DropdownMenuItem>
          ))}
          <div className="border-border my-1 border-t" />
          <div className="text-muted-foreground flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium">
            <IconEye className="size-3.5" />
            {t("chat.assistantDetailMenuTitle", { defaultValue: "Display" })}
          </div>
          {(["none", "thought", "tool_calls", "all"] as const).map((option) => (
            <DropdownMenuItem
              key={option}
              onSelect={() => setAssistantDetailVisibility(option)}
              className="gap-2"
            >
              <span className="flex size-4 items-center justify-center">
                {assistantDetailVisibility === option && (
                  <IconCheck className="size-3.5" aria-hidden="true" />
                )}
              </span>
              <span>
                {t(
                  `chat.assistantDetailVisibility.${option === "tool_calls" ? "toolCalls" : option}`,
                  {
                    defaultValue:
                      option === "none"
                        ? "Hide details"
                        : option === "thought"
                          ? "Reasoning"
                          : option === "tool_calls"
                            ? "Tool calls"
                            : "All details",
                  },
                )}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {(hasAvailableModels || hasAnyModels) && (
        <ModelSelector
          defaultModelName={defaultModelName}
          apiKeyModels={apiKeyModels}
          oauthModels={oauthModels}
          localModels={localModels}
          unavailableModels={unavailableModels}
          onValueChange={handleSetDefault}
          compact={isMobile}
        />
      )}
    </div>
  )

  return (
    <div className="bg-background h-full min-h-0" data-miki-page="chat">
      <WorkspaceShell
        header={
          <WorkspaceHeader
            title="Miki"
            statuses={[]}
            controls={headerControls}
            isWorking={isTyping}
          />
        }

        activityStream={
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <ChatMessageList
                messages={messages}
                isTyping={isTyping}
                hasHydratedActiveSession={hasHydratedActiveSession}
                isGatewayRunning={isGatewayRunning}
                hasAvailableModels={hasAvailableModels}
                defaultModelName={defaultModelName}
                connectionState={connectionState}
                retryableMessageIds={retryableMessageIds}
                scrollRef={scrollRef}
                onScroll={handleScroll}
                onEditMessage={handleEditMessage}
                onDeleteMessage={deleteMessage}
                onForkMessage={handleForkMessage}
                onRetryMessage={handleRetryMessage}
                onInspectMessage={handleInspectMessage}
              />
            </div>
          </div>
        }
        composer={
          <Composer
            input={input}
            attachments={attachments}
            onInputChange={setInput}
            onAddImages={handleAddImages}
            onAddAudio={handleAddAudio}
            onStartVoice={handleStartVoice}
            onStopVoice={handleStopVoice}
            voiceState={voiceState}
            voiceElapsedMs={voiceElapsedMs}
            onModeClick={handleModeClick}
            onRemoveAttachment={handleRemoveAttachment}
            onSend={handleSend}
            isWorking={isTyping}
            isEditing={isEditingMessage}
            onCancelEdit={handleCancelEdit}
            modeLabel={t("chat.workspace.mode")}
            inputDisabledReason={isEditingMessage ? null : inputDisabledReason}
            canSend={canSubmit && voiceState === "idle"}
            contextUsage={contextUsage}
          />
        }
      />

      <ChatInspector
        chatId={activeSessionId}
        messages={messages}
        isWorking={isTyping}
        liveActivityNodes={liveActivityNodes}
      />

      <input
        ref={fileInputRef}
        type="file"
        aria-label={t("chat.attachImage")}
        accept="image/*,video/*,audio/*,application/pdf,text/*,.md,.txt,.csv,.json,.xml,.html,.css,.sh,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.7z,.rtf,.odt,.ods,.odp,.py,.js,.jsx,.ts,.tsx,.go,.rs,.java,.c,.cpp,.h,.yaml,.yml,.toml,.ini,.log"
        multiple
        className="hidden"
        onChange={handleFileSelection}
      />
      <input
        ref={audioInputRef}
        type="file"
        aria-label={t("chat.attachAudio", { defaultValue: "Upload audio" })}
        accept="audio/wav,audio/mpeg,audio/mp4,audio/ogg,audio/webm,audio/flac,.m4a,.mp3,.wav,.ogg,.webm,.flac"
        className="hidden"
        onChange={handleAudioSelection}
      />
    </div>
  )
}
