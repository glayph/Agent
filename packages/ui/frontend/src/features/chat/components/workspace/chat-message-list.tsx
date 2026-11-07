import { IconArrowDown } from "@tabler/icons-react"
import type { RefObject, UIEvent } from "react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { ChatEmptyState } from "@/features/chat/components/chat-empty-state"
import { getRenderableChatMessages } from "@/features/chat/components/renderable-chat-messages"
import { useMessageActionLabels } from "@/features/chat/components/use-message-action-labels"
import { useIncrementalList } from "@/hooks/use-incremental-list"
import { Button } from "@/shared/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog"
import type { ChatMessage } from "@/store/chat"

import { ChatMessage as WorkspaceChatMessage } from "./chat-message"

interface ChatMessageListProps {
  messages: ChatMessage[]
  sessionId: string
  isTyping: boolean
  hasHydratedActiveSession: boolean
  isGatewayRunning: boolean
  hasAvailableModels: boolean
  defaultModelName: string
  retryableMessageIds: Set<string>
  scrollRef: RefObject<HTMLDivElement | null>
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  isFollowingLatest: boolean
  onJumpToLatest: () => void
  onEditMessage: (message: ChatMessage) => void
  onDeleteMessage: (messageId: string) => void
  onRetryMessage: (messageId: string) => void
  onInspectMessage: (messageId: string) => void
}

export function ChatMessageList({
  messages,
  sessionId,
  isTyping,
  hasHydratedActiveSession,
  isGatewayRunning,
  hasAvailableModels,
  defaultModelName,
  retryableMessageIds,
  scrollRef,
  onScroll,
  isFollowingLatest,
  onJumpToLatest,
  onEditMessage,
  onDeleteMessage,
  onRetryMessage,
  onInspectMessage,
}: ChatMessageListProps) {
  const { t } = useTranslation()
  const actionLabels = useMessageActionLabels()
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null,
  )
  const [pendingDeleteMessageId, setPendingDeleteMessageId] = useState<
    string | null
  >(null)
  const renderableMessages = useMemo(
    () => getRenderableChatMessages(messages),
    [messages],
  )
  const latestAssistantMessageId = useMemo(
    () =>
      [...renderableMessages].reverse().find((message) => message.role === "assistant")
        ?.id,
    [renderableMessages],
  )
  const {
    hiddenCount,
    showMore,
    visibleItems: visibleMessages,
  } = useIncrementalList({
    items: renderableMessages,
    initialCount: 40,
    step: 40,
    fromEnd: true,
    // Only a session switch resets the collapsed history window. A prepended
    // older page must not silently reset the user's current reading position.
    resetKey: sessionId || "empty",
  })
  let streamingMessageId: string | undefined
  if (isTyping) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role === "assistant" && message.kind === "normal") {
        streamingMessageId = message.id
        break
      }
    }
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onClick={(event) => {
          const target = event.target
          if (
            !(target instanceof Element) ||
            !target.closest("[data-chat-bubble]")
          ) {
            setSelectedMessageId(null)
          }
        }}
        data-chat-scroll="true"
        className="h-full min-h-0 overflow-y-auto px-4 py-4 [background:var(--chat-surface)] [overflow-anchor:none] sm:px-6 sm:py-7 lg:px-8"
      >
        <div className="mx-auto flex w-full max-w-[var(--chat-content-width)] flex-col gap-6 pb-8 sm:gap-7 sm:pb-10">
          {!hasHydratedActiveSession && (
            <div className="text-muted-foreground flex items-center justify-center py-12 text-sm">
              {t("chat.loading", { defaultValue: "Loading conversation…" })}
            </div>
          )}

          {hasHydratedActiveSession && messages.length === 0 && !isTyping && (
            <div className="border-0 bg-transparent py-4 sm:py-8">
              <ChatEmptyState
                hasAvailableModels={hasAvailableModels}
                defaultModelName={defaultModelName}
                isConnected={isGatewayRunning}
              />
            </div>
          )}

          {hiddenCount > 0 && (
            <div className="flex justify-center py-1">
              <Button variant="ghost" size="sm" onClick={showMore}>
                {t("common.showOlder", { count: hiddenCount })}
              </Button>
            </div>
          )}

          {visibleMessages.map((message) => (
            <WorkspaceChatMessage
              key={message.id}
              message={message}
              isStreaming={message.id === streamingMessageId}
              selected={selectedMessageId === message.id}
              subtleActions={
                message.role === "assistant" &&
                message.id === latestAssistantMessageId
              }
              onSelect={setSelectedMessageId}
              canRetry={
                isGatewayRunning &&
                !isTyping &&
                retryableMessageIds.has(message.id)
              }
              onEdit={onEditMessage}
              onDelete={setPendingDeleteMessageId}
              onRetry={onRetryMessage}
              onInspectMessage={onInspectMessage}
            />
          ))}
        </div>
      </div>
      {!isFollowingLatest && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
          <Button
            className="pointer-events-auto shadow-lg"
            size="sm"
            onClick={onJumpToLatest}
          >
            <IconArrowDown size={16} />
            {t("chat.jumpToLatest", { defaultValue: "Jump to latest" })}
          </Button>
        </div>
      )}
      <AlertDialog
        open={pendingDeleteMessageId !== null}
        onOpenChange={(open) => !open && setPendingDeleteMessageId(null)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {actionLabels.deleteConfirmTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {actionLabels.deleteConfirmDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{actionLabels.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const messageId = pendingDeleteMessageId
                setPendingDeleteMessageId(null)
                if (messageId) onDeleteMessage(messageId)
              }}
            >
              {actionLabels.deleteConfirmAction}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
