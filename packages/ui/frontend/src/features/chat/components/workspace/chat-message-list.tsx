import type { RefObject, UIEvent } from "react"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"

import { ChatEmptyState } from "@/features/chat/components/chat-empty-state"
import { TypingIndicator } from "@/features/chat/components/typing-indicator"
import { Button } from "@/shared/ui/button"
import { useIncrementalList } from "@/hooks/use-incremental-list"
import type { AssistantDetailVisibility, ChatMessage } from "@/store/chat"
import { shouldShowAssistantMessage } from "@/store/chat"

import { ChatMessage as WorkspaceChatMessage } from "./chat-message"

interface ChatMessageListProps {
  messages: ChatMessage[]
  assistantDetailVisibility: AssistantDetailVisibility
  isTyping: boolean
  isGatewayRunning: boolean
  hasAvailableModels: boolean
  defaultModelName: string
  connectionState: string
  retryableMessageIds: Set<string>
  scrollRef: RefObject<HTMLDivElement | null>
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  onEditMessage: (message: ChatMessage) => void
  onDeleteMessage: (messageId: string) => void
  onForkMessage: (messageId: string) => void
  onRetryMessage: (messageId: string) => void
}

export function ChatMessageList({
  messages,
  assistantDetailVisibility,
  isTyping,
  isGatewayRunning,
  hasAvailableModels,
  defaultModelName,
  connectionState,
  retryableMessageIds,
  scrollRef,
  onScroll,
  onEditMessage,
  onDeleteMessage,
  onForkMessage,
  onRetryMessage,
}: ChatMessageListProps) {
  const { t } = useTranslation()
  const renderableMessages = useMemo(
    () =>
      messages.filter((message) =>
        shouldShowAssistantMessage(assistantDetailVisibility, message.kind),
      ),
    [assistantDetailVisibility, messages],
  )
  const {
    hiddenCount,
    showMore,
    visibleItems: visibleMessages,
  } = useIncrementalList({
    items: renderableMessages,
    initialCount: 80,
    step: 80,
    fromEnd: true,
    resetKey: messages[0]?.id ?? "empty",
  })

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full min-h-0 overflow-y-auto px-4 py-6 [background:var(--chat-surface)] sm:px-6 sm:py-8"
    >
      <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-6 pb-4 sm:gap-8">
        {messages.length === 0 && !isTyping && (
          <div className="border-border/60 bg-card/72 rounded-lg border">
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
            canRetry={
              connectionState === "connected" &&
              !isTyping &&
              retryableMessageIds.has(message.id)
            }
            onEdit={onEditMessage}
            onDelete={onDeleteMessage}
            onFork={onForkMessage}
            onRetry={onRetryMessage}
          />
        ))}

        {isTyping && (
          <div className="border-border/65 bg-card/72 rounded-md border px-2.5 py-2">
            <TypingIndicator />
          </div>
        )}
      </div>
    </div>
  )
}
