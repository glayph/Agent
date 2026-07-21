import {
  IconAdjustmentsHorizontal,
  IconAlertCircle,
  IconArrowUp,
  IconPlus,
  IconPhotoPlus,
  IconX,
} from "@tabler/icons-react"
import { type KeyboardEvent as ReactKeyboardEvent, useId, useRef } from "react"
import { useTranslation } from "react-i18next"
import TextareaAutosize from "react-textarea-autosize"

import { ContextUsageRing } from "@/components/chat/context-usage-ring"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
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
  onModeClick,
  attachLabel,
  modeLabel,
  menuLabel,
  buttonClassName,
}: {
  attachEnabled: boolean
  onAddImages: () => void
  onModeClick?: () => void
  attachLabel: string
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
            "text-muted-foreground hover:bg-accent/70 hover:text-foreground rounded-md",
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
    <div className="pointer-events-none relative z-10 shrink-0 bg-transparent px-[var(--chat-inline-padding)] pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      <div
        className={cn(
          "pointer-events-auto relative mx-auto flex max-w-[var(--chat-content-width)] flex-col border transition-[border-color,box-shadow,background-color] [background:var(--chat-composer-bg)] [border-color:var(--chat-composer-border)] [box-shadow:var(--chat-composer-shadow)] focus-within:[border-color:var(--chat-composer-focus-border)] focus-within:[box-shadow:var(--chat-composer-focus-shadow)]",
          canInput
            ? "min-h-[var(--chat-composer-min-height)] rounded-[1.75rem] p-1.5"
            : "min-h-12 rounded-[1.75rem] p-1.5",
        )}
      >
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5 px-1.5">
            {attachments.map((attachment, index) => (
              <div
                key={`${attachment.url}-${index}`}
                className="bg-background relative size-[clamp(3.5rem,15vw,4.75rem)] overflow-hidden rounded-md"
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
                  className="bg-background/85 text-foreground hover:bg-card absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-md transition"
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
              onModeClick={onModeClick}
              attachLabel={t("chat.attachImage")}
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
              className="placeholder:text-muted-foreground/70 max-h-[var(--chat-composer-text-max-height)] min-h-9 min-w-0 flex-1 resize-none border-0 bg-transparent px-0 py-2 text-[15px] leading-6 shadow-none transition-colors focus-visible:ring-0 focus-visible:outline-none dark:bg-transparent"
              minRows={1}
              maxRows={6}
            />
            <span id={sendHintId} className="sr-only">
              {t("chat.sendHint")}
            </span>
            <div className="flex shrink-0 items-center gap-1 pb-0.5">
              {contextUsage && (
                <ContextUsageRing
                  usage={contextUsage}
                  onDetailClick={onContextDetail}
                />
              )}
              <Tooltip delayDuration={700}>
                <TooltipTrigger asChild>
                  <span tabIndex={!canSend ? 0 : undefined}>
                    <Button
                      type="button"
                      size="icon"
                      className="bg-primary text-primary-foreground hover:bg-primary/90 size-8 rounded-full"
                      onClick={onSend}
                      disabled={!canSend}
                      aria-label={t("chat.sendMessage")}
                      aria-describedby={sendHintId}
                    >
                      <IconArrowUp className="size-3.5" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  className="bg-muted text-foreground border-transparent text-center whitespace-pre-line shadow-none"
                  arrowClassName="bg-muted fill-muted"
                >
                  {t("chat.sendHint")}
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
              onModeClick={onModeClick}
              attachLabel={t("chat.attachImage")}
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
                className="bg-muted text-muted-foreground/70 size-8 rounded-full"
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
