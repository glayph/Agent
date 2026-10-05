import { Suspense, lazy, memo } from "react"

import { UserMessage } from "@/features/chat/components/user-message"
import { cn } from "@/lib/utils"
import type { ChatMessage as ChatMessageModel } from "@/store/chat"

const AssistantMessage = lazy(() =>
  import("@/features/chat/components/assistant-message").then((module) => ({
    default: module.AssistantMessage,
  })),
)

interface ChatMessageProps {
  message: ChatMessageModel
  selected: boolean
  canRetry: boolean
  onSelect: (messageId: string) => void
  onEdit: (message: ChatMessageModel) => void
  onDelete: (messageId: string) => void
  onFork: (messageId: string) => void
  onRetry: (messageId: string) => void
}

export const ChatMessage = memo(function ChatMessage({
  message,
  selected,
  canRetry,
  onSelect,
  onEdit,
  onDelete,
  onFork,
  onRetry,
}: ChatMessageProps) {
  return (
    <article
      data-chat-message={message.role}
      className={cn(
        "group/message-stream flex w-full",
        message.role === "user" ? "justify-end" : "justify-start",
      )}
    >
      {message.role === "assistant" ? (
        <Suspense
          fallback={
            <div
              className="text-muted-foreground px-0 py-1 text-[0px]"
              aria-label="Assistant response loading"
            />
          }
        >
          <AssistantMessage
            id={message.id}
            content={message.content}
            attachments={message.attachments}
            kind={message.kind}
            modelName={message.modelName}
            toolCalls={message.toolCalls}
            messageStrategy={message.messageStrategy}
            messageSequence={message.messageSequence}
            messageTotal={message.messageTotal}
            timestamp={message.timestamp}
            selected={selected}
            onSelect={() => onSelect(message.id)}
            canRetry={canRetry}
            onEdit={() => onEdit(message)}
            onDelete={() => onDelete(message.id)}
            onFork={() => onFork(message.id)}
            onRetry={() => onRetry(message.id)}
          />
        </Suspense>
      ) : (
        <UserMessage
          id={message.id}
          content={message.content}
          attachments={message.attachments}
          timestamp={message.timestamp}
          selected={selected}
          onSelect={() => onSelect(message.id)}
          canRetry={canRetry}
          onEdit={() => onEdit(message)}
          onDelete={() => onDelete(message.id)}
          onFork={() => onFork(message.id)}
          onRetry={() => onRetry(message.id)}
        />
      )}
    </article>
  )
})
