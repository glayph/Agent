import dayjs from "dayjs"
import { useAtomValue } from "jotai"

import {
  deleteChatMessage,
  editChatMessage,
  forkChatSessionFromMessage,
  newChatSession,
  retryChatMessage,
  sendChatMessage,
  stopChatGeneration,
  switchChatSession,
} from "@/features/chat/controller"
import { chatAtom, thinkingModeAtom } from "@/store/chat"

const UNIX_MS_THRESHOLD = 1e12

function normalizeUnixTimestamp(timestamp: number): number {
  return timestamp < UNIX_MS_THRESHOLD ? timestamp * 1000 : timestamp
}

function parseTimestamp(dateRaw: number | string | Date) {
  if (typeof dateRaw === "number") {
    return dayjs(normalizeUnixTimestamp(dateRaw))
  }

  if (typeof dateRaw === "string") {
    const trimmed = dateRaw.trim()
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed)
      if (Number.isFinite(numeric)) {
        return dayjs(normalizeUnixTimestamp(numeric))
      }
    }
    return dayjs(trimmed)
  }

  return dayjs(dateRaw)
}

export function formatMessageTime(dateRaw: number | string | Date): string {
  const date = parseTimestamp(dateRaw)
  if (!date.isValid()) {
    return ""
  }
  const now = dayjs()

  const isToday = date.isSame(now, "day")
  const isThisYear = date.isSame(now, "year")

  if (isToday) {
    return date.format("LT")
  }

  if (isThisYear) {
    return date.format("MMM D LT")
  }

  return date.format("ll LT")
}

export function useMikiChat() {
  const thinkingMode = useAtomValue(thinkingModeAtom)
  const {
    messages,
    connectionState,
    isTyping,
    activeSessionId,
    hasHydratedActiveSession,
    contextUsage,
    activeRunModel,
    activeRunProvider,
  } = useAtomValue(chatAtom)

  return {
    messages,
    thinkingMode,
    connectionState,
    isTyping,
    activeSessionId,
    hasHydratedActiveSession,
    contextUsage,
    activeRunModel,
    activeRunProvider,
    sendMessage: (input: Parameters<typeof sendChatMessage>[0]) =>
      sendChatMessage({ ...input, thinkingMode }),
    deleteMessage: deleteChatMessage,
    editMessage: editChatMessage,
    forkFromMessage: forkChatSessionFromMessage,
    retryMessage: retryChatMessage,
    stopGeneration: stopChatGeneration,
    switchSession: switchChatSession,
    newChat: newChatSession,
  }
}
