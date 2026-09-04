import {
  IconAdjustmentsHorizontal,
  IconAlertCircle,
  IconArrowUp,
  IconFileMusic,
  IconLoader2,
  IconMicrophone,
  IconPhotoPlus,
  IconPlayerStop,
  IconPlus,
  IconX,
} from "@tabler/icons-react"
import { type KeyboardEvent as ReactKeyboardEvent, useId, useRef } from "react"
import { useTranslation } from "react-i18next"
import TextareaAutosize from "react-textarea-autosize"

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
  onModeClick,
  attachLabel,
  audioLabel,
  modeLabel,
  menuLabel,
  buttonClassName,
}: {
  attachEnabled: boolean
  onAddImages: () => void
  onAddAudio?: () => void
  onModeClick?: () => void
  attachLabel: string
  audioLabel: string
  modeLabel: string
  menuLabel: string
  buttonClassName?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "text-muted-foreground hover:bg-primary/10 hover:text-primary rounded-full transition-colors",
            buttonClassName,
          )}
          aria-label={menuLabel}
          title={menuLabel}
        >
          <IconPlus className="size-4" />
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
        {onModeClick && (
          <DropdownMenuItem onSelect={onModeClick}>
            <IconAdjustmentsHorizontal className="size-4" />
            {modeLabel}
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
  const showVoiceAction = !hasMessageInput && Boolean(onStartVoice)
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
  const placeholder =
    disabledMessage ??
    t("chat.placeholderCompact", { defaultValue: "Ask anything" })
  const resolvedModeLabel =
    modeLabel ?? t("chat.modeAction", { defaultValue: "Mode" })
  const actionsMenuLabel = t("chat.actionsMenu", {
    defaultValue: "Composer actions",
  })
  const textareaDescription = canInput ? sendHintId : disabledMessageId

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
      <div
        className={cn(
          "pointer-events-auto relative mx-auto flex max-w-[var(--chat-content-width)] flex-col rounded-[1.5rem] border [border-color:var(--chat-composer-border)] [box-shadow:var(--chat-composer-shadow)] transition-[border-color,box-shadow,background-color] [background:var(--chat-composer-bg)] focus-within:[border-color:var(--chat-composer-focus-border)] focus-within:[box-shadow:var(--chat-composer-focus-shadow)]",
          canInput
            ? "min-h-[var(--chat-composer-min-height)] rounded-[1.5rem] p-2"
            : "min-h-12 rounded-[1.5rem] p-2",
        )}
      >
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5 px-1.5">
            {attachments.map((attachment, index) => (
              <div
                key={`${attachment.url}-${index}`}
                className="bg-muted/40 border-border/70 relative size-[clamp(3.5rem,15vw,4.75rem)] overflow-hidden rounded-xl border"
              >
                <img
                  src={attachment.url}
                  alt={attachment.filename || t("chat.uploadedImage")}
                  width={96}
                  height={96}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(index)}
                  className="bg-background/90 text-foreground hover:bg-primary hover:text-primary-foreground border-border/70 absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-full border shadow-sm transition-colors"
                  aria-label={t("chat.removeImage")}
                  title={t("chat.removeImage")}
                >
                  <IconX className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {canInput ? (
          <div
            data-chat-composer-controls="true"
            className="flex min-h-10 items-end gap-2"
          >
            <ComposerActionsMenu
              attachEnabled={canInput}
              onAddImages={onAddImages}
              onAddAudio={onAddAudio}
              onModeClick={onModeClick}
              attachLabel={t("chat.attachImage")}
              audioLabel={t("chat.attachAudio", {
                defaultValue: "Upload audio",
              })}
              modeLabel={resolvedModeLabel}
              menuLabel={actionsMenuLabel}
              buttonClassName="size-9 rounded-full"
            />
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
              className="text-foreground placeholder:text-muted-foreground/70 max-h-[var(--chat-composer-text-max-height)] min-h-9 min-w-0 flex-1 resize-none border-0 bg-transparent px-0 py-2 text-[15px] leading-6 shadow-none transition-colors focus-visible:ring-0 focus-visible:outline-none dark:bg-transparent"
              minRows={1}
              maxRows={6}
            />
            <span id={sendHintId} className="sr-only">
              {t("chat.sendHint")}
            </span>
            <div className="flex shrink-0 items-center gap-1 pb-0.5">
              {showVoiceAction && isRecording && (
                <span
                  className="text-destructive hidden text-xs tabular-nums sm:inline"
                  aria-live="polite"
                >
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
                  <span tabIndex={!showVoiceAction && !canSend ? 0 : undefined}>
                    <Button
                      type="button"
                      size="icon"
                      variant={
                        showVoiceAction && isRecording ? "destructive" : "ghost"
                      }
                      className={cn(
                        "size-8 rounded-full transition-transform hover:scale-105 active:scale-95",
                        showVoiceAction
                          ? "text-muted-foreground hover:bg-primary/10 hover:text-primary"
                          : "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_4px_14px_color-mix(in_srgb,var(--primary)_32%,transparent)]",
                      )}
                      onClick={
                        showVoiceAction
                          ? isRecording
                            ? onStopVoice
                            : onStartVoice
                          : onSend
                      }
                      disabled={
                        showVoiceAction
                          ? isTranscribing || !onStartVoice
                          : !canSend
                      }
                      aria-label={
                        showVoiceAction
                          ? isTranscribing
                            ? t("chat.transcribingVoice", {
                                defaultValue: "Transcribing…",
                              })
                            : isRecording
                              ? t("chat.stopVoice", {
                                  defaultValue: "Stop recording",
                                })
                              : t("chat.startVoice", {
                                  defaultValue: "Record voice message",
                                })
                          : t("chat.sendMessage")
                      }
                      aria-describedby={sendHintId}
                    >
                      {showVoiceAction ? (
                        isTranscribing ? (
                          <IconLoader2 className="size-4 animate-spin" />
                        ) : isRecording ? (
                          <IconPlayerStop className="size-4" />
                        ) : (
                          <IconMicrophone className="size-4" />
                        )
                      ) : (
                        <IconArrowUp className="size-3.5" />
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  className="bg-muted text-foreground border-transparent text-center whitespace-pre-line shadow-none"
                  arrowClassName="bg-muted fill-muted"
                >
                  {showVoiceAction
                    ? isTranscribing
                      ? t("chat.transcribingVoice", {
                          defaultValue: "Transcribing…",
                        })
                      : isRecording
                        ? t("chat.stopVoice", {
                            defaultValue: "Stop recording",
                          })
                        : t("chat.startVoice", {
                            defaultValue: "Record voice message",
                          })
                    : t("chat.sendHint")}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        ) : (
          <div
            data-chat-composer-controls="true"
            className="flex min-h-10 items-center gap-2"
          >
            <ComposerActionsMenu
              attachEnabled={false}
              onAddImages={onAddImages}
              onAddAudio={onAddAudio}
              onModeClick={onModeClick}
              attachLabel={t("chat.attachImage")}
              audioLabel={t("chat.attachAudio", {
                defaultValue: "Upload audio",
              })}
              modeLabel={resolvedModeLabel}
              menuLabel={actionsMenuLabel}
              buttonClassName="size-9 rounded-full"
            />
            <div
              role="textbox"
              aria-disabled="true"
              aria-label={t("chat.messageInput", { defaultValue: "Message" })}
              aria-describedby={disabledMessageId}
              title={disabledMessage || undefined}
              className="text-muted-foreground/80 flex min-w-0 flex-1 items-center gap-1.5 px-2 text-[13.5px] leading-5"
            >
              <IconAlertCircle className="text-warning/90 size-3.5 shrink-0" />
              <span className="truncate">
                {disabledShortMessage || disabledMessage}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {contextUsage && (
                <ContextUsageRing
                  usage={contextUsage}
                  onDetailClick={onContextDetail}
                />
              )}
              <Button
                type="button"
                size="icon"
                className="bg-muted text-muted-foreground/50 size-8 rounded-full shadow-none"
                disabled
                aria-label={t("chat.sendMessage")}
              >
                <IconArrowUp className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
        {!canInput && disabledMessage && (
          <p id={disabledMessageId} className="sr-only">
            {disabledMessage}
          </p>
        )}
      </div>
    </div>
  )
}
