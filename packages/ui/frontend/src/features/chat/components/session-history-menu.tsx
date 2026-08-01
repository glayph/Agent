import {
  IconDotsVertical,
  IconHistory,
  IconPencil,
  IconPinned,
  IconShare3,
  IconTrash,
} from "@tabler/icons-react"
import dayjs from "dayjs"
import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import type { SessionSummary } from "@/api/sessions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog"
import { Button } from "@/shared/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu"
import { Input } from "@/shared/ui/input"
import { ScrollArea } from "@/shared/ui/scroll-area"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

const PINNED_SESSIONS_STORAGE_KEY = "Hiro.chat.history.pinned"
const RENAMED_SESSIONS_STORAGE_KEY = "Hiro.chat.history.renamed"

function readPinnedSessionIds(): string[] {
  if (typeof window === "undefined") {
    return []
  }

  try {
    const rawValue = window.localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY)
    const parsedValue = rawValue ? JSON.parse(rawValue) : []
    return Array.isArray(parsedValue)
      ? parsedValue.filter((id): id is string => typeof id === "string")
      : []
  } catch {
    return []
  }
}

function writePinnedSessionIds(sessionIds: string[]) {
  if (typeof window === "undefined") {
    return
  }
  window.localStorage.setItem(
    PINNED_SESSIONS_STORAGE_KEY,
    JSON.stringify(sessionIds),
  )
}

function readRenamedSessions(): Record<string, string> {
  if (typeof window === "undefined") {
    return {}
  }

  try {
    const rawValue = window.localStorage.getItem(RENAMED_SESSIONS_STORAGE_KEY)
    const parsedValue = rawValue ? JSON.parse(rawValue) : {}
    if (!parsedValue || typeof parsedValue !== "object") {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsedValue).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    )
  } catch {
    return {}
  }
}

function writeRenamedSessions(renamedSessions: Record<string, string>) {
  if (typeof window === "undefined") {
    return
  }
  window.localStorage.setItem(
    RENAMED_SESSIONS_STORAGE_KEY,
    JSON.stringify(renamedSessions),
  )
}

interface SessionHistoryMenuProps {
  sessions: SessionSummary[]
  activeSessionId: string
  hasMore: boolean
  loadError: boolean
  loadErrorMessage: string
  observerRef: RefObject<HTMLDivElement | null>
  onOpenChange: (open: boolean) => void
  onSwitchSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  compact?: boolean
}

export function SessionHistoryMenu({
  sessions,
  activeSessionId,
  hasMore,
  loadError,
  loadErrorMessage,
  observerRef,
  onOpenChange,
  onSwitchSession,
  onDeleteSession,
  compact = false,
}: SessionHistoryMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pinnedSessionIds, setPinnedSessionIds] =
    useState<string[]>(readPinnedSessionIds)
  const [renamedSessions, setRenamedSessions] =
    useState<Record<string, string>>(readRenamedSessions)
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)
  const [focusedSessionIndex, setFocusedSessionIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const sessionItemRefs = useRef<Array<HTMLDivElement | null>>([])
  const typeaheadRef = useRef("")
  const typeaheadTimerRef = useRef<number | null>(null)

  const pinnedSessionIdSet = useMemo(
    () => new Set(pinnedSessionIds),
    [pinnedSessionIds],
  )
  const renderedSessions = useMemo(
    () =>
      sessions
        .map((session, index) => ({
          ...session,
          title: renamedSessions[session.id] ?? session.title,
          isPinned: pinnedSessionIdSet.has(session.id),
          originalIndex: index,
        }))
        .sort((first, second) => {
          if (first.isPinned !== second.isPinned) {
            return first.isPinned ? -1 : 1
          }
          return first.originalIndex - second.originalIndex
        }),
    [pinnedSessionIdSet, renamedSessions, sessions],
  )

  const setMenuOpen = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      onOpenChange(nextOpen)
    },
    [onOpenChange],
  )

  const focusSessionAt = useCallback(
    (nextIndex: number) => {
      if (renderedSessions.length === 0) {
        return
      }

      const normalizedIndex =
        (nextIndex + renderedSessions.length) % renderedSessions.length
      setFocusedSessionIndex(normalizedIndex)
      window.requestAnimationFrame(() => {
        sessionItemRefs.current[normalizedIndex]?.focus()
      })
    },
    [renderedSessions.length],
  )

  const handleTypeahead = useCallback(
    (key: string) => {
      if (typeaheadTimerRef.current) {
        window.clearTimeout(typeaheadTimerRef.current)
      }

      typeaheadRef.current = `${typeaheadRef.current}${key.toLocaleLowerCase()}`
      typeaheadTimerRef.current = window.setTimeout(() => {
        typeaheadRef.current = ""
        typeaheadTimerRef.current = null
      }, 600)

      const search = typeaheadRef.current
      const startIndex = focusedSessionIndex + 1
      const matchIndex = renderedSessions.findIndex((_, offset) => {
        const index = (startIndex + offset) % renderedSessions.length
        return renderedSessions[index].title
          .toLocaleLowerCase()
          .startsWith(search)
      })

      if (matchIndex >= 0) {
        focusSessionAt((startIndex + matchIndex) % renderedSessions.length)
      }
    },
    [focusSessionAt, focusedSessionIndex, renderedSessions],
  )

  const handleSessionKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    sessionId: string,
    index: number,
  ) => {
    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault()
        setMenuOpen(false)
        onSwitchSession(sessionId)
        break
      case "ArrowDown":
        event.preventDefault()
        focusSessionAt(index + 1)
        break
      case "ArrowUp":
        event.preventDefault()
        focusSessionAt(index - 1)
        break
      case "Home":
        event.preventDefault()
        focusSessionAt(0)
        break
      case "End":
        event.preventDefault()
        focusSessionAt(renderedSessions.length - 1)
        break
      default:
        if (
          event.key.length === 1 &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          handleTypeahead(event.key)
        }
    }
  }

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target) ||
        (target instanceof Element &&
          target.closest("[data-slot='dropdown-menu-content']"))
      ) {
        return
      }
      setMenuOpen(false)
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [open, setMenuOpen])

  useEffect(() => {
    if (!open || renderedSessions.length === 0) {
      return
    }

    const nextIndex = Math.min(focusedSessionIndex, renderedSessions.length - 1)
    setFocusedSessionIndex(nextIndex)
    window.requestAnimationFrame(() => {
      sessionItemRefs.current[nextIndex]?.focus()
    })
  }, [focusedSessionIndex, open, renderedSessions.length])

  useEffect(() => {
    return () => {
      if (typeaheadTimerRef.current) {
        window.clearTimeout(typeaheadTimerRef.current)
      }
    }
  }, [])

  const togglePinSession = (sessionId: string) => {
    setPinnedSessionIds((current) => {
      const isPinned = current.includes(sessionId)
      const next = isPinned
        ? current.filter((id) => id !== sessionId)
        : [sessionId, ...current]
      writePinnedSessionIds(next)
      toast.success(
        isPinned
          ? t("chat.historyActions.unpinned", {
              defaultValue: "Unpinned",
            })
          : t("chat.historyActions.pinned", {
              defaultValue: "Pinned",
            }),
      )
      return next
    })
  }

  const openRenameDialog = (session: SessionSummary) => {
    const currentTitle = renamedSessions[session.id] ?? session.title
    setRenameTarget(session)
    setRenameTitle(currentTitle)
    setMenuOpen(false)
  }

  const submitRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!renameTarget) {
      return
    }

    const currentTitle = renamedSessions[renameTarget.id] ?? renameTarget.title
    const trimmedTitle = renameTitle.trim()
    if (!trimmedTitle || trimmedTitle === currentTitle) {
      setRenameTarget(null)
      return
    }

    setRenamedSessions((current) => {
      const next = { ...current, [renameTarget.id]: trimmedTitle }
      writeRenamedSessions(next)
      return next
    })
    setRenameTarget(null)
    toast.success(t("chat.historyActions.renamed", { defaultValue: "Renamed" }))
  }

  const shareSession = async (session: SessionSummary) => {
    const title = renamedSessions[session.id] ?? session.title
    const shareText =
      typeof window === "undefined"
        ? `${title}\n${session.id}`
        : `${title}\n${window.location.origin}${window.location.pathname}#session=${encodeURIComponent(session.id)}`
    const copied = await copyText(shareText)
    if (copied) {
      toast.success(
        t("chat.historyActions.shareCopied", {
          defaultValue: "Share link copied",
        }),
      )
    } else {
      toast.error(
        t("chat.historyActions.shareFailed", {
          defaultValue: "Failed to copy share link",
        }),
      )
    }
  }

  const deleteSession = async (sessionId: string) => {
    try {
      await onDeleteSession(sessionId)
      setPinnedSessionIds((current) => {
        const next = current.filter((id) => id !== sessionId)
        writePinnedSessionIds(next)
        return next
      })
      setRenamedSessions((current) => {
        const next = { ...current }
        delete next[sessionId]
        writeRenamedSessions(next)
        return next
      })
    } catch {
      toast.error("Failed to delete session")
    }
  }

  const confirmDeleteSession = async () => {
    if (!deleteTarget) {
      return
    }

    await deleteSession(deleteTarget.id)
    setDeleteTarget(null)
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        aria-label={t("chat.history")}
        aria-expanded={open}
        title={t("chat.history")}
        className={
          compact
            ? "text-muted-foreground hover:text-foreground size-8 px-0"
            : "text-muted-foreground hover:text-foreground h-8 gap-2 px-2.5 text-sm"
        }
        onClick={() => setMenuOpen(!open)}
      >
        <IconHistory className="size-4" />
        {!compact && (
          <span className="hidden xl:inline">{t("chat.history")}</span>
        )}
      </Button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={t("chat.history")}
            className="border-border bg-popover text-popover-foreground fixed top-14 left-1/2 z-50 w-[min(calc(100vw-2rem),24rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-lg border p-1 shadow-none"
          >
            <ScrollArea
              data-hide-scrollbar="true"
              className="max-h-[min(22rem,calc(100svh-7rem))]"
            >
              {loadError && (
                <div role="menuitem" aria-disabled="true" className="px-2 py-2">
                  <span className="text-destructive text-xs">
                    {loadErrorMessage}
                  </span>
                </div>
              )}
              {sessions.length === 0 && !loadError ? (
                <div role="menuitem" aria-disabled="true" className="px-2 py-2">
                  <span className="text-muted-foreground text-xs">
                    {t("chat.noHistory")}
                  </span>
                </div>
              ) : (
                renderedSessions.map((session, index) => (
                  <div
                    key={session.id}
                    ref={(node) => {
                      sessionItemRefs.current[index] = node
                    }}
                    role="menuitem"
                    tabIndex={focusedSessionIndex === index ? 0 : -1}
                    className={cn(
                      "group focus:bg-accent focus:text-accent-foreground relative my-0.5 flex cursor-default flex-col items-start gap-0.5 rounded-md px-2 py-2 pr-9 outline-none select-none",
                      session.id === activeSessionId && "bg-accent",
                    )}
                    onFocus={() => setFocusedSessionIndex(index)}
                    onClick={() => {
                      setMenuOpen(false)
                      onSwitchSession(session.id)
                    }}
                    onKeyDown={(event) =>
                      handleSessionKeyDown(event, session.id, index)
                    }
                  >
                    <span className="flex max-w-full min-w-0 items-center gap-1.5">
                      {session.isPinned && (
                        <IconPinned
                          className="text-muted-foreground size-3.5 shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      <span className="line-clamp-1 text-sm font-medium">
                        {session.title}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t("chat.messagesCount", {
                        count: session.message_count,
                      })}{" "}
                      - {dayjs(session.updated).fromNow()}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("chat.historyActions.open", {
                            defaultValue: "Session actions",
                          })}
                          className="text-muted-foreground hover:bg-accent/70 hover:text-foreground absolute top-1/2 right-1.5 size-7 -translate-y-1/2 opacity-100 transition-colors"
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                          }}
                        >
                          <IconDotsVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        sideOffset={4}
                        className="w-36"
                      >
                        <DropdownMenuItem
                          onSelect={() => {
                            togglePinSession(session.id)
                          }}
                        >
                          <IconPinned className="size-4" />
                          {session.isPinned
                            ? t("chat.historyActions.unpin", {
                                defaultValue: "Unpin",
                              })
                            : t("chat.historyActions.pin", {
                                defaultValue: "Pin",
                              })}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            openRenameDialog(session)
                          }}
                        >
                          <IconPencil className="size-4" />
                          {t("chat.historyActions.rename", {
                            defaultValue: "Rename",
                          })}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            void shareSession(session)
                          }}
                        >
                          <IconShare3 className="size-4" />
                          {t("chat.historyActions.share", {
                            defaultValue: "Share",
                          })}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => {
                            setDeleteTarget(session)
                            setMenuOpen(false)
                          }}
                        >
                          <IconTrash className="size-4" />
                          {t("chat.historyActions.delete", {
                            defaultValue: "Delete",
                          })}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))
              )}
              {hasMore && sessions.length > 0 && (
                <div ref={observerRef} className="py-2 text-center">
                  <span className="text-muted-foreground animate-pulse text-xs">
                    {t("chat.loadingMore")}
                  </span>
                </div>
              )}
            </ScrollArea>
          </div>,
          document.body,
        )}
      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setRenameTarget(null)
          }
        }}
      >
        <DialogContent>
          <form onSubmit={submitRename} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>
                {t("chat.historyActions.rename", { defaultValue: "Rename" })}
              </DialogTitle>
              <DialogDescription>
                {t("chat.historyActions.renameDescription", {
                  defaultValue: "Set a local display name for this session.",
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <label
                htmlFor="session-rename-title"
                className="text-sm font-medium"
              >
                {t("chat.historyActions.renameLabel", {
                  defaultValue: "Session name",
                })}
              </label>
              <Input
                id="session-rename-title"
                name="session_name"
                value={renameTitle}
                onChange={(event) => setRenameTitle(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameTarget(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!renameTitle.trim()}>
                {t("common.save", { defaultValue: "Save" })}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setDeleteTarget(null)
          }
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat.historyActions.deleteConfirmTitle", {
                defaultValue: "Delete session?",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat.historyActions.deleteConfirmDescription", {
                defaultValue:
                  "This session will be removed from history. This cannot be undone.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmDeleteSession}
            >
              {t("chat.historyActions.delete", { defaultValue: "Delete" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
