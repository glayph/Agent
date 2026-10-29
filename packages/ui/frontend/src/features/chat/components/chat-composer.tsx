import {
  IconAdjustmentsHorizontal,
  IconArrowUp,
  IconFileMusic,
  IconLoader2,
  IconMicrophone,
  IconPhotoPlus,
  IconPlayerStop,
  IconPlus,
} from "@tabler/icons-react"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useId,
  useRef,
} from "react"
import { useTranslation } from "react-i18next"
import TextareaAutosize from "react-textarea-autosize"

import { AttachmentCard } from "@/features/chat/components/attachment-card"
import { ContextUsageRing } from "@/features/chat/components/context-usage-ring"
import { cn } from "@/lib/utils"
import { Button } from "@/shared/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import type { ChatAttachment, ContextUsage } from "@/store/chat"

export type ChatInputDisabledReason =
  | "gatewayUnknown"
  | "gatewayStarting"
  | "gatewayRestarting"
  | "gatewayStopping"
  | "gatewayStopped"
  | "gatewayError"
  | "websocketConnecting"
  | "websocketDisconnected"
  | "websocketError"
  | "noDefaultModel"

const disabledShortFallback: Record<ChatInputDisabledReason, string> = {
  gatewayUnknown: "Checking gateway status…",
  gatewayStarting: "Gateway is starting…",
  gatewayRestarting: "Gateway is restarting…",
  gatewayStopping: "Gateway is stopping…",
  gatewayStopped: "Start gateway to chat",
  gatewayError: "Gateway needs attention",
  websocketConnecting: "Connecting to chat…",
  websocketDisconnected: "Reconnect to chat",
  websocketError: "Connection failed",
  noDefaultModel: "Configure a model to start chatting",
}

export interface ChatComposerProps {
  input: string
  attachments: ChatAttachment[]
  onInputChange: (value: string) => void
  onAddImages: () => void
  onAddAudio?: () => void
  onStartVoice?: () => void
  onStopVoice?: () => void
  voiceState?: "idle" | "recording" | "transcribing"
  voiceElapsedMs?: number
  onModeClick?: () => void
  onRemoveAttachment: (index: number) => void
  onSend: () => void
  isWorking?: boolean
  isEditing?: boolean
  onCancelEdit?: () => void
  onContextDetail?: () => void
  modeLabel?: string
  inputDisabledReason: ChatInputDisabledReason | null
  canSend: boolean
  contextUsage?: ContextUsage
}

function ComposerActionsMenu({
  attachEnabled,
  onAddImages,
  onAddAudio,
  attachLabel,
  audioLabel,
  menuLabel,
}: {
  attachEnabled: boolean
  onAddImages: () => void
  onAddAudio?: () => void
  attachLabel: string
  audioLabel: string
  menuLabel: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:bg-muted hover:text-foreground size-9 rounded-xl transition-colors"
          aria-label={menuLabel}
          title={menuLabel}
        >
          <IconPlus className="size-[1.125rem]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuItem disabled={!attachEnabled} onSelect={onAddImages}>
          <IconPhotoPlus className="size-4" />
          {attachLabel}
        </DropdownMenuItem>
        {onAddAudio && (
          <DropdownMenuItem disabled={!attachEnabled} onSelect={onAddAudio}>
            <IconFileMusic className="size-4" />
            {audioLabel}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ChatComposer({
  input,
  attachments,
  onInputChange,
  onAddImages,
  onAddAudio,
  onStartVoice,
  onStopVoice,
  voiceState,
  voiceElapsedMs = 0,
  onModeClick,
  onRemoveAttachment,
  onSend,
  isWorking = false,
  isEditing = false,
  onCancelEdit,
  onContextDetail,
  modeLabel,
  inputDisabledReason,
  canSend,
  contextUsage,
}: ChatComposerProps) {
  const { t } = useTranslation()
  const canInput = inputDisabledReason === null
  const resolvedVoiceState = voiceState ?? "idle"
  const isRecording = resolvedVoiceState === "recording"
  const isTranscribing = resolvedVoiceState === "transcribing"
  const hasMessageInput = input.trim().length > 0 || attachments.length > 0
  // The mic takes the send button's place only while there is nothing to send.
  const showVoiceAction = canInput && !hasMessageInput && Boolean(onStartVoice)
  const composingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const sendHintId = useId()
  const textareaId = useId()
  const disabledMessageId = useId()
  const disabledMessage =
    inputDisabledReason === null
      ? null
      : t(`chat.disabledPlaceholder.${inputDisabledReason}`)
  const disabledShortMessage =
    inputDisabledReason === null
      ? null
      : t(`chat.disabledShort.${inputDisabledReason}`, {
          defaultValue: disabledShortFallback[inputDisabledReason],
        })
  const placeholder = isWorking
    ? t("chat.placeholderWorking", {
        defaultValue: "Message Miki while it works",
      })
    : t("chat.placeholderCompact", { defaultValue: "Ask anything" })
  const resolvedModeLabel =
    modeLabel ?? t("chat.modeAction", { defaultValue: "Mode" })
  const actionsMenuLabel = t("chat.actionsMenu", {
    defaultValue: "Composer actions",
  })
  const textareaDescription = canInput ? sendHintId : disabledMessageId
  const voiceLabel = isTranscribing
    ? t("chat.transcribingVoice", { defaultValue: "Transcribing…" })
    : isRecording
      ? t("chat.stopVoice", { defaultValue: "Stop recording" })
      : t("chat.startVoice", { defaultValue: "Record voice message" })
  const actionLabel = showVoiceAction ? voiceLabel : t("chat.sendMessage")
  const actionDisabled = showVoiceAction
    ? isTranscribing || !onStartVoice
    : !canInput || !canSend
  const onAction = showVoiceAction
    ? isRecording
      ? onStopVoice
      : onStartVoice
    : onSend

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as Event & {
      isComposing?: boolean
      keyCode?: number
    }
    if (
      composingRef.current ||
      nativeEvent.isComposing ||
      nativeEvent.keyCode === 229
    ) {
      return
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="pointer-events-none relative z-10 shrink-0 bg-transparent px-[var(--chat-inline-padding)] pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto relative mx-auto flex max-w-[var(--chat-content-width)] flex-col overflow-hidden rounded-2xl border [border-color:var(--chat-composer-border)] [box-shadow:var(--chat-composer-shadow)] [background:var(--chat-composer-bg)]">
        {isEditing && onCancelEdit ? (
          <div className="bg-muted/60 text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-1.5 text-[12.5px] leading-5">
            <span className="min-w-0 truncate">
              {t("chat.editingMessage", {
                defaultValue: "Editing message — send to apply changes",
              })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 rounded-lg px-2 text-[12px]"
              onClick={onCancelEdit}
            >
              {t("common.cancel")}
            </Button>
          </div>
        ) : null}

        {attachments.length > 0 && (
          <div className="flex max-w-full flex-col gap-1.5 px-3 pt-3 sm:flex-row sm:flex-wrap">
            {attachments.map((attachment, index) => (
              <AttachmentCard
                key={`${attachment.url}-${index}`}
                attachment={attachment}
                removeLabel={t("chat.removeImage")}
                onRemove={() => onRemoveAttachment(index)}
              />
            ))}
          </div>
        )}

        {canInput ? (
          <TextareaAutosize
            ref={textareaRef}
            id={textareaId}
            name="message"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={!canInput}
            aria-label={t("chat.messageInput", { defaultValue: "Message" })}
            aria-describedby={textareaDescription}
            autoComplete="off"
            data-chat-composer-input="true"
            className="text-foreground placeholder:text-muted-foreground/70 max-h-[var(--chat-composer-text-max-height)] min-h-[3rem] w-full min-w-0 resize-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 shadow-none focus-visible:ring-0 focus-visible:outline-none dark:bg-transparent"
            minRows={1}
            maxRows={8}
          />
        ) : (
          <div
            role="textbox"
            aria-disabled="true"
            aria-label={t("chat.messageInput", { defaultValue: "Message" })}
            aria-describedby={disabledMessageId}
            className="text-muted-foreground flex min-h-[3rem] min-w-0 items-center px-4 pt-3.5 pb-1 text-[14px] leading-6"
          >
            <span className="truncate">
              {t("chat.placeholderCompact", { defaultValue: "Ask anything" })}
            </span>
          </div>
        )}
        <span id={sendHintId} className="sr-only">
          {t("chat.sendHint")}
        </span>

        <div
          data-chat-composer-controls="true"
          className="flex min-h-12 items-center gap-1 px-2 pt-1 pb-2"
        >
          <ComposerActionsMenu
            attachEnabled={canInput}
            onAddImages={onAddImages}
            onAddAudio={onAddAudio}
            attachLabel={t("chat.attachImage")}
            audioLabel={t("chat.attachAudio", {
              defaultValue: "Upload audio",
            })}
            menuLabel={actionsMenuLabel}
          />
          {onModeClick ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:bg-muted hover:text-foreground h-9 max-w-[10rem] min-w-0 gap-1.5 rounded-xl px-2.5 text-[13px] font-normal"
              onClick={onModeClick}
              title={resolvedModeLabel}
            >
              <IconAdjustmentsHorizontal className="size-4 shrink-0" />
              <span className="truncate">{resolvedModeLabel}</span>
            </Button>
          ) : null}

          <div className="flex-1" />

          {showVoiceAction && isRecording && (
            <span
              className="text-destructive flex items-center gap-1.5 pr-1 text-xs tabular-nums"
              aria-live="polite"
            >
              <span
                aria-hidden
                className="bg-destructive size-1.5 rounded-full motion-safe:animate-pulse"
              />
              {t("chat.voiceRecording", {
                defaultValue: "Recording {{seconds}}s",
                seconds: Math.max(0, Math.floor(voiceElapsedMs / 1000)),
              })}
            </span>
          )}
          {contextUsage && (
            <ContextUsageRing
              usage={contextUsage}
              onDetailClick={onContextDetail}
            />
          )}
          <Tooltip delayDuration={700}>
            <TooltipTrigger asChild>
              <span tabIndex={actionDisabled ? 0 : undefined}>
                <Button
                  type="button"
                  size="icon"
                  variant={
                    showVoiceAction && isRecording ? "destructive" : "ghost"
                  }
                  className={cn(
                    "size-9 rounded-xl transition-[transform,background-color,color] active:scale-95",
                    actionDisabled && !isTranscribing
                      ? "bg-muted text-muted-foreground/50"
                      : showVoiceAction && !isRecording
                        ? "bg-muted text-foreground hover:bg-primary/10 hover:text-primary"
                        : !showVoiceAction
                          ? "bg-primary text-primary-foreground hover:bg-primary/90"
                          : "",
                  )}
                  onClick={onAction}
                  disabled={actionDisabled}
                  aria-label={actionLabel}
                  aria-describedby={sendHintId}
                >
                  {showVoiceAction ? (
                    isTranscribing ? (
                      <IconLoader2 className="size-[1.125rem] animate-spin" />
                    ) : isRecording ? (
                      <IconPlayerStop className="size-[1.125rem]" />
                    ) : (
                      <IconMicrophone className="size-[1.125rem]" />
                    )
                  ) : (
                    <IconArrowUp className="size-[1.125rem]" />
                  )}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent
              className="bg-muted text-foreground border-transparent text-center whitespace-pre-line shadow-none"
              arrowClassName="bg-muted fill-muted"
            >
              {showVoiceAction ? voiceLabel : t("chat.sendHint")}
            </TooltipContent>
          </Tooltip>
        </div>

        {!canInput && (
          <p
            id={disabledMessageId}
            role="status"
            className="text-muted-foreground border-t px-4 py-2 text-xs leading-5"
          >
            {disabledShortMessage || disabledMessage ||
              t("chat.inputUnavailable", {
                defaultValue: "Chat input is currently unavailable.",
              })}
          </p>
        )}
      </div>
    </div>
  )
}
