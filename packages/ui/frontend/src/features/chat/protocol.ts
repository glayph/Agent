import { toast } from "sonner"

import {
  parseAssistantMessageCreateState,
  parseAssistantMessageUpdateState,
} from "@/features/chat/assistant-message-state"
import { normalizeUnixTimestamp } from "@/features/chat/state"
import {
  type AssistantThoughtCategory,
  type ChatAttachment,
  type ChatMessage,
  type ContextUsage,
  type DeliveryOutcome,
  type DeliveryOutcomeStatus,
  type RunStatus,
  getChatState,
  updateChatStore,
} from "@/store/chat"

export interface mikiMessage {
  type: string
  id?: string
  session_id?: string
  timestamp?: number | string
  payload?: Record<string, unknown>
}

export type MikiWsClientMessage =
  | { type: "authenticate"; session_id: string }
  | {
      type: "resume"
      session_id: string
      checkpoint_id: string
      last_sequence: number
    }
  | {
      type: "message.send"
      id: string
      payload: Record<string, unknown>
    }
  | {
      type: "message.retry"
      id: string
      payload: Record<string, unknown>
    }
  | { type: "cancel_task"; task_id: string }

export interface MikiWsServerMessage extends mikiMessage {
  checkpoint_id?: string
  sequence?: number
}

function parseAttachments(
  payload: Record<string, unknown>,
): ChatAttachment[] | undefined {
  const raw = payload.attachments
  if (!Array.isArray(raw)) {
    return undefined
  }

  const attachments: ChatAttachment[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue
    }

    const attachment = item as Record<string, unknown>
    const url = typeof attachment.url === "string" ? attachment.url : ""
    if (!url) {
      continue
    }

    const type =
      attachment.type === "audio" ||
      attachment.type === "video" ||
      attachment.type === "file" ||
      attachment.type === "image"
        ? attachment.type
        : "file"

    const filename =
      typeof attachment.filename === "string" ? attachment.filename : undefined
    const contentType =
      typeof attachment.content_type === "string"
        ? attachment.content_type
        : undefined

    attachments.push({
      type,
      url,
      ...(filename ? { filename } : {}),
      ...(contentType ? { contentType } : {}),
    })
  }

  return attachments
}

function providerForModel(modelName: string | undefined): string | undefined {
  if (!modelName) return undefined
  const normalized = modelName.trim()
  const separator = normalized.indexOf("/")
  return separator > 0 ? normalized.slice(0, separator) : undefined
}

function isStaleRun(
  activeRunId: string | undefined,
  runStatus: string | undefined,
  eventRunId: string | undefined,
  runningRunIds: string[] = [],
): boolean {
  if (!eventRunId) return false
  if (activeRunId === eventRunId) return false
  return Boolean(activeRunId && (runStatus === "running" || runningRunIds.includes(eventRunId)))
}

function isUnscopedWhileRunning(
  activeRunId: string | undefined,
  runStatus: string | undefined,
  eventRunId: string | undefined,
  runningRunIds: string[] = [],
): boolean {
  return !eventRunId && Boolean(runningRunIds.length || (activeRunId && runStatus === "running"))
}

function parseContextUsage(
  payload: Record<string, unknown>,
): ContextUsage | undefined {
  const raw = payload.context_usage
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as Record<string, unknown>
  const used = Number(obj.used_tokens)
  const total = Number(obj.total_tokens)
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0)
    return undefined
  return {
    used_tokens: used,
    total_tokens: total,
    compress_at_tokens: Number(obj.compress_at_tokens) || 0,
    used_percent: Number(obj.used_percent) || 0,
  }
}

function parseRunId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.run_id !== "string") return undefined
  const runId = payload.run_id.trim()
  return runId || undefined
}

function parseThoughtCategory(
  payload: Record<string, unknown>,
): AssistantThoughtCategory | undefined {
  const value =
    typeof payload.thought_category === "string"
      ? payload.thought_category.trim()
      : ""
  return [
    "Plan",
    "Action",
    "Verification",
    "Progress",
    "Decision",
    "Thought",
  ].includes(value)
    ? (value as AssistantThoughtCategory)
    : undefined
}

function parseModelName(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.model_name !== "string") {
    return undefined
  }
  const modelName = payload.model_name.trim()
  return modelName || undefined
}

export function handlemikiMessage(
  message: mikiMessage,
  expectedSessionId: string,
) {
  if (message.session_id && message.session_id !== expectedSessionId) {
    return
  }

  const payload = message.payload || {}

  switch (message.type) {
    case "message.create":
    case "media.create": {
      const messageId = (payload.message_id as string) || `miki-${Date.now()}`
      const { content, kind, toolCalls } =
        parseAssistantMessageCreateState(payload)
      const attachments = parseAttachments(payload)
      const contextUsage = parseContextUsage(payload)
      const isPlaceholder = payload.placeholder === true
      const modelName = parseModelName(payload)
      const runId = parseRunId(payload)
      const thoughtCategory = parseThoughtCategory(payload)
      const inspectorOnly = payload.inspector_only === true
      const messageGroupId = typeof payload.message_group_id === "string" ? payload.message_group_id : undefined
      const messageSequence = Number.isFinite(Number(payload.message_sequence)) ? Number(payload.message_sequence) : undefined
      const messageTotal = Number.isFinite(Number(payload.message_total)) ? Number(payload.message_total) : undefined
      const messageStrategy = ["single", "multi_message", "chunked", "streaming", "progressive"].includes(String(payload.message_strategy)) ? (String(payload.message_strategy) as NonNullable<ChatMessage["messageStrategy"]>) : undefined
      const timestamp =
        message.timestamp !== undefined &&
        Number.isFinite(Number(message.timestamp))
          ? normalizeUnixTimestamp(Number(message.timestamp))
          : Date.now()

      updateChatStore((prev) => {
        if (
          isStaleRun(prev.activeRunId, prev.runStatus, runId, prev.runningRunIds) ||
          isUnscopedWhileRunning(prev.activeRunId, prev.runStatus, runId, prev.runningRunIds)
        ) {
          return prev
        }
        const nextMessage = {
          id: messageId,
          role: "assistant" as const,
          content,
          kind,
          ...(modelName ? { modelName } : {}),
          ...(runId ? { runId } : {}),
          ...(thoughtCategory ? { thoughtCategory } : {}),
          ...(inspectorOnly ? { inspectorOnly } : {}),
          ...(messageGroupId ? { messageGroupId } : {}),
          ...(messageSequence !== undefined ? { messageSequence } : {}),
          ...(messageTotal !== undefined ? { messageTotal } : {}),
          ...(messageStrategy ? { messageStrategy } : {}),
          ...(toolCalls ? { toolCalls } : {}),
          attachments,
          timestamp,
        }
        const existingIndex = prev.messages.findIndex(
          (candidate) => candidate.id === messageId,
        )
        const messages =
          existingIndex >= 0
            ? prev.messages.map((candidate, index) =>
                index === existingIndex
                  ? { ...candidate, ...nextMessage }
                  : candidate,
              )
            : [...prev.messages, nextMessage]
        return {
          messages,
          isTyping:
            !isPlaceholder &&
            (kind === "normal" || message.type === "media.create")
              ? (runId ? prev.runningRunIds.length > 0 : false)
              : prev.isTyping,
          ...(contextUsage ? { contextUsage } : {}),
          ...(modelName ? { activeRunModel: modelName } : {}),
          ...(modelName
            ? { activeRunProvider: providerForModel(modelName) }
            : {}),
        }
      })
      break
    }

    case "message.update": {
      const messageId = payload.message_id as string
      const attachments = parseAttachments(payload)
      const contextUsage = parseContextUsage(payload)
      const modelName = parseModelName(payload)
      const runId = parseRunId(payload)
      const thoughtCategory = parseThoughtCategory(payload)
      const inspectorOnly = payload.inspector_only === true
      const messageGroupId = typeof payload.message_group_id === "string" ? payload.message_group_id : undefined
      const messageSequence = Number.isFinite(Number(payload.message_sequence)) ? Number(payload.message_sequence) : undefined
      const messageTotal = Number.isFinite(Number(payload.message_total)) ? Number(payload.message_total) : undefined
      const messageStrategy = ["single", "multi_message", "chunked", "streaming", "progressive"].includes(String(payload.message_strategy)) ? (String(payload.message_strategy) as NonNullable<ChatMessage["messageStrategy"]>) : undefined
      const timestamp =
        message.timestamp !== undefined &&
        Number.isFinite(Number(message.timestamp))
          ? normalizeUnixTimestamp(Number(message.timestamp))
          : Date.now()
      if (!messageId) {
        break
      }

      updateChatStore((prev) => {
        if (
          isStaleRun(prev.activeRunId, prev.runStatus, runId, prev.runningRunIds) ||
          isUnscopedWhileRunning(prev.activeRunId, prev.runStatus, runId, prev.runningRunIds)
        ) {
          return prev
        }
        return {
          messages: (() => {
            let found = false
            const messages = prev.messages.map((msg) => {
              if (msg.id !== messageId) {
                return msg
              }
              found = true
              const { content, kind, toolCalls } =
                parseAssistantMessageUpdateState(payload, msg)
              return {
                ...msg,
                id: messageId,
                content,
                kind,
                toolCalls,
                ...(modelName ? { modelName } : {}),
                ...(runId ? { runId } : {}),
                ...(thoughtCategory ? { thoughtCategory } : {}),
                ...(inspectorOnly ? { inspectorOnly } : {}),
                ...(messageGroupId ? { messageGroupId } : {}),
                ...(messageSequence !== undefined ? { messageSequence } : {}),
                ...(messageTotal !== undefined ? { messageTotal } : {}),
                ...(messageStrategy ? { messageStrategy } : {}),
                ...(attachments !== undefined ? { attachments } : {}),
              }
            })
            if (found) {
              return messages
            }

            const { content, kind, toolCalls } =
              parseAssistantMessageUpdateState(payload)

            return [
              ...messages,
              {
                id: messageId,
                role: "assistant" as const,
                content,
                kind,
                toolCalls,
                ...(modelName ? { modelName } : {}),
                ...(runId ? { runId } : {}),
                ...(thoughtCategory ? { thoughtCategory } : {}),
                ...(inspectorOnly ? { inspectorOnly } : {}),
                ...(messageGroupId ? { messageGroupId } : {}),
                ...(messageSequence !== undefined ? { messageSequence } : {}),
                ...(messageTotal !== undefined ? { messageTotal } : {}),
                ...(messageStrategy ? { messageStrategy } : {}),
                ...(attachments !== undefined ? { attachments } : {}),
                timestamp,
              },
            ]
          })(),
          ...(contextUsage ? { contextUsage } : {}),
          ...(modelName ? { activeRunModel: modelName } : {}),
          ...(modelName
            ? { activeRunProvider: providerForModel(modelName) }
            : {}),
        }
      })
      break
    }

    case "message.delta": {
      const messageId = typeof payload.message_id === "string" ? payload.message_id : ""
      const delta = typeof payload.delta === "string" ? payload.delta : ""
      if (!messageId || !delta) break
      const runId = parseRunId(payload)
      updateChatStore((prev) => {
        if (
          isStaleRun(prev.activeRunId, prev.runStatus, runId, prev.runningRunIds) ||
          isUnscopedWhileRunning(prev.activeRunId, prev.runStatus, runId, prev.runningRunIds)
        ) return prev
        const index = prev.messages.findIndex((msg) => msg.id === messageId)
        const runningRunIds = runId && !prev.runningRunIds.includes(runId)
          ? [...prev.runningRunIds, runId]
          : prev.runningRunIds
        if (index < 0) {
          return {
            messages: [
              ...prev.messages,
              { id: messageId, role: "assistant" as const, content: delta, kind: "normal" as const, ...(runId ? { runId } : {}), timestamp: Date.now() },
            ],
            runningRunIds,
            isTyping: true,
          }
        }
        return {
          messages: prev.messages.map((msg, i) => i === index ? { ...msg, content: `${msg.content}${delta}`, ...(runId ? { runId } : {}) } : msg),
          runningRunIds,
          isTyping: true,
        }
      })
      break
    }

    case "message.delete": {
      const messageId = payload.message_id as string
      if (!messageId) {
        break
      }

      updateChatStore((prev) => ({
        messages: prev.messages.filter((msg) => msg.id !== messageId),
      }))
      break
    }

    case "node.run_start": {
      const runId =
        typeof payload.run_id === "string" ? payload.run_id.trim() : ""
      updateChatStore((prev) => {
        const recentRunIds = prev.recentRunIds ?? []
        if (
          (prev.activeRunId && prev.runStatus === "running" && !runId) ||
          (runId && recentRunIds.includes(runId) && prev.activeRunId !== runId)
        ) {
          return prev
        }
        const runningRunIds = runId && !prev.runningRunIds.includes(runId)
          ? [...prev.runningRunIds, runId]
          : prev.runningRunIds
        return {
          ...(runId ? { activeRunId: runId } : {}),
          runningRunIds,
          ...(runId
            ? {
                recentRunIds: [
                  ...recentRunIds.filter((candidate) => candidate !== runId),
                  runId,
                ].slice(-20),
              }
            : {}),
          ...(parseModelName(payload)
            ? { activeRunModel: parseModelName(payload) }
            : {}),
          ...(parseModelName(payload)
            ? { activeRunProvider: providerForModel(parseModelName(payload)) }
            : {}),
          runStatus: "running",
          runError: undefined,
          isTyping: true,
        }
      })
      break
    }

    case "delivery.outcome": {
      const outcome = parseDeliveryOutcome(payload)
      if (!outcome) break
      const runStatus: RunStatus =
        outcome.status === "sent"
          ? "completed"
          : outcome.status === "created" ||
              outcome.status === "waiting_approval" ||
              outcome.status === "approved" ||
              outcome.status === "sending"
            ? "running"
            : "failed"
      updateChatStore((prev) => {
        if (isStaleRun(prev.activeRunId, prev.runStatus, outcome.runId)) {
          return prev
        }
        return {
          activeRunId: prev.runningRunIds.at(-1) ?? outcome.runId,
          runStatus: prev.runningRunIds.length ? "running" : runStatus,
          deliveryOutcome: outcome,
          ...(outcome.nextAction
            ? { runError: outcome.nextAction }
            : { runError: undefined }),
          isTyping: prev.runningRunIds.length > 0,
        }
      })
      break
    }

    case "node.run_end": {
      const runId =
        typeof payload.run_id === "string" ? payload.run_id.trim() : undefined
      const rawStatus = payload.status
      const status: RunStatus =
        rawStatus === "completed_with_warning" ||
        rawStatus === "completed" ||
        rawStatus === "failed" ||
        rawStatus === "cancelled"
          ? rawStatus
          : "failed"
      const error =
        typeof payload.error === "string" ? payload.error : undefined
      const modelName = parseModelName(payload)
      updateChatStore((prev) => {
        if (isStaleRun(prev.activeRunId, prev.runStatus, runId, prev.runningRunIds)) {
          const remainingRuns = runId
            ? prev.runningRunIds.filter((candidate) => candidate !== runId)
            : prev.runningRunIds
          return {
            ...prev,
            runningRunIds: remainingRuns,
            isTyping: remainingRuns.length > 0,
          }
        }
        const runningRunIds = runId
          ? prev.runningRunIds.filter((candidate) => candidate !== runId)
          : prev.runningRunIds
        const nextActiveRunId = runningRunIds.at(-1) ?? (runId || prev.activeRunId)
        return {
          ...(nextActiveRunId ? { activeRunId: nextActiveRunId } : {}),
          ...(modelName ? { activeRunModel: modelName } : {}),
          ...(modelName
            ? { activeRunProvider: providerForModel(modelName) }
            : {}),
          runningRunIds,
          runStatus: runningRunIds.length ? "running" : status,
          ...(error ? { runError: error } : { runError: undefined }),
          isTyping: runningRunIds.length > 0,
        }
      })
      break
    }

    case "task_status": {
      const taskId =
        typeof payload.task_id === "string"
          ? payload.task_id
          : typeof (message as { task_id?: unknown }).task_id === "string"
            ? (message as { task_id?: unknown }).task_id as string
            : undefined
      const statusRaw =
        typeof payload.status === "string"
          ? payload.status
          : typeof (message as { status?: unknown }).status === "string"
            ? String((message as { status?: unknown }).status)
            : undefined
      updateChatStore((prev) => {
        if (statusRaw === "cancelled" || statusRaw === "error") {
          const runningRunIds = taskId
            ? prev.runningRunIds.filter((candidate) => candidate !== taskId)
            : prev.runningRunIds
          return {
            runningRunIds,
            isTyping: runningRunIds.length > 0,
            runStatus: runningRunIds.length ? "running" : statusRaw === "cancelled" ? "cancelled" : "failed",
          }
        }
        return prev
      })
      break
    }

    case "typing.start": {
      const runId = parseRunId(payload)
      updateChatStore((prev) =>
        isStaleRun(prev.activeRunId, prev.runStatus, runId) ||
        isUnscopedWhileRunning(prev.activeRunId, prev.runStatus, runId)
          ? prev
          : {
              isTyping: true,
              ...(runId && !prev.runningRunIds.includes(runId) ? { runningRunIds: [...prev.runningRunIds, runId] } : {}),
            },
      )
      break
    }

    case "typing.stop": {
      const runId = parseRunId(payload)
      updateChatStore((prev) =>
        isStaleRun(prev.activeRunId, prev.runStatus, runId) ||
        isUnscopedWhileRunning(prev.activeRunId, prev.runStatus, runId)
          ? prev
          : {
              isTyping: prev.runningRunIds.some((candidate) => candidate !== runId),
              ...(runId ? { runningRunIds: prev.runningRunIds.filter((candidate) => candidate !== runId) } : {}),
            },
      )
      break
    }

    case "error": {
      const requestId =
        typeof payload.request_id === "string" ? payload.request_id : ""
      const errorMessage =
        typeof payload.message === "string" ? payload.message : ""

      const runId = parseRunId(payload)
      const currentState = getChatState()
      if (
        isStaleRun(currentState.activeRunId, currentState.runStatus, runId, currentState.runningRunIds) ||
        isUnscopedWhileRunning(
          currentState.activeRunId,
          currentState.runStatus,
          runId,
          currentState.runningRunIds,
        )
      ) {
        return
      }
      console.error("miki error:", payload)
      if (errorMessage) {
        toast.error(errorMessage)
      }
      updateChatStore((prev) => {
        if (
          isStaleRun(prev.activeRunId, prev.runStatus, runId, prev.runningRunIds) ||
          isUnscopedWhileRunning(prev.activeRunId, prev.runStatus, runId, prev.runningRunIds)
        ) {
          return prev
        }
        const runningRunIds = runId
          ? prev.runningRunIds.filter((candidate) => candidate !== runId)
          : prev.runningRunIds
        return {
          messages: requestId
            ? prev.messages.filter((msg) => msg.id !== requestId)
            : prev.messages,
          runningRunIds,
          isTyping: runningRunIds.length > 0,
          ...(runId
            ? { activeRunId: runningRunIds.at(-1) ?? runId, runStatus: runningRunIds.length ? "running" as const : "failed" as const }
            : {}),
        }
      })
      break
    }

    case "pong":
      break

    default:
      console.log("Unknown miki message type:", message.type)
  }
}

function parseDeliveryOutcome(
  payload: Record<string, unknown>,
): DeliveryOutcome | undefined {
  if (typeof payload.runId !== "string" || typeof payload.status !== "string") {
    return undefined
  }
  const statuses: DeliveryOutcomeStatus[] = [
    "created",
    "waiting_approval",
    "approved",
    "sending",
    "sent",
    "failed",
    "unknown_outcome",
    "dead_letter",
    "reconciliation_required",
  ]
  if (!statuses.includes(payload.status as DeliveryOutcomeStatus)) {
    return undefined
  }
  const artifactRefs = Array.isArray(payload.artifactRefs)
    ? payload.artifactRefs.filter(
        (item): item is string => typeof item === "string",
      )
    : []
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter(
        (item): item is string => typeof item === "string",
      )
    : []
  return {
    runId: payload.runId,
    stepId: typeof payload.stepId === "string" ? payload.stepId : undefined,
    deliveryId:
      typeof payload.deliveryId === "string" ? payload.deliveryId : undefined,
    status: payload.status as DeliveryOutcomeStatus,
    provider:
      typeof payload.provider === "string" ? payload.provider : undefined,
    model: typeof payload.model === "string" ? payload.model : undefined,
    artifactRefs,
    verification:
      payload.verification && typeof payload.verification === "object"
        ? (payload.verification as Record<string, unknown>)
        : undefined,
    approval:
      payload.approval && typeof payload.approval === "object"
        ? (payload.approval as DeliveryOutcome["approval"])
        : undefined,
    warnings,
    nextAction:
      typeof payload.nextAction === "string" ? payload.nextAction : undefined,
    correlationId:
      typeof payload.correlationId === "string"
        ? payload.correlationId
        : payload.runId,
  }
}
