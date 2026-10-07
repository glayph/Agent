import { memo, useMemo } from "react"
import { useTranslation } from "react-i18next"

import { AttachmentCard } from "@/features/chat/components/attachment-card"
import { MessageActionBar } from "@/features/chat/components/message-action-bar"
import { formatMessageTime } from "@/hooks/use-miki-chat"
import { cn } from "@/lib/utils"
import type { ChatAttachment } from "@/store/chat"

interface UserMessageProps {
  id: string
  content: string
  selected?: boolean
  onSelect?: () => void
  attachments?: ChatAttachment[]
  timestamp?: string | number
  canRetry?: boolean
  onEdit?: () => void
  onDelete?: () => void
  onFork?: () => void
  onRetry?: () => void
}

const EMPTY_ATTACHMENTS: ChatAttachment[] = []

export const UserMessage = memo(function UserMessage({
  content,
  selected = false,
  onSelect,
  attachments = EMPTY_ATTACHMENTS,
  timestamp = "",
  canRetry = true,
  onEdit,
  onDelete,
  onFork,
  onRetry,
}: UserMessageProps) {
  const { t } = useTranslation()
  const trimmedContent = content.trim()
  const hasText = trimmedContent.length > 0
  const isCommand = trimmedContent.startsWith("/")
  const imageAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.type === "image"),
    [attachments],
  )
  const fileAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.type !== "image"),
    [attachments],
  )
  const formattedTimestamp =
    timestamp !== "" ? formatMessageTime(timestamp) : ""
  const actionBar = (
    <MessageActionBar
      content={content}
      align="end"
      placement="inline"
      copyLabel={t("chat.copyMessage")}
      copiedLabel={t("chat.copiedLabel")}
      editLabel={t("chat.actions.edit", { defaultValue: "Edit message" })}
      retryLabel={t("chat.actions.retry", { defaultValue: "Retry" })}
      retryDisabledLabel={t("chat.actions.retryUnavailable", {
        defaultValue: "Connect chat before retrying",
      })}
      deleteLabel={t("chat.actions.delete", { defaultValue: "Delete message" })}
      deleteConfirmTitle={t("chat.actions.deleteConfirmTitle", {
        defaultValue: "Delete message?",
      })}
      deleteConfirmDescription={t("chat.actions.deleteConfirmDescription", {
        defaultValue: "This message will be removed from the conversation.",
      })}
      deleteConfirmCancelLabel={t("common.cancel")}
      deleteConfirmActionLabel={t("chat.actions.delete", {
        defaultValue: "Delete message",
      })}
      forkLabel={t("chat.actions.fork", { defaultValue: "Fork from here" })}
      canRetry={canRetry}
      className="self-end"
      visible={selected}
      onEdit={onEdit}
      onDelete={onDelete}
      onFork={onFork}
      onRetry={canRetry ? onRetry : undefined}
    />
  )
  return (
    <div className="group/message flex w-full flex-col items-end gap-0.5">
      {imageAttachments.length > 0 && (
        <div
          data-chat-bubble={!hasText ? "user" : undefined}
          onClick={!hasText ? onSelect : undefined}
          className="flex max-w-[var(--chat-user-message-max)] flex-wrap justify-end gap-1.5"
        >
          {imageAttachments.map((attachment, index) => (
            <img
              key={`${attachment.url}-${index}`}
              src={attachment.url}
              alt={attachment.filename || t("chat.uploadedImage")}
              width={640}
              height={360}
              loading="lazy"
              decoding="async"
              className="border-border/60 max-h-[clamp(10rem,34svh,18rem)] max-w-full rounded-2xl border object-cover shadow-sm"
            />
          ))}
        </div>
      )}

      {fileAttachments.length > 0 && (
        <div
          data-chat-bubble={!hasText ? "user" : undefined}
          onClick={!hasText ? onSelect : undefined}
          className="flex max-w-[var(--chat-user-message-max)] flex-col items-end gap-1.5"
        >
          {fileAttachments.map((attachment, index) => (
            <AttachmentCard
              key={`${attachment.url}-${index}`}
              attachment={attachment}
              downloadLabel={t("chat.downloadFile")}
            />
          ))}
        </div>
      )}

      {hasText && (
        <>
        <div
          data-chat-bubble="user"
          className="group group/message-bubble relative flex max-w-[var(--chat-user-message-max)] flex-col items-end gap-1 border px-3 py-2"
          title={formattedTimestamp || undefined}
          onClick={() => onSelect?.()}
        >
          <div
            className={cn(
              "w-full text-[13px] leading-5 [overflow-wrap:anywhere] break-words whitespace-pre-wrap [color:var(--chat-user-text)]",
              isCommand && "font-mono text-[12.5px] leading-5",
            )}
          >
            {isCommand ? (
              <div className="flex items-start gap-2">
                <span className="text-primary/80 font-semibold select-none">
                  &gt;
                </span>
                <span className="min-w-0 flex-1">{content}</span>
              </div>
            ) : (
              content
            )}
          </div>
          {formattedTimestamp && (
            <span className="text-muted-foreground/70 self-end text-[11px] leading-none tabular-nums">
              {formattedTimestamp}
            </span>
          )}
        </div>
        {actionBar}
        </>
      )}
      {!hasText && attachments.length > 0 && actionBar}
    </div>
  )
})
