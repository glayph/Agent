import {
  IconAlertCircle,
  IconBrain,
  IconChevronDown,
  IconClock,
  IconGauge,
  IconKey,
  IconTool,
} from "@tabler/icons-react"
import {
  type FocusEvent,
  Suspense,
  lazy,
  memo,
  useMemo,
  useState,
} from "react"
import { useTranslation } from "react-i18next"

import { visibleAssistantContent } from "@/features/chat/components/assistant-message-content"
import { AttachmentCard } from "@/features/chat/components/attachment-card"
import { LinkPreviewCards } from "@/features/chat/components/link-preview-cards"
import { MessageActionBar } from "@/features/chat/components/message-action-bar"
import { MessageCodeBlock } from "@/features/chat/components/message-code-block"
import { formatMessageTime } from "@/hooks/use-miki-chat"
import { cn } from "@/lib/utils"
import { Button } from "@/shared/ui/button"
import {
  type AssistantMessageKind,
  type ChatAttachment,
  type ChatToolCall,
} from "@/store/chat"

const MarkdownRenderer = lazy(() => import("./markdown-renderer"))

interface AssistantMessageProps {
  id: string
  content: string
  attachments?: ChatAttachment[]
  kind?: AssistantMessageKind
  modelName?: string
  toolCalls?: ChatToolCall[]
  timestamp?: string | number
  canRetry?: boolean
  onEdit?: () => void
  onDelete?: () => void
  onFork?: () => void
  onRetry?: () => void
}

const EMPTY_ATTACHMENTS: ChatAttachment[] = []
const EMPTY_TOOL_CALLS: ChatToolCall[] = []
function isRateLimitConnectionError(content: string): boolean {
  const normalized = content.toLowerCase()
  return (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("rate_limit") ||
    normalized.includes("quota") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("too many requests")
  )
}

function isCredentialConnectionError(content: string): boolean {
  const normalized = content.toLowerCase()
  return (
    !isRateLimitConnectionError(normalized) &&
    (normalized.includes("model needs credentials") ||
      normalized.includes("credential was missing or rejected") ||
      (normalized.includes("error calling llm") &&
        (normalized.includes("no connected db") ||
          normalized.includes("check credentials") ||
          normalized.includes("credential"))))
  )
}

function isTimeoutError(content: string): boolean {
  const normalized = content.toLowerCase()
  return (
    normalized.includes("time limit") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout")
  )
}

function isBudgetError(content: string): boolean {
  const normalized = content.toLowerCase()
  return (
    normalized.includes("budget exhausted") ||
    normalized.includes("context budget") ||
    normalized.includes("safety limit")
  )
}

type ErrorCategory = "rate-limit" | "credential" | "timeout" | "budget" | "generic"

function classifyErrorContent(content: string): ErrorCategory {
  if (isRateLimitConnectionError(content)) return "rate-limit"
  if (isCredentialConnectionError(content)) return "credential"
  if (isTimeoutError(content)) return "timeout"
  if (isBudgetError(content)) return "budget"
  return "generic"
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  attachments = EMPTY_ATTACHMENTS,
  kind = "normal",
  modelName,
  toolCalls = EMPTY_TOOL_CALLS,
  timestamp = "",
  canRetry = true,
  onEdit,
  onDelete,
  onFork,
  onRetry,
}: AssistantMessageProps) {
  const { t } = useTranslation()
  const isThought = kind === "thought"
  const isToolCalls = kind === "tool_calls"
  const isActionUpdate = kind === "action_update"
  const isError = kind === "error"
  const isCollapsedBlock = isThought || isToolCalls
  const trimmedContent = content.trim()
  const hasText = trimmedContent.length > 0
  const hasToolCalls = toolCalls.length > 0
  const imageAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.type === "image"),
    [attachments],
  )
  const fileAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.type !== "image"),
    [attachments],
  )
  const [isExpanded, setIsExpanded] = useState(true)
  const [, setActionsVisible] = useState(false)
  const hideActionsIfFocusLeaves = (event: FocusEvent<HTMLDivElement>) => {
    const nextFocused = event.relatedTarget
    if (
      !(nextFocused instanceof Node) ||
      !event.currentTarget.contains(nextFocused)
    ) {
      setActionsVisible(false)
    }
  }
  const formattedTimestamp =
    timestamp !== "" ? formatMessageTime(timestamp) : ""
  const collapsedLabel = isThought
    ? t("chat.reasoningLabel")
    : t("chat.toolCallsLabel")
  const trimmedModelName = modelName?.trim() ?? ""
  const errorCategory = useMemo(
    () => (isError && hasText ? classifyErrorContent(trimmedContent) : null),
    [isError, hasText, trimmedContent],
  )
  const visibleContent = isActionUpdate
    ? visibleAssistantContent(trimmedContent)
    : trimmedContent
  return (
    <div className="group/message flex w-full max-w-[var(--chat-message-max)] flex-col gap-2 px-1">
      {(hasText || isCollapsedBlock || hasToolCalls) && (
        <div
          data-chat-bubble="assistant"
          data-chat-kind={isError ? "error" : undefined}
          className={cn(
            "group group/message-bubble relative flex w-fit max-w-[var(--chat-user-message-max)] flex-col rounded-xl rounded-bl-sm border px-3 py-2 [border-color:var(--chat-user-border)] [box-shadow:var(--chat-user-shadow)] transition-[background-color,border-color,box-shadow] [background:var(--chat-user-bubble)]",
            isThought &&
              "w-full rounded-lg border-transparent bg-transparent px-0 py-0 shadow-none",
            isToolCalls && hasToolCalls && "cursor-pointer",
            isError &&
              "[border-color:var(--chat-error-border)] [background:var(--chat-error-bubble)]",
          )}
          onClick={() => {
            if (isToolCalls && hasToolCalls) setIsExpanded((expanded) => !expanded)
          }}
          onKeyDown={(event) => {
            if (
              isToolCalls &&
              hasToolCalls &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault()
              setIsExpanded((expanded) => !expanded)
            }
          }}
          role={isToolCalls && hasToolCalls ? "button" : undefined}
          tabIndex={isToolCalls && hasToolCalls ? 0 : undefined}
          aria-expanded={isToolCalls && hasToolCalls ? isExpanded : undefined}
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
              "relative [color:var(--chat-user-text)]",
              isCollapsedBlock && "text-muted-foreground",
              isError && "[color:var(--chat-error-text)]",
            )}
          >
            {isActionUpdate && hasText && (
              <div
                data-chat-action-update="true"
                className="text-muted-foreground/80 bg-primary/5 inline-flex max-w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] leading-5"
              >
                <IconTool
                  className="text-primary size-3.5 shrink-0 animate-pulse"
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate">{visibleContent}</span>
              </div>
            )}
            {isCollapsedBlock && (
              <button
                type="button"
                className="text-muted-foreground/75 hover:text-muted-foreground focus-visible:ring-ring/25 mb-1 flex w-full cursor-pointer items-center justify-between rounded-md px-0 py-1 text-left text-[13px] font-medium transition-[color,box-shadow] select-none focus-visible:ring-2 focus-visible:outline-none"
                onClick={(event) => {
                  event.stopPropagation()
                  setIsExpanded((expanded) => !expanded)
                }}
                aria-expanded={isExpanded}
                aria-label={t("chat.toggleAssistantDetails", {
                  defaultValue: "Toggle assistant details",
                })}
              >
                <div className="flex items-center gap-1.5">
                  {isThought ? (
                    <IconBrain
                      className="size-3.5 opacity-75"
                      aria-hidden="true"
                    />
                  ) : (
                    <IconTool
                      className="size-3.5 opacity-75"
                      aria-hidden="true"
                    />
                  )}
                  <span>{collapsedLabel}</span>
                  {trimmedModelName && (
                    <span className="text-muted-foreground/45">
                      {trimmedModelName}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {formattedTimestamp && (
                    <span className="sr-only">{formattedTimestamp}</span>
                  )}
                  <IconChevronDown
                    className={cn(
                      "size-3.5 opacity-100 transition-transform duration-200",
                      isExpanded ? "rotate-180" : "",
                    )}
                    aria-hidden="true"
                  />
                </div>
              </button>
            )}
            {(!isCollapsedBlock || isExpanded) &&
              isToolCalls &&
              hasToolCalls && (
                <div className="flex flex-col gap-1.5 px-2.5 pt-0 pb-2">
                  {toolCalls.map((toolCall, index) => {
                    const explanation =
                      toolCall.extraContent?.toolFeedbackExplanation?.trim() ??
                      ""
                    const toolName = toolCall.function?.name?.trim() ?? ""
                    const toolArguments =
                      toolCall.function?.arguments?.trim() ?? ""
                    const hasFunctionSummary = toolName || toolArguments

                    if (!explanation && !hasFunctionSummary) {
                      return null
                    }

                    return (
                      <div
                        key={toolCall.id ?? `${toolName}-${index}`}
                        className={cn(
                          "flex flex-col gap-3",
                          index > 0 && "pt-3",
                        )}
                      >
                        {explanation && (
                          <div className="flex flex-col gap-1.5">
                            <div className="text-muted-foreground/55 text-[10px] font-medium tracking-wide uppercase">
                              {t("chat.toolCallExplanationLabel")}
                            </div>
                            <div className="prose dark:prose-invert prose-p:my-1 prose-p:whitespace-pre-wrap max-w-none text-[12px] leading-5 [overflow-wrap:anywhere] break-words opacity-75">
                              <Suspense
                                fallback={
                                  <span className="animate-pulse opacity-50">
                                    ...
                                  </span>
                                }
                              >
                                <MarkdownRenderer content={explanation} />
                              </Suspense>
                            </div>
                          </div>
                        )}

                        {hasFunctionSummary && (
                          <div
                            className={cn(
                              "flex flex-col gap-1.5",
                              explanation && "pt-3",
                            )}
                          >
                            <div className="text-muted-foreground/55 text-[11px] font-medium tracking-wide uppercase">
                              {t("chat.toolCallFunctionLabel")}
                            </div>
                            <div className="bg-background/45 flex flex-col gap-2 rounded-md px-2.5 py-2">
                              {toolName && !toolArguments && (
                                <div className="text-foreground/75 font-mono text-[12px] font-semibold">
                                  {toolName}
                                </div>
                              )}
                              {toolArguments && (
                                <MessageCodeBlock
                                  code={toolArguments}
                                  language="json"
                                  label={
                                    toolName || t("chat.toolCallArgumentsLabel")
                                  }
                                  className="my-0 shadow-none"
                                  bodyClassName="px-3 py-2 text-[12px] leading-relaxed"
                                />
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            {isError && errorCategory && (
              <div className="py-0.5 text-[14px] leading-6">
                <div
                  data-chat-alert={errorCategory}
                  className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1"
                >
                  {errorCategory === "timeout" ? (
                    <IconClock
                      className="size-3.5 shrink-0 [color:var(--chat-alert-icon)]"
                      aria-hidden="true"
                    />
                  ) : errorCategory === "budget" ? (
                    <IconGauge
                      className="size-3.5 shrink-0 [color:var(--chat-alert-icon)]"
                      aria-hidden="true"
                    />
                  ) : (
                    <IconAlertCircle
                      className="size-3.5 shrink-0 [color:var(--chat-alert-icon)]"
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12.5px] leading-5 font-semibold [color:var(--chat-alert-text)]">
                    {errorCategory === "rate-limit" &&
                      t("chat.errors.rateLimitTitle", {
                        defaultValue: "Model quota or rate limit reached",
                      })}
                    {errorCategory === "credential" &&
                      t("chat.errors.credentialsTitle", {
                        defaultValue: "Model needs credentials",
                      })}
                    {errorCategory === "timeout" &&
                      t("chat.errors.timeoutTitle", {
                        defaultValue: "Stopped — time limit reached",
                      })}
                    {errorCategory === "budget" &&
                      t("chat.errors.budgetTitle", {
                        defaultValue: "Stopped — context limit reached",
                      })}
                    {errorCategory === "generic" &&
                      t("chat.errors.genericTitle", {
                        defaultValue: "Something went wrong",
                      })}
                  </span>
                  {errorCategory === "credential" && (
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0 rounded-md bg-transparent [color:var(--chat-alert-text)] hover:bg-transparent hover:[color:var(--chat-alert-icon)]"
                    >
                      <a
                        href="/credentials"
                        aria-label={t("chat.errors.openCredentials", {
                          defaultValue: "Credentials",
                        })}
                        title={t("chat.errors.openCredentials", {
                          defaultValue: "Credentials",
                        })}
                      >
                        <IconKey className="size-3.5" />
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            )}

            {!isActionUpdate &&
              (!isCollapsedBlock || isExpanded) &&
              !isToolCalls &&
              hasText && (
                <div
                  className={cn(
                    "prose dark:prose-invert prose-headings:mt-2 prose-headings:mb-1 prose-li:my-0.5 prose-ol:my-2 prose-p:my-2 prose-pre:my-2 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted/50 prose-pre:p-0 prose-pre:text-foreground relative max-w-none [overflow-wrap:anywhere] break-words",
                    isThought
                      ? "prose-p:my-1 prose-p:whitespace-pre-wrap py-0 text-[13px] leading-6 opacity-70"
                      : "prose-p:whitespace-pre-wrap py-0 text-[14px] leading-6",
                    isError && "text-[13px] opacity-90",
                  )}
                >
                  <Suspense
                    fallback={
                      <div className="animate-pulse py-1 text-sm opacity-50">
                        Loading format...
                      </div>
                    }
                  >
                    <MarkdownRenderer content={visibleContent} />
                  </Suspense>
                  {!isThought && <LinkPreviewCards content={content} />}
                </div>
              )}
          </div>

          {!isCollapsedBlock && !isActionUpdate && hasText && (
            <MessageActionBar
              content={content}
              align="start"
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
              // Keep assistant actions mounted and hit-testable. Hover-only
              // opacity made Retry/Edit/Delete appear visible but intercept no
              // pointer events in the chat viewport.
              visible={true}
              placement="inline"
              className="mt-0 group-focus-within/message:mt-1 group-hover/message:mt-1"
              onEdit={onEdit}
              onDelete={onDelete}
              onFork={onFork}
              onRetry={onRetry}
              inspectorLabel={t("chat.actions.inspect", {
                defaultValue: "Inspect agent",
              })}
              modelLabel={
                trimmedModelName
                  ? t("chat.actions.modelInfo", {
                      defaultValue: `Model ${trimmedModelName}`,
                      model: trimmedModelName,
                    })
                  : undefined
              }
            />
          )}
        </div>
      )}

      {imageAttachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {imageAttachments.map((attachment, index) => (
            <a
              key={`${attachment.url}-${index}`}
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              className="group/img bg-muted/30 focus-visible:ring-ring/30 border-border/60 relative overflow-hidden rounded-xl border transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <img
                src={attachment.url}
                alt={attachment.filename || t("chat.attachedImage")}
                width={560}
                height={320}
                loading="lazy"
                decoding="async"
                className="max-h-80 max-w-[280px] object-contain transition-transform duration-300 group-hover/img:scale-[1.02]"
              />
              <div className="absolute inset-0 bg-black/0 transition-colors group-hover/img:bg-black/10 dark:group-hover/img:bg-black/20" />
            </a>
          ))}
        </div>
      )}

      {fileAttachments.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {fileAttachments.map((attachment, index) => (
            <AttachmentCard
              key={`${attachment.url}-${index}`}
              attachment={attachment}
              downloadLabel={t("chat.downloadFile")}
            />
          ))}
        </div>
      )}
    </div>
  )
})
