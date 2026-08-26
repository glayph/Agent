import { toast } from "sonner"

import {
  parseAssistantMessageCreateState,
  parseAssistantMessageUpdateState,
} from "@/features/chat/assistant-message-state"
import { normalizeUnixTimestamp } from "@/features/chat/state"
import {
  type AssistantThoughtCategory,
  type ChatAttachment,
  type ContextUsage,
  type DeliveryOutcome,
  type DeliveryOutcomeStatus,
  type RunStatus,
  updateChatStore,
} from "@/store/chat"

export interface mikiMessage {
  type: string
  id?: string
  session_id?: string
  timestamp?: number | string
  payload?: Record<string, unknown>
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

  return attachments.length > 0 ? attachments : undefined
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
      const timestamp =
        message.timestamp !== undefined &&
        Number.isFinite(Number(message.timestamp))
          ? normalizeUnixTimestamp(Number(message.timestamp))
          : Date.now()

      updateChatStore((prev) => {
        const nextMessage = {
          id: messageId,
          role: "assistant" as const,
          content,
          kind,
          ...(modelName ? { modelName } : {}),
          ...(runId ? { runId } : {}),
          ...(thoughtCategory ? { thoughtCategory } : {}),
          ...(inspectorOnly ? { inspectorOnly } : {}),
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
              ? false
              : prev.isTyping,
          ...(contextUsage ? { contextUsage } : {}),
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
      const timestamp =
        message.timestamp !== undefined &&
        Number.isFinite(Number(message.timestamp))
          ? normalizeUnixTimestamp(Number(message.timestamp))
          : Date.now()
      if (!messageId) {
        break
      }

      updateChatStore((prev) => ({
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
              ...(attachments ? { attachments } : {}),
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
              ...(attachments ? { attachments } : {}),
              timestamp,
            },
          ]
        })(),
        ...(contextUsage ? { contextUsage } : {}),
      }))
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
      updateChatStore({
        ...(runId ? { activeRunId: runId } : {}),
        runStatus: "running",
        runError: undefined,
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
      updateChatStore({
        activeRunId: outcome.runId,
        runStatus,
        deliveryOutcome: outcome,
        ...(outcome.nextAction
          ? { runError: outcome.nextAction }
          : { runError: undefined }),
        isTyping: false,
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
      updateChatStore({
        ...(runId ? { activeRunId: runId } : {}),
        runStatus: status,
        ...(error ? { runError: error } : { runError: undefined }),
        isTyping: false,
      })
      break
    }

    case "typing.start":
      updateChatStore({ isTyping: true })
      break

    case "typing.stop":
      updateChatStore({ isTyping: false })
      break

    case "error": {
      const requestId =
        typeof payload.request_id === "string" ? payload.request_id : ""
      const errorMessage =
        typeof payload.message === "string" ? payload.message : ""

      console.error("miki error:", payload)
      if (errorMessage) {
        toast.error(errorMessage)
      }
      updateChatStore((prev) => ({
        messages: requestId
          ? prev.messages.filter((msg) => msg.id !== requestId)
          : prev.messages,
        isTyping: false,
      }))
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
