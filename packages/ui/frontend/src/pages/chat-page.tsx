import {
  IconBrain,
  IconEyeOff,
  IconSparkles,
  IconTool,
} from "@tabler/icons-react"
import { useAtom } from "jotai"
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
import type { ChatInputDisabledReason } from "@/features/chat/components/chat-composer"
import { ModelSelector } from "@/features/chat/components/model-selector"
import { AssetPanel } from "@/features/chat/components/workspace/asset-panel"
import { ChatMessageList } from "@/features/chat/components/workspace/chat-message-list"
import { Composer } from "@/features/chat/components/workspace/composer"
import { ContextPanel } from "@/features/chat/components/workspace/context-panel"
import { Sidebar as WorkspaceSidebar } from "@/features/chat/components/workspace/sidebar"
import type {
  ContextSummaryItem,
  WorkspaceAsset,
  WorkspaceStatusPill,
} from "@/features/chat/components/workspace/types"
import { WorkspaceHeader } from "@/features/chat/components/workspace/workspace-header"
import { WorkspaceShell } from "@/features/chat/components/workspace/workspace-shell"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/shared/ui/select"
import { useChatModels } from "@/hooks/use-chat-models"
import { useGateway } from "@/hooks/use-gateway"
import { useIsMobile } from "@/hooks/use-mobile"
import { useHiroChat } from "@/hooks/use-hiro-chat"
import { useSessionHistory } from "@/hooks/use-session-history"
import type { AssistantDetailVisibility } from "@/store/chat"
import type { ConnectionState } from "@/store/chat"
import type { ChatAttachment, ChatMessage } from "@/store/chat"
import { assistantDetailVisibilityAtom } from "@/store/chat"
import type { GatewayState } from "@/store/gateway"

const MAX_IMAGE_SIZE_BYTES = 7 * 1024 * 1024
const MAX_IMAGE_SIZE_LABEL = "7 MB"
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

function buildStatusPills({
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
    running: string
  }
}): WorkspaceStatusPill[] {
  const isOnline = gatewayState === "running" && connectionState === "connected"
  const activeAgents = isOnline ? 1 : 0

  return [
    {
      label: isTyping ? labels.running : labels.paused,
      tone: isTyping ? "success" : "warning",
    },
    {
      label: labels.activeAgents(activeAgents),
      tone: activeAgents > 0 ? "info" : "neutral",
    },
  ]
}

function extensionForAttachment(attachment: ChatAttachment): string {
  const filename = attachment.filename?.toLowerCase() ?? ""
  const dotIndex = filename.lastIndexOf(".")
  return dotIndex >= 0 ? filename.slice(dotIndex) : ""
}

function inferAssetKind(attachment: ChatAttachment): WorkspaceAsset["kind"] {
  const extension = extensionForAttachment(attachment)
  if (attachment.type === "image") return "chart"
  if (extension === ".csv" || extension === ".tsv") return "csv"
  if (
    extension === ".doc" ||
    extension === ".docx" ||
    extension === ".pdf" ||
    extension === ".rtf"
  ) {
    return "document"
  }
  if (
    extension === ".md" ||
    extension === ".markdown" ||
    extension === ".txt"
  ) {
    return "report"
  }
  return "file"
}

function buildWorkspaceAssets({
  messages,
  sourceLabels,
}: {
  messages: ChatMessage[]
  sourceLabels: {
    agent: string
    tool: string
  }
}): WorkspaceAsset[] {
  const assets: WorkspaceAsset[] = []

  messages.forEach((message) => {
    if (message.role !== "assistant") return

    message.attachments?.forEach((attachment, index) => {
      if (!attachment.url) return

      const filename =
        attachment.filename ||
        `${attachment.type || "asset"}-${assets.length + index + 1}`

      assets.push({
        id: `${message.id}-${index}-${filename}`,
        filename,
        kind: inferAssetKind(attachment),
        url: attachment.url,
        sourceLabel:
          message.kind === "tool_calls"
            ? sourceLabels.tool
            : sourceLabels.agent,
      })
    })
  })

  return assets
}

function collectActiveTools(messages: ChatMessage[]): string[] {
  const toolNames = new Set<string>()

  messages.forEach((message) => {
    message.toolCalls?.forEach((toolCall) => {
      const toolName = toolCall.function?.name?.trim()
      if (toolName) toolNames.add(toolName)
    })
  })

  return Array.from(toolNames).slice(0, 12)
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
  const isAtBottomRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const historyRefreshTimersRef = useRef<number[]>([])
  const lastHistoryRefreshKeyRef = useRef("")
  const [input, setInput] = useState("")
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [assistantDetailVisibility, setAssistantDetailVisibility] = useAtom(
    assistantDetailVisibilityAtom,
  )
  const hasLoadedSessionsRef = useRef(false)
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(false)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const isMobile = useIsMobile()

  const assistantDetailVisibilityOptions = useMemo<
    Array<{
      value: AssistantDetailVisibility
      label: string
    }>
  >(
    () => [
      { value: "none", label: t("chat.assistantDetailVisibility.none") },
      {
        value: "thought",
        label: t("chat.assistantDetailVisibility.thought"),
      },
      {
        value: "tool_calls",
        label: t("chat.assistantDetailVisibility.toolCalls"),
      },
      { value: "all", label: t("chat.assistantDetailVisibility.all") },
    ],
    [t],
  )

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
    switchSession,
    newChat,
  } = useHiroChat()
  const retryableMessageIds = useMemo(
    () => getRetryableMessageIds(messages),
    [messages],
  )
  const hasAssistantDetailMessages = useMemo(
    () =>
      messages.some(
        (message) =>
          message.role === "assistant" &&
          (message.kind === "thought" || message.kind === "tool_calls"),
      ),
    [messages],
  )
  const assistantDetailControlLabel = hasAssistantDetailMessages
    ? t("chat.showAssistantDetails")
    : t("chat.noAssistantDetailsAvailable", {
        defaultValue: "No reasoning or tool calls available",
      })

  const {
    sessions,
    hasMore,
    loadError,
    loadErrorMessage,
    observerRef,
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

  const handleSend = () => {
    if (
      (!input.trim() && attachments.length === 0) ||
      (!isEditingMessage && !canInput)
    ) {
      return
    }

    if (editingMessageId) {
      if (
        editMessage({
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
      sendMessage({
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
        message.attachments
          ?.filter(
            (attachment) => attachment.type === "image" && attachment.url,
          ) ?? [],
      )
      focusComposer()
    },
    [focusComposer],
  )

  const handleRetryMessage = useCallback(
    (messageId: string) => {
      try {
        if (retryMessage(messageId)) {
          return
        }
      } catch (error) {
        toast.error(
          t("chat.actions.retryError", {
            defaultValue: error instanceof Error ? error.message : "Connect chat before retrying",
          }),
        )
        return
      }

      toast.error(
        t("chat.actions.retryUnavailable", {
          defaultValue: "Connect chat before retrying",
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
          running: t("chat.workspace.running"),
        },
      }),
    [connectionState, gwState, isTyping, t],
  )
  const workspaceAssets = useMemo(
    () =>
      buildWorkspaceAssets({
        messages,
        sourceLabels: {
          agent: t("chat.assets.source.agent"),
          tool: t("chat.assets.source.tool"),
        },
      }),
    [messages, t],
  )
  const activeTools = useMemo(() => collectActiveTools(messages), [messages])
  const assistantDetailLabel =
    assistantDetailVisibilityOptions.find(
      (option) => option.value === assistantDetailVisibility,
    )?.label ?? assistantDetailVisibility
  const contextSummaries = useMemo<ContextSummaryItem[]>(
    () => [
      { label: t("chat.workspace.messages"), value: messages.length },
      { label: t("chat.workspace.assets"), value: workspaceAssets.length },
      { label: t("chat.workspace.detailView"), value: assistantDetailLabel },
    ],
    [assistantDetailLabel, messages.length, t, workspaceAssets.length],
  )
  const metadata = useMemo<ContextSummaryItem[]>(
    () => [
      {
        label: t("chat.workspace.model"),
        value: defaultModelName || t("chat.workspace.notSelected"),
      },
      { label: t("chat.workspace.gateway"), value: gwState },
      { label: t("chat.workspace.connection"), value: connectionState },
      {
        label: t("chat.workspace.session"),
        value: activeSessionId
          ? activeSessionId.slice(0, 8)
          : t("chat.workspace.draft"),
      },
    ],
    [activeSessionId, connectionState, defaultModelName, gwState, t],
  )

  const handleNewSession = useCallback(() => {
    void newChat()
    setLeftSidebarOpen(false)
  }, [newChat])

  const handleSwitchSession = useCallback(
    (sessionId: string) => {
      void switchSession(sessionId)
    },
    [switchSession],
  )

  const handleForkMessage = useCallback(
    (messageId: string) => {
      void forkFromMessage(messageId)
    },
    [forkFromMessage],
  )

  const handleModeClick = useCallback(() => {
    window.dispatchEvent(new Event("Hiro:command"))
  }, [])

  const handleDeleteAsset = useCallback(
    (asset: WorkspaceAsset) => {
      toast.info(t("chat.assets.removed", { name: asset.filename }))
    },
    [t],
  )

  const [rightPanelTab, setRightPanelTab] = useState<
    "assets" | "context"
  >("assets")

  const handleContextDetail = useCallback(() => {
    setRightPanelTab("context")
    setRightPanelOpen(true)
  }, [])

  const renderSidebar = (onClose?: () => void) => (
    <WorkspaceSidebar
      sessions={displaySessions}
      activeSessionId={activeSessionId}
      hasMore={hasMore}
      loadError={loadError}
      loadErrorMessage={loadErrorMessage}
      observerRef={observerRef}
      onNewSession={handleNewSession}
      onSwitchSession={handleSwitchSession}
      onDeleteSession={handleDeleteSession}
      onClose={onClose}
    />
  )

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

      <Select
        value={assistantDetailVisibility}
        disabled={!hasAssistantDetailMessages}
        onValueChange={(value) =>
          setAssistantDetailVisibility(value as AssistantDetailVisibility)
        }
      >
        <SelectTrigger
          size="sm"
          aria-label={assistantDetailControlLabel}
          title={assistantDetailControlLabel}
          className="text-muted-foreground hover:text-foreground hover:bg-accent/25 size-8 min-w-8 shrink-0 justify-center border-transparent bg-transparent p-0 text-[13px] shadow-none focus-visible:border-transparent focus-visible:ring-0 [&>svg:last-child]:hidden"
        >
          {hasAssistantDetailMessages &&
          assistantDetailVisibility === "none" ? (
            <IconEyeOff className="size-4" />
          ) : hasAssistantDetailMessages &&
            assistantDetailVisibility === "thought" ? (
            <IconBrain className="size-4" />
          ) : hasAssistantDetailMessages &&
            assistantDetailVisibility === "tool_calls" ? (
            <IconTool className="size-4" />
          ) : (
            <IconSparkles className="size-4" />
          )}
        </SelectTrigger>
        <SelectContent align="end">
          {assistantDetailVisibilityOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  )

  const contextPanel = (
    <ContextPanel
      activeTools={activeTools}
      summaries={contextSummaries}
      memoryUsage={contextUsage}
      metadata={metadata}
    />
  )

  return (
    <div className="bg-background h-full min-h-0">
      <WorkspaceShell
        sidebar={renderSidebar()}
        mobileSidebar={renderSidebar(() => setLeftSidebarOpen(false))}
        leftSidebarOpen={leftSidebarOpen}
        rightPanelOpen={rightPanelOpen}
        isMobile={isMobile}
        onLeftSidebarOpenChange={setLeftSidebarOpen}
        onRightPanelOpenChange={setRightPanelOpen}
        header={
          <WorkspaceHeader
            title={title}
            subtitle={subtitle}
            statuses={statusPills}
            controls={headerControls}
            rightPanelOpen={rightPanelOpen}
            onOpenSidebar={() => setLeftSidebarOpen(true)}
            onToggleRightPanel={() => setRightPanelOpen((open) => !open)}
          />
        }
        activityStream={
          <ChatMessageList
            messages={messages}
            assistantDetailVisibility={assistantDetailVisibility}
            isTyping={isTyping}
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
          />
        }
        composer={
          <Composer
            input={input}
            attachments={attachments}
            onInputChange={setInput}
            onAddImages={handleAddImages}
            onModeClick={handleModeClick}
            onRemoveAttachment={handleRemoveAttachment}
            onSend={handleSend}
            onContextDetail={handleContextDetail}
            modeLabel={t("chat.workspace.mode")}
            inputDisabledReason={
              isEditingMessage ? null : inputDisabledReason
            }
            canSend={canSubmit}
            contextUsage={contextUsage}
          />
        }
        rightPanel={
          <AssetPanel
            assets={workspaceAssets}
            contextPanel={contextPanel}
            activeTab={rightPanelTab}
            onActiveTabChange={setRightPanelTab}
            onClose={() => setRightPanelOpen(false)}
            onDeleteAsset={handleDeleteAsset}
          />
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        aria-label={t("chat.attachImage")}
        accept="image/jpeg,image/png,image/gif,image/webp,image/bmp"
        className="hidden"
        onChange={handleImageSelection}
      />
    </div>
  )
}
