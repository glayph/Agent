import { type FocusEvent, memo, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { MessageActionBar } from "@/components/chat/message-action-bar"
import { formatMessageTime } from "@/hooks/use-pico-chat"
import { cn } from "@/lib/utils"
import type { ChatAttachment } from "@/store/chat"

interface UserMessageProps {
  id: string
  content: string
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
  const formattedTimestamp =
    timestamp !== "" ? formatMessageTime(timestamp) : ""
  const [actionsVisible, setActionsVisible] = useState(false)
  const hideActionsIfFocusLeaves = (event: FocusEvent<HTMLDivElement>) => {
    const nextFocused = event.relatedTarget
    if (
      !(nextFocused instanceof Node) ||
      !event.currentTarget.contains(nextFocused)
    ) {
      setActionsVisible(false)
    }
  }

  return (
    <div className="group/message flex w-full flex-col items-end gap-0.5">
      {imageAttachments.length > 0 && (
        <div className="flex max-w-[var(--chat-user-message-max)] flex-wrap justify-end gap-1.5">
          {imageAttachments.map((attachment, index) => (
            <img
              key={`${attachment.url}-${index}`}
              src={attachment.url}
              alt={attachment.filename || t("chat.uploadedImage")}
              width={640}
              height={360}
              loading="lazy"
              decoding="async"
              className="max-h-[clamp(10rem,34svh,18rem)] max-w-full rounded-md object-cover"
            />
          ))}
        </div>
      )}

      {hasText && (
        <div
          data-chat-bubble="user"
          className="group group/message-bubble relative flex max-w-[var(--chat-user-message-max)] flex-col items-end gap-1"
          title={formattedTimestamp || undefined}
          onPointerEnter={() => setActionsVisible(true)}
          onPointerLeave={() => setActionsVisible(false)}
          onMouseEnter={() => setActionsVisible(true)}
          onMouseLeave={() => setActionsVisible(false)}
          onFocusCapture={() => setActionsVisible(true)}
          onBlurCapture={hideActionsIfFocusLeaves}
        >
          <div
            className={cn(
              "wrap-break-word rounded-[1.35rem] border px-4 py-2 text-[14px] leading-5 whitespace-pre-wrap [background:var(--chat-user-bubble)] [border-color:var(--chat-user-border)] [box-shadow:var(--chat-user-shadow)] [color:var(--chat-user-text)]",
              isCommand && "font-mono text-[12.5px]",
            )}
          >
            {isCommand ? (
              <div className="flex items-start gap-2.5">
                <span className="font-bold opacity-70 select-none">
                  &gt;
                </span>
                <span className="mt-[1px]">{content}</span>
              </div>
            ) : (
              <div>{content}</div>
            )}
          </div>
          <MessageActionBar
            content={content}
            align="end"
            placement="inline"
            copyLabel={t("chat.copyMessage")}
            copiedLabel={t("chat.copiedLabel")}
            editLabel={t("chat.actions.edit", {
              defaultValue: "Edit message",
            })}
            retryLabel={t("chat.actions.retry", { defaultValue: "Retry" })}
            retryDisabledLabel={t("chat.actions.retryUnavailable", {
              defaultValue: "Connect chat before retrying",
            })}
            deleteLabel={t("chat.actions.delete", {
              defaultValue: "Delete message",
            })}
            deleteConfirmTitle={t("chat.actions.deleteConfirmTitle", {
              defaultValue: "Delete message?",
            })}
            deleteConfirmDescription={t(
              "chat.actions.deleteConfirmDescription",
              {
                defaultValue:
                  "This message will be removed from the conversation.",
              },
            )}
            deleteConfirmCancelLabel={t("common.cancel")}
            deleteConfirmActionLabel={t("chat.actions.delete", {
              defaultValue: "Delete message",
            })}
            forkLabel={t("chat.actions.fork", {
              defaultValue: "Fork from here",
            })}
            canRetry={canRetry}
            className="self-end"
            visible={actionsVisible}
            onEdit={onEdit}
            onDelete={onDelete}
            onFork={onFork}
            onRetry={onRetry}
          />
        </div>
      )}
    </div>
  )
})
