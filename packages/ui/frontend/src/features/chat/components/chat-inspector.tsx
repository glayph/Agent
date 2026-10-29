import {
  IconActivity,
  IconArchive,
  IconBrain,
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconListDetails,
  IconMaximize,
  IconMinimize,
  IconPlayerPlay,
  IconShieldCheck,
  IconTool,
  IconX,
} from "@tabler/icons-react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  type ChatInspectorPage,
  chatInspectorAtom,
  closeChatInspectorAtom,
  setChatInspectorPageAtom,
} from "@/features/chat/components/chat-inspector-store"
import type { MonitorNode } from "@/features/monitor/store"
import { monitorAtom } from "@/features/monitor/store"
import { cn } from "@/lib/utils"
import { Button } from "@/shared/ui/button"
import { ToolCallSummaryMeta } from "@/features/chat/components/tool-status-mark"
import type { ChatMessage } from "@/store/chat"
import {
  formatInspectorTime,
  getLatestAssistantResponse,
  getMessageRunIds,
  parseInspectorTimestamp,
  scopeActivityNodes,
} from "@/features/chat/inspector-utils"

interface ChatInspectorProps {
  chatId: string
  messages: ChatMessage[]
  isWorking: boolean
  liveActivityNodes?: MonitorNode[]
}

const pages: Array<{
  id: ChatInspectorPage
  label: string
  icon: typeof IconActivity
}> = [
  { id: "overview", label: "Overview", icon: IconActivity },
  { id: "execution", label: "Execution", icon: IconPlayerPlay },
  { id: "outputs", label: "Outputs", icon: IconArchive },
  { id: "timeline", label: "Timeline", icon: IconListDetails },
]

type ExecutionSection = "all" | "plan" | "tools" | "checks"
type OutputSection = "response" | "files" | "voice"
type TimelineFilter =
  | "all"
  | "plan"
  | "tools"
  | "files"
  | "errors"
  | "checks"

function preview(value: string | undefined, limit = 180): string {
  const normalized = value?.trim().replace(/\s+/g, " ") ?? ""
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 3))}...`
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? ""
  } catch {
    return String(value)
  }
}

function formatTime(timestamp: number | string): string {
  return formatInspectorTime(timestamp)
}

function thoughtCategory(content: string): string {
  const normalized = content.toLowerCase()
  if (/plan|first|next|approach|goal|route/.test(normalized)) return "Plan"
  if (/check|verify|inspect|test|evidence|confirm/.test(normalized))
    return "Verification"
  if (/decid|choose|compare|reason|because|therefore/.test(normalized))
    return "Decision"
  if (/tool|run|execute|open|write|read|search/.test(normalized))
    return "Action"
  return "Progress"
}

function statusTone(status: MonitorNode["status"]): string {
  if (status === "completed") return "text-emerald-600 dark:text-emerald-400"
  if (status === "failed") return "text-destructive"
  if (status === "running" || status === "retrying") return "text-primary"
  return "text-muted-foreground"
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-muted-foreground/70 mb-2 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] uppercase">
      {children}
    </div>
  )
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="border-border/60 bg-muted/20 text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-xs">
      {children}
    </div>
  )
}

export function ChatInspector({
  chatId,
  messages,
  isWorking,
  liveActivityNodes = [],
}: ChatInspectorProps) {
  const selection = useAtomValue(chatInspectorAtom)
  const close = useSetAtom(closeChatInspectorAtom)
  const setPage = useSetAtom(setChatInspectorPageAtom)
  const [currentSelection, setSelection] = useAtom(chatInspectorAtom)
  const monitorState = useAtomValue(monitorAtom)
  const [isExpanded, setIsExpanded] = useState(false)
  const [executionSection, setExecutionSection] = useState<ExecutionSection>("all")
  const [outputSection, setOutputSection] = useState<OutputSection>("response")
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all")
  const [expandedThoughtIds, setExpandedThoughtIds] = useState<Set<string>>(
    new Set(),
  )
  const previousSelectionRef = useRef<{
    chatId?: string
    messageId?: string
    page?: ChatInspectorPage
  }>({})

  const isOpen = selection?.chatId === chatId
  const page = isOpen ? selection.page : "overview"

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [close, isOpen])

  useEffect(() => {
    const previous = previousSelectionRef.current
    const routeChanged =
      previous.chatId !== selection?.chatId ||
      previous.messageId !== selection?.messageId ||
      previous.page !== selection?.page

    if (routeChanged && isOpen && selection?.page === "outputs") {
      const selected = messages.find(
        (message) => message.id === selection.messageId,
      )
      setOutputSection(selected?.voice ? "voice" : "response")
    }

    previousSelectionRef.current = {
      chatId: selection?.chatId,
      messageId: selection?.messageId,
      page: selection?.page,
    }
  }, [chatId, isOpen, messages, selection?.chatId, selection?.messageId, selection?.page])

  const selectedMessage = useMemo(() => {
    const explicit = selection?.messageId
      ? messages.find((message) => message.id === selection.messageId)
      : undefined
    return explicit ?? getLatestAssistantResponse(messages)
  }, [messages, selection?.messageId])
  const messageRunIds = useMemo(() => getMessageRunIds(messages), [messages])
  const nodes = useMemo(() => {
    const scopedNodes = scopeActivityNodes(
      Object.values(monitorState.nodes),
      messageRunIds,
    )
    const sourceNodes = scopeActivityNodes(liveActivityNodes, messageRunIds)
    const selectedNodes = sourceNodes.length > 0 ? sourceNodes : scopedNodes
    return selectedNodes
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-24)
  }, [liveActivityNodes, messageRunIds, monitorState.nodes])
  const thoughtMessages = useMemo(
    () => messages.filter((message) => message.kind === "thought"),
    [messages],
  )
  const responseMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.role === "assistant" &&
          !message.inspectorOnly &&
          message.kind !== "thought" &&
          message.kind !== "tool_calls" &&
          message.kind !== "action_update",
      ),
    [messages],
  )
  const toolMessages = useMemo(
    () => messages.filter((message) => message.kind === "tool_calls"),
    [messages],
  )
  const voiceMessages = useMemo(
    () => messages.filter((message) => message.voice),
    [messages],
  )
  const artifacts = useMemo(
    () =>
      messages.flatMap((message) =>
        (message.attachments ?? []).map((attachment, index) => ({
          id: `${message.id}-${index}`,
          name: attachment.filename || "Generated artifact",
          type: attachment.type,
          url: attachment.url,
        })),
      ),
    [messages],
  )
  const timelineEvents = useMemo(() => {
    const thoughts = thoughtMessages.map((message) => ({
      id: `thought-${message.id}`,
      timestamp: parseInspectorTimestamp(message.timestamp) ?? 0,
      type: "thought" as const,
      message,
    }))
    const activity = nodes.map((node) => ({
      id: `node-${node.id}`,
      timestamp: node.updatedAt,
      type: "node" as const,
      node,
    }))
    return [...thoughts, ...activity].sort((a, b) => a.timestamp - b.timestamp)
  }, [nodes, thoughtMessages])
  const filteredTimelineEvents = useMemo(
    () =>
      timelineEvents.filter((event) => {
        if (timelineFilter === "all") return true
        if (timelineFilter === "plan") return event.type === "thought"
        if (event.type !== "node") return false
        const node = event.node
        if (timelineFilter === "files") return node.type === "file"
        if (timelineFilter === "errors") {
          return node.status === "failed" || Boolean(node.error)
        }
        if (timelineFilter === "checks") {
          return Boolean(
            node.resultMessage || node.outputPreview || node.error,
          )
        }
        return node.type !== "file" && node.type !== "pattern"
      }),
    [timelineEvents, timelineFilter],
  )

  if (!isOpen) return null

  const selectMessage = (
    messageId: string,
    targetPage: ChatInspectorPage = "overview",
  ) => {
    if (!currentSelection) return
    setSelection({ ...currentSelection, messageId, page: targetPage })
  }

  const openMessageDetail = (message: ChatMessage) => {
    if (message.kind === "thought") {
      setExecutionSection("plan")
      selectMessage(message.id, "execution")
    } else if (message.kind === "tool_calls") {
      setExecutionSection("tools")
      selectMessage(message.id, "execution")
    } else {
      setOutputSection(message.voice ? "voice" : "response")
      selectMessage(message.id, "outputs")
    }
  }

  return (
    <aside
      data-chat-inspector
      role="dialog"
      aria-label="Agent Inspector"
      className={cn(
        "border-border/70 bg-background/96 fixed z-50 flex flex-col overflow-hidden rounded-2xl border shadow-2xl shadow-black/15 backdrop-blur-xl transition-[inset,width] duration-200",
        isExpanded
          ? "top-8 right-[3vw] bottom-8 left-[3vw]"
          : "top-20 right-4 bottom-24 w-[min(680px,calc(100vw-2rem))]",
      )}
    >
      <div className="border-border/70 flex shrink-0 items-center justify-between border-b px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-lg">
            <IconActivity className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-foreground truncate text-xs font-semibold">
              Agent Inspector
            </div>
            <div className="text-muted-foreground flex items-center gap-1 text-[10px]">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  isWorking
                    ? "animate-pulse bg-emerald-500"
                    : "bg-muted-foreground/50",
                )}
              />
              {isWorking ? "Working live" : "Session snapshot"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-7 rounded-lg"
            onClick={() => setIsExpanded((value) => !value)}
            aria-label={isExpanded ? "Shrink Inspector" : "Expand Inspector"}
            title={isExpanded ? "Shrink Inspector" : "Expand Inspector"}
          >
            {isExpanded ? (
              <IconMinimize className="size-4" />
            ) : (
              <IconMaximize className="size-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-7 rounded-lg"
            onClick={() => close()}
            aria-label="Close Inspector"
            title="Close Inspector"
          >
            <IconX className="size-4" />
          </Button>
        </div>
      </div>

      <nav
        className="border-border/60 flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5"
        aria-label="Inspector pages"
      >
        {pages.map((item) => {
          const PageIcon = item.icon
          const selected = item.id === page
          return (
            <button
              key={item.id}
              type="button"
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-[11px] font-medium transition-colors",
                selected
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              onClick={() => setPage(item.id)}
              aria-current={selected ? "page" : undefined}
            >
              <PageIcon className="size-3.5" />
              {item.label}
            </button>
          )
        })}
      </nav>

      {page === "execution" && (
        <nav
          className="border-border/50 flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-1"
          aria-label="Execution sections"
        >
          {(["all", "plan", "tools", "checks"] as const).map((section) => (
            <button
              key={section}
              type="button"
              onClick={() => setExecutionSection(section)}
              aria-current={executionSection === section ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1.5 text-[10px] font-medium capitalize transition-colors",
                executionSection === section
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {section === "all"
                ? "All"
                : section === "plan"
                  ? "Plan"
                  : section === "tools"
                    ? "Tools"
                    : "Checks"}
            </button>
          ))}
        </nav>
      )}

      {page === "outputs" && (
        <nav
          className="border-border/50 flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-1"
          aria-label="Output sections"
        >
          {(["response", "files", "voice"] as const).map((section) => (
            <button
              key={section}
              type="button"
              onClick={() => setOutputSection(section)}
              aria-current={outputSection === section ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1.5 text-[10px] font-medium capitalize transition-colors",
                outputSection === section
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {section === "response"
                ? "Response"
                : section === "files"
                  ? "Files"
                  : "Voice"}
            </button>
          ))}
        </nav>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {page === "outputs" && outputSection === "response" && (
          <div className="flex flex-col gap-3">
            <SectionLabel>RESPONSES</SectionLabel>
            {responseMessages.length > 0 ? (
              responseMessages
                .slice()
                .reverse()
                .map((message) => (
                  <button
                    type="button"
                    key={message.id}
                    className="border-border/60 bg-muted/20 hover:bg-muted/45 rounded-xl border p-3 text-left transition-colors"
                    onClick={() => selectMessage(message.id, "outputs")}
                  >
                    <div className="text-muted-foreground mb-1 flex items-center justify-between text-[10px]">
                      <span>Agent Miki</span>
                      <span>
                        {formatTime(message.timestamp)}
                      </span>
                    </div>
                    <div className="text-foreground/90 text-sm leading-6 whitespace-pre-wrap">
                      {message.content || "No response text"}
                    </div>
                  </button>
                ))
            ) : (
              <EmptyState>No user-facing response yet.</EmptyState>
            )}
          </div>
        )}

        {page === "overview" && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-muted/35 rounded-xl p-3">
                <div className="text-muted-foreground mb-1 text-[10px]">
                  Messages
                </div>
                <div className="text-foreground text-lg font-semibold">
                  {messages.length}
                </div>
              </div>
              <div className="bg-muted/35 rounded-xl p-3">
                <div className="text-muted-foreground mb-1 text-[10px]">
                  Live nodes
                </div>
                <div className="text-foreground text-lg font-semibold">
                  {nodes.length}
                </div>
              </div>
            </div>
            <div>
              <SectionLabel>SELECTED MESSAGE</SectionLabel>
              {selectedMessage ? (
                <button
                  type="button"
                  className="border-border/60 bg-muted/20 hover:bg-muted/45 w-full rounded-xl border p-3 text-left transition-colors"
                  onClick={() => openMessageDetail(selectedMessage)}
                >
                  <div className="text-muted-foreground mb-1 flex items-center justify-between text-[10px]">
                    <span>
                      {selectedMessage.role === "assistant"
                        ? "Assistant"
                        : "You"}
                    </span>
                    <span>{selectedMessage.kind ?? "message"}</span>
                  </div>
                  <div className="text-foreground text-xs leading-5">
                    {preview(selectedMessage.content, 240) || "No visible text"}
                  </div>
                </button>
              ) : (
                <EmptyState>No message selected yet.</EmptyState>
              )}
            </div>
            <div>
              <SectionLabel>RECENT ACTIVITY</SectionLabel>
              {nodes.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {nodes
                    .slice(-4)
                    .reverse()
                    .map((node) => (
                      <button
                        type="button"
                        key={node.id}
                        className="hover:bg-muted/35 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left"
                        onClick={() => {
                          setExecutionSection("tools")
                          setPage("execution")
                        }}
                      >
                        <IconTool
                          className={cn("size-3.5", statusTone(node.status))}
                        />
                        <span className="text-foreground min-w-0 flex-1 truncate text-xs">
                          {node.label}
                        </span>
                        <span className="text-muted-foreground text-[10px]">
                          {node.status}
                        </span>
                      </button>
                    ))}
                </div>
              ) : (
                <EmptyState>No live activity recorded.</EmptyState>
              )}
            </div>
          </div>
        )}

        {page === "execution" && (executionSection === "all" || executionSection === "plan") && (
          <div className="flex flex-col gap-3">
            <SectionLabel>PLAN SUMMARIES</SectionLabel>
            {thoughtMessages.length > 0 ? (
              thoughtMessages.map((message) => {
                const category = thoughtCategory(message.content)
                const expanded = expandedThoughtIds.has(message.id)
                return (
                  <div
                    key={message.id}
                    className="border-border/60 bg-muted/20 overflow-hidden rounded-xl border"
                  >
                    <button
                      type="button"
                      className="hover:bg-muted/45 flex w-full items-center gap-2 p-3 text-left transition-colors"
                      onClick={() =>
                        setExpandedThoughtIds((current) => {
                          const next = new Set(current)
                          if (next.has(message.id)) next.delete(message.id)
                          else next.add(message.id)
                          return next
                        })
                      }
                      aria-expanded={expanded}
                    >
                      <IconBrain className="text-primary size-3.5 shrink-0" />
                      <span className="text-foreground flex-1 text-xs font-semibold">
                        Thought · {category}
                      </span>
                      <span className="text-muted-foreground text-[10px]">
                        {formatTime(message.timestamp)}
                      </span>
                      <IconChevronDown
                        className={cn(
                          "text-muted-foreground size-3.5 transition-transform",
                          expanded && "rotate-180",
                        )}
                      />
                    </button>
                    {expanded && (
                      <div className="border-border/50 border-t px-3 pt-2 pb-3">
                        <div className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase">
                          Summary
                        </div>
                        <div className="text-foreground/85 text-xs leading-5 whitespace-pre-wrap">
                          {message.content}
                        </div>
                        <button
                          type="button"
                          className="text-primary mt-2 text-[11px] font-medium"
                          onClick={() => openMessageDetail(message)}
                        >
                          Open full detail
                        </button>
                      </div>
                    )}
                  </div>
                )
              })
            ) : (
              <EmptyState>
                No thought summaries are available for this chat yet.
              </EmptyState>
            )}
          </div>
        )}

        {page === "execution" && (executionSection === "all" || executionSection === "tools") && (
          <div className="flex flex-col gap-2">
            <SectionLabel>EXECUTION NODES</SectionLabel>
            {toolMessages.length > 0 && (
              <div className="mb-2 flex flex-col gap-2">
                {toolMessages.slice(-4).map((message) => (
                  <div
                    key={`tool-${message.id}`}
                    className="border-border/60 bg-muted/20 rounded-xl border p-3"
                  >
                    <div className="text-foreground mb-1 flex items-center gap-2 text-xs font-medium">
                      <IconTool className="text-primary size-3.5" /> Tool call
                      summary
                      <ToolCallSummaryMeta toolCalls={message.toolCalls} />
                    </div>
                    <div className="text-muted-foreground text-[11px] leading-5">
                      {preview(message.content, 260)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {nodes.length > 0 ? (
              nodes.map((node) => (
                <div
                  key={node.id}
                  className="border-border/60 bg-muted/15 rounded-xl border p-3"
                >
                  <div className="flex items-center gap-2">
                    <IconTool
                      className={cn("size-3.5", statusTone(node.status))}
                    />
                    <span className="text-foreground min-w-0 flex-1 truncate text-xs font-medium">
                      {node.label}
                    </span>
                    <span
                      className={cn(
                        "text-[10px] font-medium",
                        statusTone(node.status),
                      )}
                    >
                      {node.status}
                    </span>
                  </div>
                  {node.input !== undefined && (
                    <pre className="bg-background/50 text-muted-foreground mt-2 max-h-20 overflow-auto rounded-md p-2 text-[10px] leading-4 whitespace-pre-wrap">
                      {preview(formatValue(node.input), 240)}
                    </pre>
                  )}
                  {(node.error || node.outputPreview || node.resultMessage || node.action) && (
                    <div className="text-muted-foreground mt-2 text-[11px] leading-5">
                      {preview(
                        node.error ||
                          node.outputPreview ||
                          node.resultMessage ||
                          node.action,
                        280,
                      )}
                    </div>
                  )}
                  <div className="text-muted-foreground/70 mt-2 flex items-center gap-3 text-[10px]">
                    <span>Level {node.level}</span>
                    {node.durationMs !== undefined && (
                      <span>{node.durationMs}ms</span>
                    )}
                    {node.attempt !== undefined && (
                      <span>Attempt {node.attempt}</span>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState>No work nodes are available yet.</EmptyState>
            )}
          </div>
        )}

        {page === "outputs" && outputSection === "files" && (
          <div className="flex flex-col gap-3">
            <SectionLabel>ARTIFACTS AND OUTPUTS</SectionLabel>
            {artifacts.length > 0 ? (
              artifacts.map((artifact) => {
                const content = (
                  <>
                    <div className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
                      <IconFile className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-xs font-medium">{artifact.name}</div>
                      <div className="text-muted-foreground mt-1 text-[10px]">{artifact.type}</div>
                    </div>
                    {artifact.url && <IconChevronRight className="text-muted-foreground size-3.5" />}
                  </>
                )
                return artifact.url ? (
                  <a key={artifact.id} href={artifact.url} target="_blank" rel="noreferrer" className="border-border/60 bg-muted/20 hover:bg-muted/45 flex items-center gap-3 rounded-xl border p-3">
                    {content}
                  </a>
                ) : (
                  <div key={artifact.id} className="border-border/60 bg-muted/20 flex items-center gap-3 rounded-xl border p-3">
                    {content}
                  </div>
                )
              })
            ) : (
              <EmptyState>No artifacts or generated files yet.</EmptyState>
            )}
            {nodes
              .filter((node) => node.type === "file")
              .map((node) => (
                <div
                  key={`node-${node.id}`}
                  className="border-border/60 bg-muted/20 rounded-xl border p-3"
                >
                  <div className="flex items-center gap-2">
                    <IconArchive className="text-primary size-3.5" />
                    <span className="text-foreground text-xs font-medium">
                      {node.label}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-1 text-[11px]">
                    {preview(node.outputPreview || node.resultMessage, 240)}
                  </div>
                </div>
              ))}
          </div>
        )}

        {page === "execution" && executionSection === "checks" && (
          <div className="flex flex-col gap-3">
            <SectionLabel>CHECKPOINTS AND EVIDENCE</SectionLabel>
            {nodes.length > 0 ? (
              nodes.map((node) => (
                <div
                  key={`evidence-${node.id}`}
                  className="border-border/60 bg-muted/20 rounded-xl border p-3"
                >
                  <div className="flex items-center gap-2">
                    <IconShieldCheck
                      className={cn("size-3.5", statusTone(node.status))}
                    />
                    <span className="text-foreground min-w-0 flex-1 truncate text-xs font-medium">
                      {node.label}
                    </span>
                    <span className="text-muted-foreground text-[10px]">
                      Attempt {node.attempt ?? 1}
                    </span>
                  </div>
                  {node.input !== undefined && (
                    <pre className="bg-background/55 text-muted-foreground mt-2 max-h-24 overflow-auto rounded-md p-2 text-[10px] leading-4">
                      {preview(formatValue(node.input), 300)}
                    </pre>
                  )}
                  {(node.outputPreview || node.resultMessage || node.error) && (
                    <div className="text-muted-foreground mt-2 text-[11px] leading-5">
                      {preview(
                        node.error || node.outputPreview || node.resultMessage,
                        300,
                      )}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <EmptyState>No verifier evidence or checkpoints yet.</EmptyState>
            )}
          </div>
        )}

        {page === "outputs" && outputSection === "voice" && (
          <div className="flex flex-col gap-3">
            <SectionLabel>VOICE</SectionLabel>
            {voiceMessages.length > 0 ? (
              voiceMessages
                .slice()
                .reverse()
                .map((message) => {
                  const voice = message.voice!
                  return (
                    <div
                      key={`voice-${message.id}`}
                      className="border-border/60 bg-muted/20 rounded-xl border p-3"
                    >
                      <div className="text-muted-foreground mb-2 flex items-center justify-between text-[10px]">
                        <span>
                          {voice.source === "microphone"
                            ? "Microphone"
                            : voice.source === "channel"
                              ? "Channel voice"
                              : "Uploaded audio"}
                        </span>
                        <span>
                          {formatTime(message.timestamp)}
                        </span>
                      </div>
                      <div className="text-foreground mb-3 text-sm leading-6 whitespace-pre-wrap">
                        {voice.transcript}
                      </div>
                      <div className="text-muted-foreground grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] sm:grid-cols-4">
                        <span>Provider: {voice.provider}</span>
                        <span>Language: {voice.language}</span>
                        <span>
                          Duration:{" "}
                          {voice.durationMs !== undefined
                            ? `${Math.round(voice.durationMs / 1000)}s`
                            : "—"}
                        </span>
                        <span>
                          Latency:{" "}
                          {voice.latencyMs !== undefined
                            ? `${Math.round(voice.latencyMs)}ms`
                            : "—"}
                        </span>
                      </div>
                    </div>
                  )
                })
            ) : (
              <EmptyState>
                No voice transcription is available for this chat yet.
              </EmptyState>
            )}
          </div>
        )}

        {page === "timeline" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>ACTIVITY</SectionLabel>
              <span className="text-muted-foreground text-[10px]">
                {filteredTimelineEvents.length} items
              </span>
            </div>
            <div
              className="flex flex-wrap gap-1"
              aria-label="Timeline filters"
            >
              {(["all", "plan", "tools", "files", "errors", "checks"] as const).map(
                (filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setTimelineFilter(filter)}
                    aria-pressed={timelineFilter === filter}
                    className={cn(
                      "rounded-md px-2 py-1 text-[10px] font-medium capitalize transition-colors",
                      timelineFilter === filter
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    {filter === "all"
                      ? "All"
                      : filter === "plan"
                        ? "Plan"
                        : filter === "tools"
                          ? "Tools"
                          : filter === "files"
                            ? "Files"
                            : filter === "errors"
                              ? "Errors"
                              : "Checks"}
                  </button>
                ),
              )}
            </div>
            {filteredTimelineEvents.length > 0 ? (
              <div className="divide-border/50 divide-y">
                {filteredTimelineEvents.map((event) =>
                  event.type === "thought" ? (
                    <div key={event.id} className="flex gap-2 py-2.5">
                      <IconBrain className="text-primary mt-0.5 size-3.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-foreground text-xs font-medium">
                          Plan · {thoughtCategory(event.message.content)}
                        </div>
                        <div className="text-muted-foreground mt-0.5 text-[10px]">
                          {formatTime(event.message.timestamp)}
                        </div>
                        <div className="text-muted-foreground mt-1 text-[11px] leading-5">
                          {preview(event.message.content, 220)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="text-primary shrink-0 text-[10px] font-medium"
                        onClick={() => openMessageDetail(event.message)}
                      >
                        Open
                      </button>
                    </div>
                  ) : (
                    <div key={event.id} className="flex gap-2 py-2.5">
                      <IconTool
                        className={cn(
                          "mt-0.5 size-3.5 shrink-0",
                          statusTone(event.node.status),
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-foreground text-xs font-medium">
                            {event.node.label}
                          </span>
                          <span
                            className={cn(
                              "text-[10px]",
                              statusTone(event.node.status),
                            )}
                          >
                            {event.node.status}
                          </span>
                        </div>
                        <div className="text-muted-foreground mt-0.5 text-[10px]">
                          {formatTime(event.node.updatedAt)}
                        </div>
                        {(event.node.error ||
                          event.node.resultMessage ||
                          event.node.outputPreview ||
                          event.node.action) && (
                          <div className="text-muted-foreground mt-1 text-[11px] leading-5">
                            {preview(
                              event.node.error ||
                                event.node.resultMessage ||
                                event.node.outputPreview ||
                                event.node.action,
                              220,
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <EmptyState>No activity yet.</EmptyState>
            )}
          </div>
        )}
      </div>

      <div className="border-border/70 text-muted-foreground flex shrink-0 items-center gap-2 border-t px-3 py-2 text-[10px]">
        <IconShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        Private reasoning is not shown.
      </div>
    </aside>
  )
}
