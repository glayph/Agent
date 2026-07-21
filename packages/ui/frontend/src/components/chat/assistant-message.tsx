import {
  IconAlertCircle,
  IconBrain,
  IconChevronDown,
  IconDownload,
  IconFileText,
  IconKey,
  IconTool,
} from "@tabler/icons-react"
import { memo, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import ReactMarkdown from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"

import { MessageActionBar } from "@/components/chat/message-action-bar"
import {
  MarkdownCodeBlock,
  MessageCodeBlock,
} from "@/components/chat/message-code-block"
import { Button } from "@/components/ui/button"
import { formatMessageTime } from "@/hooks/use-pico-chat"
import { cn } from "@/lib/utils"
import {
  type AssistantMessageKind,
  type ChatAttachment,
  type ChatToolCall,
} from "@/store/chat"

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
const MARKDOWN_REMARK_PLUGINS = [remarkGfm]
const MARKDOWN_REHYPE_PLUGINS = [rehypeSanitize, rehypeHighlight]
const LONG_MESSAGE_CHAR_LIMIT = 1500
const LONG_MESSAGE_LINE_LIMIT = 14

function isCredentialConnectionError(content: string): boolean {
  const normalized = content.toLowerCase()
  return (
    normalized.includes("model needs credentials") ||
    (normalized.includes("error calling llm") &&
      (normalized.includes("no connected db") ||
        normalized.includes("check credentials") ||
        normalized.includes("credential")))
  )
}

function isLongAssistantMessage(content: string): boolean {
  return (
    content.length > LONG_MESSAGE_CHAR_LIMIT ||
    content.split(/\r?\n/).length > LONG_MESSAGE_LINE_LIMIT
  )
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
  const [isBodyExpanded, setIsBodyExpanded] = useState(false)
  const formattedTimestamp =
    timestamp !== "" ? formatMessageTime(timestamp) : ""
  const collapsedLabel = isThought
    ? t("chat.reasoningLabel")
    : t("chat.toolCallsLabel")
  const trimmedModelName = modelName?.trim() ?? ""
  const isCredentialError = useMemo(
    () =>
      !isCollapsedBlock &&
      hasText &&
      isCredentialConnectionError(trimmedContent),
    [hasText, isCollapsedBlock, trimmedContent],
  )
  const shouldCompactBody =
    !isCredentialError &&
    !isCollapsedBlock &&
    hasText &&
    isLongAssistantMessage(trimmedContent)
  const isBodyCompact = shouldCompactBody && !isBodyExpanded
  const bodyToggleLabel = isBodyExpanded
    ? t("chat.showLess", { defaultValue: "Show less" })
    : t("chat.showMore", { defaultValue: "Show more" })
  return (
    <div className="group/message flex w-full max-w-[var(--chat-message-max)] flex-col gap-1.5">
      {(hasText || isCollapsedBlock || hasToolCalls) && (
        <div
          data-chat-bubble="assistant"
          className="group group/message-bubble relative flex w-full max-w-full flex-col"
          title={formattedTimestamp || undefined}
        >
          <div
            className={cn(
              "relative shadow-none [color:var(--chat-assistant-text)]",
              isCollapsedBlock && "text-muted-foreground",
            )}
          >
            {isCollapsedBlock && (
              <button
                type="button"
                className="text-muted-foreground/75 hover:text-muted-foreground focus-visible:ring-ring/25 mb-1 flex w-full cursor-pointer items-center justify-between rounded-md px-0 py-1 text-left text-[13px] font-medium transition-[color,box-shadow] select-none focus-visible:ring-2 focus-visible:outline-none"
                onClick={() => setIsExpanded(!isExpanded)}
                aria-expanded={isExpanded}
                aria-label={t("chat.toggleAssistantDetails", {
                  defaultValue: "Toggle assistant details",
                })}
              >
                <div className="flex items-center gap-1.5">
                  {isThought ? (
                    <IconBrain className="size-3.5 opacity-75" aria-hidden="true" />
                  ) : (
                    <IconTool className="size-3.5 opacity-75" aria-hidden="true" />
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
                              <ReactMarkdown
                                remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                                components={{
                                  pre: MarkdownCodeBlock,
                                }}
                              >
                                {explanation}
                              </ReactMarkdown>
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
            {isCredentialError && (
              <div className="py-0.5 text-[14px] leading-6">
                <div
                  data-chat-alert="credentials"
                  className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1"
                >
                  <IconAlertCircle
                    className="size-3.5 shrink-0 [color:var(--chat-alert-icon)]"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] leading-5 font-semibold [color:var(--chat-alert-text)]">
                    {t("chat.errors.credentialsTitle", {
                      defaultValue: "Model needs credentials",
                    })}
                  </span>
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
                </div>
              </div>
            )}

            {!isCredentialError &&
              (!isCollapsedBlock || isExpanded) &&
              !isToolCalls &&
              hasText && (
                <div
                  className={cn(
                    "prose dark:prose-invert prose-headings:mt-2 prose-headings:mb-1 prose-li:my-0.5 prose-ol:my-2 prose-p:my-2 prose-pre:my-2 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted/50 prose-pre:p-0 prose-pre:text-foreground relative max-w-none [overflow-wrap:anywhere] break-words",
                    isThought
                      ? "prose-p:my-1 prose-p:whitespace-pre-wrap py-0 text-[13px] leading-6 opacity-70"
                      : "prose-p:whitespace-pre-wrap py-0 text-[15px] leading-7",
                    isBodyCompact && "max-h-72 overflow-hidden",
                  )}
                >
                  <ReactMarkdown
                    remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                    components={{
                      pre: MarkdownCodeBlock,
                    }}
                  >
                    {content}
                  </ReactMarkdown>
                  {isBodyCompact && (
                    <div className="from-background pointer-events-none absolute right-0 bottom-0 left-0 h-16 bg-gradient-to-t to-transparent" />
                  )}
                </div>
              )}

            {shouldCompactBody && (
              <div className="px-2 pb-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground h-7 rounded-md px-2 text-[12px]"
                  onClick={() => setIsBodyExpanded((expanded) => !expanded)}
                  aria-expanded={isBodyExpanded}
                >
                  <IconChevronDown
                    className={cn(
                      "size-3.5 transition-transform duration-200",
                      isBodyExpanded && "rotate-180",
                    )}
                  />
                  {bodyToggleLabel}
                </Button>
              </div>
            )}
          </div>

          {!isCollapsedBlock && hasText && (
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
              placement="inline"
              className="mt-0 group-focus-within/message:mt-1 group-hover/message:mt-1"
              onEdit={onEdit}
              onDelete={onDelete}
              onFork={onFork}
              onRetry={onRetry}
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
        <div className="mt-1 flex flex-wrap gap-2">
          {imageAttachments.map((attachment, index) => (
            <a
              key={`${attachment.url}-${index}`}
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              className="group/img bg-muted/30 focus-visible:ring-ring/30 relative overflow-hidden rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
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
        <div className="mt-1 flex flex-wrap gap-3">
          {fileAttachments.map((attachment, index) => (
            <a
              key={`${attachment.url}-${index}`}
              href={attachment.url}
              download={attachment.filename}
              className="group/file bg-card/86 focus-visible:ring-ring/30 flex w-fit max-w-sm min-w-[min(100%,220px)] items-center gap-3 rounded-lg px-3 py-2.5 transition-[background-color,color,border-color] duration-200 focus-visible:ring-2 focus-visible:outline-none"
            >
              <div className="text-primary bg-primary/10 flex size-10 shrink-0 items-center justify-center rounded-lg">
                <IconFileText className="size-5" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col pr-1">
                <span className="text-foreground group-hover/file:text-primary truncate text-[14px] leading-tight font-medium transition-colors">
                  {attachment.filename || t("chat.downloadFile")}
                </span>
                <span className="text-muted-foreground/70 mt-1 text-[12px] font-medium">
                  {attachment.filename?.split(".").pop()?.toUpperCase() ||
                    t("chat.fileFallback")}
                </span>
              </div>
              <div className="bg-muted text-muted-foreground group-hover/file:bg-primary group-hover/file:text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color] duration-200">
                <IconDownload className="size-4 transition-transform duration-200 group-hover/file:-translate-y-[1px]" />
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  )
})
