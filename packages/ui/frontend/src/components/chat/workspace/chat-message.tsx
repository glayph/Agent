import { Suspense, lazy } from "react"

import { UserMessage } from "@/components/chat/user-message"
import { cn } from "@/lib/utils"
import type { ChatMessage as ChatMessageModel } from "@/store/chat"

const AssistantMessage = lazy(() =>
  import("@/components/chat/assistant-message").then((module) => ({
    default: module.AssistantMessage,
  })),
)

interface ChatMessageProps {
  message: ChatMessageModel
  canRetry: boolean
  onEdit: (message: ChatMessageModel) => void
  onDelete: (messageId: string) => void
  onFork: (messageId: string) => void
  onRetry: (messageId: string) => void
}

export function ChatMessage({
  message,
  canRetry,
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
            <div className="text-muted-foreground px-0 py-1 text-[14px]">
              {message.content || "Loading"}
            </div>
          }
        >
          <AssistantMessage
            id={message.id}
            content={message.content}
            attachments={message.attachments}
            kind={message.kind}
            modelName={message.modelName}
            toolCalls={message.toolCalls}
            timestamp={message.timestamp}
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
          canRetry={canRetry}
          onEdit={() => onEdit(message)}
          onDelete={() => onDelete(message.id)}
          onFork={() => onFork(message.id)}
          onRetry={() => onRetry(message.id)}
        />
      )}
    </article>
  )
}
