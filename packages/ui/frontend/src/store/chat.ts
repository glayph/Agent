import { atom, getDefaultStore } from "jotai"
import { atomWithStorage } from "jotai/utils"

import {
  ASSISTANT_DETAIL_VISIBILITY_STORAGE_KEY,
  type AssistantDetailVisibility,
  DEFAULT_ASSISTANT_DETAIL_VISIBILITY,
  DEFAULT_THINKING_MODE,
  THINKING_MODE_STORAGE_KEY,
  type ThinkingMode,
  assistantDetailVisibilityStorage,
  shouldShowAssistantMessage,
  thinkingModeStorage,
} from "@/features/chat/detail-visibility"
import {
  clearSessionIdFromHash,
  getInitialActiveSessionId,
  writeStoredSessionId,
} from "@/features/chat/state"

export interface ChatAttachment {
  type: "image" | "audio" | "video" | "file"
  url: string
  filename?: string
  contentType?: string
  /** Local UI metadata; the gateway does not need this value. */
  sizeBytes?: number
}

export interface ChatVoiceMetadata {
  source: "microphone" | "upload" | "channel"
  provider: "whisper.cpp" | "cloud"
  language: string
  transcript: string
  durationMs?: number
  latencyMs?: number
  model?: string
  transport?: "endpoint" | "cli" | "cloud"
}

export interface ChatToolCallFunction {
  name?: string
  arguments?: string
}

export interface ChatToolCallExtraContent {
  toolFeedbackExplanation?: string
}

export type ChatToolCallStatus = "running" | "success" | "error"

export interface ChatToolCall {
  id?: string
  type?: string
  function?: ChatToolCallFunction
  extraContent?: ChatToolCallExtraContent
  /** Only set when the gateway reported it; never inferred. */
  status?: ChatToolCallStatus
  /** Only set when the gateway reported a real measured duration. */
  durationMs?: number
}

export type AssistantMessageKind =
  "normal" | "thought" | "tool_calls" | "action_update" | "error"

export type AssistantThoughtCategory =
  "Plan" | "Action" | "Verification" | "Progress" | "Decision" | "Thought"

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: number | string
  kind?: AssistantMessageKind
  modelName?: string
  runId?: string
  /** Set for background notices: progress, result, warning or discovery. */
  notificationKind?: string
  replyToMessageId?: string
  messageGroupId?: string
  messageSequence?: number
  messageTotal?: number
  messageStrategy?: "single" | "chunked" | "streaming" | "progressive"
  thoughtCategory?: AssistantThoughtCategory
  inspectorOnly?: boolean
  attachments?: ChatAttachment[]
  voice?: ChatVoiceMetadata
  toolCalls?: ChatToolCall[]
  /** Delivery state of a user message; completed is the default and omitted. */
  deliveryStatus?: ChatDeliveryStatus
  deliveryDetail?: string
}

export type ChatDeliveryStatus =
  | "sending"
  | "uncertain"
  | "unknown"
  | "queued"
  | "processing"
  | "retrying"
  | "failed"
  | "cancelled"

export interface ContextUsage {
  used_tokens: number
  total_tokens: number
  compress_at_tokens: number
  used_percent: number
}

export type ConnectionState =
  "disconnected" | "connecting" | "connected" | "error"

export type RunStatus =
  | "starting"
  | "running"
  | "completed"
  | "completed_with_warning"
  | "failed"
  | "cancelled"

export type DeliveryOutcomeStatus =
  | "created"
  | "waiting_approval"
  | "approved"
  | "sending"
  | "sent"
  | "failed"
  | "unknown_outcome"
  | "dead_letter"
  | "reconciliation_required"

export interface DeliveryOutcome {
  runId: string
  stepId?: string
  deliveryId?: string
  status: DeliveryOutcomeStatus
  provider?: string
  model?: string
  artifactRefs: string[]
  verification?: Record<string, unknown>
  approval?: {
    required: boolean
    requestId?: string
    action?: string
    risk?: string
    previewHash?: string
    consumed?: boolean
  }
  warnings: string[]
  nextAction?: string
  correlationId: string
}

/** Live view of what a running turn is waiting on (from the gateway's run.heartbeat events). */
export interface RunActivity {
  runId: string
  elapsedSeconds: number
  idleSeconds: number
  activity: "model" | "writing" | "tool" | "approval"
  activitySeconds: number
  label?: string
  turn: number
  /** Local clock when the heartbeat arrived; used to keep the counters ticking between beats. */
  receivedAt: number
}

/** Ephemeral acknowledgment shown after a run starts but before assistant output arrives. */
export interface WorkStatus {
  messageId: string
  runId: string
}

export interface ChatStoreState {
  messages: ChatMessage[]
  connectionState: ConnectionState
  isTyping: boolean
  activeSessionId: string
  hasHydratedActiveSession: boolean
  contextUsage?: ContextUsage
  activeRunId?: string
  runningRunIds: string[]
  recentRunIds?: string[]
  activeRunModel?: string
  activeRunProvider?: string
  runStatus?: RunStatus
  runError?: string
  /** Transient provider quota notice; cleared after the next successful response. */
  quotaNotice?: string
  deliveryOutcome?: DeliveryOutcome
  runActivity?: RunActivity
  workStatus?: WorkStatus
}

type ChatStorePatch = Partial<ChatStoreState>

const DEFAULT_CHAT_STATE: ChatStoreState = {
  messages: [],
  connectionState: "disconnected",
  isTyping: false,
  runningRunIds: [],
  activeSessionId: getInitialActiveSessionId(),
  hasHydratedActiveSession: false,
}

export const chatAtom = atom<ChatStoreState>(DEFAULT_CHAT_STATE)
export const assistantDetailVisibilityAtom =
  atomWithStorage<AssistantDetailVisibility>(
    ASSISTANT_DETAIL_VISIBILITY_STORAGE_KEY,
    DEFAULT_ASSISTANT_DETAIL_VISIBILITY,
    assistantDetailVisibilityStorage,
    { getOnInit: true },
  )
export const showAssistantDetailsAtom = atom(
  (get) => get(assistantDetailVisibilityAtom) !== "none",
)

export const thinkingModeAtom = atomWithStorage<ThinkingMode>(
  THINKING_MODE_STORAGE_KEY,
  DEFAULT_THINKING_MODE,
  thinkingModeStorage,
  { getOnInit: true },
)

const store = getDefaultStore()

if (typeof window !== "undefined") {
  clearSessionIdFromHash()
}

export function getChatState() {
  return store.get(chatAtom)
}

export function updateChatStore(
  patch:
    | ChatStorePatch
    | ((prev: ChatStoreState) => ChatStorePatch | ChatStoreState),
) {
  store.set(chatAtom, (prev) => {
    const nextPatch = typeof patch === "function" ? patch(prev) : patch
    const next = { ...prev, ...nextPatch }

    if (next.activeSessionId !== prev.activeSessionId) {
      writeStoredSessionId(next.activeSessionId)
    }

    return next
  })
}

export { shouldShowAssistantMessage, DEFAULT_ASSISTANT_DETAIL_VISIBILITY }
export type { AssistantDetailVisibility }
