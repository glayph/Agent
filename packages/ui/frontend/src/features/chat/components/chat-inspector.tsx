import {
  IconActivity,
  IconArchive,
  IconBrain,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconFile,
  IconListDetails,
  IconLockCheck,
  IconPlayerPlay,
  IconShieldCheck,
  IconTool,
  IconX,
} from "@tabler/icons-react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { useEffect, useMemo } from "react"

import {
  chatInspectorAtom,
  closeChatInspectorAtom,
  setChatInspectorPageAtom,
  type ChatInspectorPage,
} from "@/features/chat/components/chat-inspector-store"
import type { MonitorNode } from "@/features/monitor/store"
import { monitorAtom } from "@/features/monitor/store"
import { Button } from "@/shared/ui/button"
import { cn } from "@/lib/utils"
import type { ChatMessage } from "@/store/chat"

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
  { id: "thoughts", label: "Thought summary", icon: IconBrain },
  { id: "work", label: "Work", icon: IconPlayerPlay },
  { id: "artifacts", label: "Artifacts", icon: IconFile },
  { id: "evidence", label: "Evidence", icon: IconLockCheck },
  { id: "events", label: "Events", icon: IconListDetails },
]

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

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp))
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

  const selectedMessage = useMemo(
    () =>
      selection?.messageId
        ? messages.find((message) => message.id === selection.messageId)
        : messages.find((message) => message.role === "assistant"),
    [messages, selection?.messageId],
  )
  const nodes = useMemo(
    () =>
      liveActivityNodes.length > 0
        ? liveActivityNodes
        : Object.values(monitorState.nodes).slice(-24),
    [liveActivityNodes, monitorState.nodes],
  )
  const thoughtMessages = useMemo(
    () => messages.filter((message) => message.kind === "thought"),
    [messages],
  )
  const toolMessages = useMemo(
    () => messages.filter((message) => message.kind === "tool_calls"),
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

  if (!isOpen) return null

  const currentPageIndex = pages.findIndex((item) => item.id === page)
  const activePage = pages[currentPageIndex] ?? pages[0]
  const ActiveIcon = activePage.icon

  const changePage = (direction: -1 | 1) => {
    const nextIndex =
      (currentPageIndex + direction + pages.length) % pages.length
    setPage(pages[nextIndex].id)
  }

  const selectMessage = (messageId: string) => {
    if (!currentSelection) return
    setSelection({ ...currentSelection, messageId, page: "overview" })
  }

  return (
    <aside
      data-chat-inspector
      role="dialog"
      aria-label="Agent Inspector"
      className="border-border/70 bg-background/96 fixed top-20 right-4 bottom-24 z-50 flex w-[min(430px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border shadow-2xl shadow-black/15 backdrop-blur-xl"
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
                  isWorking ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/50",
                )}
              />
              {isWorking ? "Working live" : "Session snapshot"}
            </div>
          </div>
        </div>
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

      <nav className="border-border/60 flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5" aria-label="Inspector pages">
        {pages.map((item) => {
          const PageIcon = item.icon
          const selected = item.id === page
          return (
            <button
              key={item.id}
              type="button"
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-medium transition-colors",
                selected
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              onClick={() => setPage(item.id)}
              aria-current={selected ? "page" : undefined}
            >
              <PageIcon className="size-3" />
              {item.label}
            </button>
          )
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] font-medium"
            onClick={() => changePage(-1)}
            aria-label="Previous Inspector page"
          >
            <IconChevronLeft className="size-3.5" /> Previous
          </button>
          <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-semibold">
            <ActiveIcon className="text-primary size-3.5" />
            {activePage.label}
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] font-medium"
            onClick={() => changePage(1)}
            aria-label="Next Inspector page"
          >
            Next <IconChevronRight className="size-3.5" />
          </button>
        </div>

        {page === "overview" && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-muted/35 rounded-xl p-3">
                <div className="text-muted-foreground mb-1 text-[10px]">Messages</div>
                <div className="text-foreground text-lg font-semibold">{messages.length}</div>
              </div>
              <div className="bg-muted/35 rounded-xl p-3">
                <div className="text-muted-foreground mb-1 text-[10px]">Live nodes</div>
                <div className="text-foreground text-lg font-semibold">{nodes.length}</div>
              </div>
            </div>
            <div>
              <SectionLabel>SELECTED MESSAGE</SectionLabel>
              {selectedMessage ? (
                <button
                  type="button"
                  className="border-border/60 bg-muted/20 hover:bg-muted/45 w-full rounded-xl border p-3 text-left transition-colors"
                  onClick={() => setPage("thoughts")}
                >
                  <div className="text-muted-foreground mb-1 flex items-center justify-between text-[10px]">
                    <span>{selectedMessage.role === "assistant" ? "Assistant" : "You"}</span>
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
                  {nodes.slice(-4).reverse().map((node) => (
                    <button
                      type="button"
                      key={node.id}
                      className="hover:bg-muted/35 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left"
                      onClick={() => setPage("work")}
                    >
                      <IconTool className={cn("size-3.5", statusTone(node.status))} />
                      <span className="text-foreground min-w-0 flex-1 truncate text-xs">{node.label}</span>
                      <span className="text-muted-foreground text-[10px]">{node.status}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState>No live activity recorded.</EmptyState>
              )}
            </div>
          </div>
        )}

        {page === "thoughts" && (
          <div className="flex flex-col gap-3">
            <div className="border-primary/15 bg-primary/5 rounded-xl border p-3 text-xs leading-5">
              <div className="text-primary mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase">
                <IconBrain className="size-3.5" /> Thought summary
              </div>
              <div className="text-foreground/80">
                Inspector shows concise execution summaries, not private hidden chain-of-thought.
              </div>
            </div>
            {thoughtMessages.length > 0 ? (
              thoughtMessages.map((message) => (
                <button
                  type="button"
                  key={message.id}
                  className="border-border/60 bg-muted/20 hover:bg-muted/45 rounded-xl border p-3 text-left"
                  onClick={() => selectMessage(message.id)}
                >
                  <div className="text-muted-foreground mb-1 text-[10px]">{formatTime(Number(message.timestamp) || Date.now())}</div>
                  <div className="text-foreground/85 text-xs leading-5">{preview(message.content, 420)}</div>
                </button>
              ))
            ) : (
              <EmptyState>No thought summaries are available for this chat yet.</EmptyState>
            )}
          </div>
        )}

        {page === "work" && (
          <div className="flex flex-col gap-2">
            <SectionLabel>EXECUTION NODES</SectionLabel>
            {toolMessages.length > 0 && (
              <div className="mb-2 flex flex-col gap-2">
                {toolMessages.slice(-4).map((message) => (
                  <div key={`tool-${message.id}`} className="border-border/60 bg-muted/20 rounded-xl border p-3">
                    <div className="text-foreground mb-1 flex items-center gap-2 text-xs font-medium">
                      <IconTool className="text-primary size-3.5" /> Tool call summary
                    </div>
                    <div className="text-muted-foreground text-[11px] leading-5">{preview(message.content, 260)}</div>
                  </div>
                ))}
              </div>
            )}
            {nodes.length > 0 ? (
              nodes.map((node) => (
                <div key={node.id} className="border-border/60 bg-muted/15 rounded-xl border p-3">
                  <div className="flex items-center gap-2">
                    <IconTool className={cn("size-3.5", statusTone(node.status))} />
                    <span className="text-foreground min-w-0 flex-1 truncate text-xs font-medium">{node.label}</span>
                    <span className={cn("text-[10px] font-medium", statusTone(node.status))}>{node.status}</span>
                  </div>
                  {(node.action || node.outputPreview || node.error) && (
                    <div className="text-muted-foreground mt-2 text-[11px] leading-5">
                      {preview(node.error || node.outputPreview || node.action, 280)}
                    </div>
                  )}
                  <div className="text-muted-foreground/70 mt-2 flex items-center gap-3 text-[10px]">
                    <span>Level {node.level}</span>
                    {node.durationMs !== undefined && <span>{node.durationMs}ms</span>}
                    {node.attempt !== undefined && <span>Attempt {node.attempt}</span>}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState>No work nodes are available yet.</EmptyState>
            )}
          </div>
        )}

        {page === "artifacts" && (
          <div className="flex flex-col gap-3">
            <SectionLabel>ARTIFACTS AND OUTPUTS</SectionLabel>
            {artifacts.length > 0 ? (
              artifacts.map((artifact) => (
                <a
                  key={artifact.id}
                  href={artifact.url}
                  target="_blank"
                  rel="noreferrer"
                  className="border-border/60 bg-muted/20 hover:bg-muted/45 flex items-center gap-3 rounded-xl border p-3"
                >
                  <div className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
                    <IconFile className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground truncate text-xs font-medium">{artifact.name}</div>
                    <div className="text-muted-foreground mt-1 text-[10px]">{artifact.type}</div>
                  </div>
                  <IconChevronRight className="text-muted-foreground size-3.5" />
                </a>
              ))
            ) : (
              <EmptyState>No artifacts or generated files yet.</EmptyState>
            )}
            {nodes.filter((node) => node.type === "file").map((node) => (
              <div key={`node-${node.id}`} className="border-border/60 bg-muted/20 rounded-xl border p-3">
                <div className="flex items-center gap-2">
                  <IconArchive className="text-primary size-3.5" />
                  <span className="text-foreground text-xs font-medium">{node.label}</span>
                </div>
                <div className="text-muted-foreground mt-1 text-[11px]">{preview(node.outputPreview || node.resultMessage, 240)}</div>
              </div>
            ))}
          </div>
        )}

        {page === "evidence" && (
          <div className="flex flex-col gap-3">
            <SectionLabel>CHECKPOINTS AND EVIDENCE</SectionLabel>
            {nodes.length > 0 ? (
              nodes.map((node) => (
                <div key={`evidence-${node.id}`} className="border-border/60 bg-muted/20 rounded-xl border p-3">
                  <div className="flex items-center gap-2">
                    <IconShieldCheck className={cn("size-3.5", statusTone(node.status))} />
                    <span className="text-foreground min-w-0 flex-1 truncate text-xs font-medium">{node.label}</span>
                    <span className="text-muted-foreground text-[10px]">Attempt {node.attempt ?? 1}</span>
                  </div>
                  {node.input !== undefined && (
                    <pre className="bg-background/55 text-muted-foreground mt-2 max-h-24 overflow-auto rounded-md p-2 text-[10px] leading-4">{preview(formatValue(node.input), 300)}</pre>
                  )}
                  {(node.outputPreview || node.resultMessage || node.error) && (
                    <div className="text-muted-foreground mt-2 text-[11px] leading-5">{preview(node.error || node.outputPreview || node.resultMessage, 300)}</div>
                  )}
                </div>
              ))
            ) : (
              <EmptyState>No verifier evidence or checkpoints yet.</EmptyState>
            )}
          </div>
        )}

        {page === "events" && (
          <div className="flex flex-col gap-3">
            <SectionLabel>REALTIME EVENT STREAM</SectionLabel>
            {[...nodes].reverse().map((node) => (
              <div key={`event-${node.id}`} className="flex gap-2">
                <div className="flex flex-col items-center">
                  <IconClock className="text-muted-foreground mt-0.5 size-3.5" />
                  <div className="bg-border/70 mt-1 h-full w-px" />
                </div>
                <div className="min-w-0 pb-3">
                  <div className="text-foreground text-xs font-medium">{node.label}</div>
                  <div className="text-muted-foreground mt-0.5 text-[10px]">{formatTime(node.updatedAt)} · {node.status}</div>
                  {(node.action || node.resultMessage || node.error) && (
                    <div className="text-muted-foreground mt-1 text-[11px] leading-5">{preview(node.error || node.resultMessage || node.action, 220)}</div>
                  )}
                </div>
              </div>
            ))}
            {nodes.length === 0 && <EmptyState>No realtime events yet.</EmptyState>}
          </div>
        )}
      </div>

      <div className="border-border/70 text-muted-foreground flex shrink-0 items-center gap-2 border-t px-3 py-2 text-[10px]">
        <IconShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        Sensitive internal reasoning is summarized and redacted.
      </div>
    </aside>
  )
}
