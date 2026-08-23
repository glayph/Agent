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
import { toast } from "sonner"

import type { SessionSummary } from "@/api/sessions"
import { type VoiceCloudAudioResult, transcribeVoiceAudio } from "@/api/voice"
import type { ChatInputDisabledReason } from "@/features/chat/components/chat-composer"
import { ChatInspector } from "@/features/chat/components/chat-inspector"
import { openChatInspectorAtom } from "@/features/chat/components/chat-inspector-store"
import { ModelSelector } from "@/features/chat/components/model-selector"
import { PursueGoalPanel } from "@/features/chat/components/pursue-goal-panel"
import { ChatMessageList } from "@/features/chat/components/workspace/chat-message-list"
import { Composer } from "@/features/chat/components/workspace/composer"
import type { WorkspaceStatusPill } from "@/features/chat/components/workspace/types"
import { WorkspaceHeader } from "@/features/chat/components/workspace/workspace-header"
import { WorkspaceShell } from "@/features/chat/components/workspace/workspace-shell"
import {
  type MonitorNode,
  monitorAtom,
  selectMonitorNode,
} from "@/features/monitor/store"
import { useChatModels } from "@/hooks/use-chat-models"
import { useGateway } from "@/hooks/use-gateway"
import { useMikiChat } from "@/hooks/use-miki-chat"
import { useIsMobile } from "@/hooks/use-mobile"
import { useSessionHistory } from "@/hooks/use-session-history"
import type { ConnectionState } from "@/store/chat"
import type { ChatAttachment, ChatMessage } from "@/store/chat"
import type { GatewayState } from "@/store/gateway"

const MAX_IMAGE_SIZE_BYTES = 7 * 1024 * 1024
const MAX_IMAGE_SIZE_LABEL = "7 MB"
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
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
])

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result)
        return
      }
      reject(new Error("file_read_failed"))
    }
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"))
    reader.readAsDataURL(file)
  })
}

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

function messageHasRetryPrompt(message: ChatMessage): boolean {
  return (
    message.role === "user" &&
    (message.content.trim().length > 0 ||
      Boolean(
        message.attachments?.some(
          (attachment) => attachment.type === "image" && attachment.url,
        ),
      ))
  )
}

function getRetryableMessageIds(messages: ChatMessage[]): Set<string> {
  const retryableMessageIds = new Set<string>()
  let hasPrompt = false

  for (const message of messages) {
    if (messageHasRetryPrompt(message)) {
      hasPrompt = true
    }

    if (hasPrompt) {
      retryableMessageIds.add(message.id)
    }
  }

  return retryableMessageIds
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

function workspaceTitle({
  activeSessionTitle,
  fallbackTitle,
  messages,
}: {
  activeSessionTitle?: string
  fallbackTitle: string
  messages: ChatMessage[]
}): string {
  const title = normalizePreview(activeSessionTitle ?? "")
  if (title) return title

  const firstUserPrompt = messages.find((message) => message.role === "user")
  const promptTitle = normalizePreview(firstUserPrompt?.content ?? "")
  if (promptTitle) {
    return promptTitle.length > 72
      ? `${promptTitle.slice(0, 69)}...`
      : promptTitle
  }

  return fallbackTitle
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
  const [voiceState, setVoiceState] = useState<
    "idle" | "recording" | "transcribing"
  >("idle")
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [goalShortcutOpen, setGoalShortcutOpen] = useState(false)
  const hasLoadedSessionsRef = useRef(false)
  const isMobile = useIsMobile()
  const openInspector = useSetAtom(openChatInspectorAtom)

  const {
    messages,
    connectionState,
    isTyping,
    activeSessionId,
    contextUsage,
    sendMessage,
    deleteMessage,
    editMessage,
    forkFromMessage,
    retryMessage,
    newChat,
  } = useMikiChat()
  const monitorState = useAtomValue(monitorAtom)
  const liveActivityNodes = useMemo(() => {
    const latestRun = Object.values(monitorState.runs).sort(
      (a, b) => b.startedAt - a.startedAt,
    )[0]
    if (!latestRun) return []
    return Object.values(monitorState.nodes)
      .filter((node) => node.runId === latestRun.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3)
      .reverse()
  }, [monitorState.nodes, monitorState.runs])
  const handleInspectMessage = useCallback(
    (messageId: string) => {
      openInspector({ chatId: activeSessionId, messageId, page: "response" })
    },
    [activeSessionId, openInspector],
  )
  const handleWorkingClick = useCallback(() => {
    openInspector({ chatId: activeSessionId, page: "overview" })
  }, [activeSessionId, openInspector])
  const handleActivitySelect = useCallback(
    (node: MonitorNode) => {
      selectMonitorNode(node.id)
      openInspector({
        chatId: activeSessionId,
        runId: node.runId,
        nodeId: node.id,
        page: "work",
      })
    },
    [activeSessionId, openInspector],
  )
  const retryableMessageIds = useMemo(
    () => getRetryableMessageIds(messages),
    [messages],
  )

  useEffect(() => {
    if (!monitorState.selectedNodeId) return
    const timeoutId = window.setTimeout(() => {
      selectMonitorNode(undefined)
    }, 2600)
    return () => window.clearTimeout(timeoutId)
  }, [monitorState.selectedNodeId])
  const { sessions, loadSessions } = useSessionHistory({
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
    hasAvailableModels,
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
          defaultModelName,
        )
        let sent: boolean
        if (result.mode === "local") {
          const transcript = result.transcript.trim()
          if (!transcript) {
            throw new Error("No speech was detected in the recording.")
          }
          sent = await sendMessage({
            content: transcript,
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
        toast.error(
          error instanceof Error
            ? error.message
            : t("chat.voiceFailed", {
                defaultValue: "Voice message could not be processed.",
              }),
        )
      } finally {
        setVoiceState("idle")
        setVoiceElapsedMs(0)
      }
    },
    [defaultModelName, sendMessage, t],
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
      toast.error(
        t("chat.voiceUnsupported", {
          defaultValue:
            "This browser does not support microphone recording. Use Upload audio instead.",
        }),
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
        toast.error(
          t("chat.voiceFailed", {
            defaultValue: "Voice message could not be processed.",
          }),
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
      toast.error(
        t("chat.voicePermissionDenied", {
          defaultValue: "Microphone access was not granted.",
        }),
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
        toast.error(
          t("chat.invalidAudio", {
            defaultValue:
              "Choose a WAV, MP3, M4A, OGG, WebM, or FLAC audio file.",
          }),
        )
        return
      }
      if (file.size > MAX_AUDIO_SIZE_BYTES) {
        toast.error(
          t("chat.audioTooLarge", {
            defaultValue: "Audio must be {{size}} or smaller.",
            size: MAX_AUDIO_SIZE_LABEL,
          }),
        )
        return
      }
      const durationMs = await measureAudioDuration(file)
      if (durationMs !== undefined && durationMs > MAX_AUDIO_DURATION_MS) {
        toast.error(
          t("chat.audioTooLong", {
            defaultValue:
              "Voice messages must be {{seconds}} seconds or shorter.",
            seconds: Math.floor(MAX_AUDIO_DURATION_MS / 1000),
          }),
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
      (!input.trim() && attachments.length === 0) ||
      (!isEditingMessage && !canInput)
    ) {
      return
    }

    if (!editingMessageId && input.trim().toLowerCase() === "/goal") {
      setInput("")
      setAttachments([])
      setGoalShortcutOpen(true)
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

      toast.error(
        t("chat.actions.editUnavailable", {
          defaultValue: "Message no longer exists.",
        }),
      )
      return
    }

    if (
      await sendMessage({
        content: input,
        attachments,
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
        message.attachments?.filter(
          (attachment) => attachment.type === "image" && attachment.url,
        ) ?? [],
      )
      focusComposer()
    },
    [focusComposer],
  )

  const handleRetryMessage = useCallback(
    async (messageId: string) => {
      try {
        if (await retryMessage(messageId)) {
          return
        }
      } catch (error) {
        toast.error(
          t("chat.actions.retryError", {
            defaultValue:
              error instanceof Error
                ? error.message
                : "Connect chat before retrying",
          }),
        )
        return
      }

      toast.error(
        t("chat.actions.retryUnavailable", {
          defaultValue: "Unable to retry this message",
        }),
      )
    },
    [retryMessage, t],
  )

  const handleImageSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).slice(0, 1)
    event.target.value = ""

    if (files.length === 0) {
      return
    }

    const nextAttachments: ChatAttachment[] = []
    for (const file of files) {
      if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
        toast.error(
          t("chat.invalidImage", {
            name: file.name,
          }),
        )
        continue
      }

      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        toast.error(
          t("chat.imageTooLarge", {
            name: file.name,
            size: MAX_IMAGE_SIZE_LABEL,
          }),
        )
        continue
      }

      try {
        nextAttachments.push({
          type: "image",
          filename: file.name,
          url: await readFileAsDataUrl(file),
        })
      } catch {
        toast.error(
          t("chat.imageReadFailed", {
            name: file.name,
          }),
        )
      }
    }

    if (nextAttachments.length > 0) {
      setAttachments(nextAttachments.slice(0, 1))
    }
  }

  const canSubmit =
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
  const activeSession = useMemo(
    () => displaySessions.find((session) => session.id === activeSessionId),
    [activeSessionId, displaySessions],
  )
  const title = useMemo(
    () =>
      workspaceTitle({
        activeSessionTitle: activeSession?.title,
        fallbackTitle: t("chat.workspace.title"),
        messages,
      }),
    [activeSession?.title, messages, t],
  )
  const subtitle = activeSession
    ? t("chat.workspace.messagesSubtitle", {
        count: activeSession.message_count,
      })
    : t("chat.workspace.eventsSubtitle", { count: messages.length })
  const statusPills = useMemo(
    () =>
      buildStatusPills({
        connectionState,
        gatewayState: gwState,
        isTyping,
        labels: {
          activeAgents: (count) => t("chat.workspace.activeAgents", { count }),
          paused: t("chat.workspace.paused"),
          ready: t("chat.workspace.ready"),
          running: t("chat.workspace.running"),
        },
      }).map((status, index) =>
        index === 0 ? { ...status, onClick: handleWorkingClick } : status,
      ),
    [connectionState, gwState, handleWorkingClick, isTyping, t],
  )
  const handleForkMessage = useCallback(
    async (messageId: string) => {
      if (!(await forkFromMessage(messageId))) {
        toast.error(
          t("chat.actions.forkUnavailable", {
            defaultValue: "Unable to fork this conversation",
          }),
        )
      }
    },
    [forkFromMessage, t],
  )

  const handleModeClick = useCallback(() => {
    window.dispatchEvent(new Event("Miki:command"))
  }, [])

  const headerControls = (
    <>
      {hasAvailableModels && (
        <ModelSelector
          defaultModelName={defaultModelName}
          apiKeyModels={apiKeyModels}
          oauthModels={oauthModels}
          localModels={localModels}
          onValueChange={handleSetDefault}
          compact={isMobile}
        />
      )}
    </>
  )

  return (
    <div className="bg-background h-full min-h-0">
      <WorkspaceShell
        header={
          <WorkspaceHeader
            title={title}
            subtitle={subtitle}
            statuses={statusPills}
            controls={headerControls}
          />
        }

        activityStream={
          <ChatMessageList
            messages={messages}
            assistantDetailVisibility="none"
            isTyping={isTyping}
            isGatewayRunning={isGatewayRunning}
            hasAvailableModels={hasAvailableModels}
            defaultModelName={defaultModelName}
            connectionState={connectionState}
            retryableMessageIds={retryableMessageIds}
            liveActivityNodes={liveActivityNodes}
            selectedActivityNodeId={monitorState.selectedNodeId}
            onActivitySelect={handleActivitySelect}
            scrollRef={scrollRef}
            onScroll={handleScroll}
            onEditMessage={handleEditMessage}
            onDeleteMessage={deleteMessage}
            onForkMessage={handleForkMessage}
            onRetryMessage={handleRetryMessage}
            onInspectMessage={handleInspectMessage}
          />
        }
        composer={
          <>
            <PursueGoalPanel
              autoOpen={goalShortcutOpen}
              onAutoOpenConsumed={() => setGoalShortcutOpen(false)}
            />
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
              modeLabel={t("chat.workspace.mode")}
              inputDisabledReason={
                isEditingMessage ? null : inputDisabledReason
              }
              canSend={canSubmit && voiceState === "idle"}
              contextUsage={contextUsage}
            />
          </>
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
        accept="image/jpeg,image/png,image/gif,image/webp,image/bmp"
        className="hidden"
        onChange={handleImageSelection}
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
