import {
  IconDotsVertical,
  IconLayoutSidebarLeftCollapse,
  IconMessageCircle,
  IconPlus,
  IconStack2,
  IconTrash,
} from "@tabler/icons-react"
import dayjs from "dayjs"
import { type RefObject, useState } from "react"
import { useTranslation } from "react-i18next"

import type { SessionSummary } from "@/api/sessions"
import { SessionHistoryMenu } from "@/components/chat/session-history-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSidebar as useAppSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

interface SidebarProps {
  sessions: SessionSummary[]
  activeSessionId: string
  hasMore: boolean
  loadError: boolean
  loadErrorMessage: string
  observerRef: RefObject<HTMLDivElement | null>
  onNewSession: () => void
  onSwitchSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  onClose?: () => void
}

export function Sidebar({
  sessions,
  activeSessionId,
  hasMore,
  loadError,
  loadErrorMessage,
  observerRef,
  onNewSession,
  onSwitchSession,
  onDeleteSession,
  onClose,
}: SidebarProps) {
  const { t } = useTranslation()
  const { isMobile, setOpen, setOpenMobile } = useAppSidebar()
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)

  const handleNewSession = () => {
    onNewSession()
    onClose?.()
  }

  const handleSwitchSession = (sessionId: string) => {
    onSwitchSession(sessionId)
    onClose?.()
  }

  const handleToggleAppSidebar = () => {
    onClose?.()
    window.setTimeout(() => {
      if (isMobile) {
        setOpenMobile(true)
      } else {
        setOpen(true)
      }
    }, 150)
  }

  const confirmDeleteSession = () => {
    if (!deleteTarget) {
      return
    }

    onDeleteSession(deleteTarget.id)
    setDeleteTarget(null)
  }

  return (
    <>
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div className="border-sidebar-border flex h-14 shrink-0 items-center gap-3 border-b px-3">
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="bg-foreground text-background hover:bg-sidebar-accent hover:text-sidebar-accent-foreground size-8 shrink-0"
              onClick={handleToggleAppSidebar}
              aria-label={t("navigation.toggle_sidebar", {
                defaultValue: "Toggle sidebar",
              })}
              title={t("navigation.toggle_sidebar", {
                defaultValue: "Toggle sidebar",
              })}
            >
              <IconLayoutSidebarLeftCollapse className="size-4" />
            </Button>
          ) : (
            <div className="bg-foreground text-background flex size-8 shrink-0 items-center justify-center rounded-md text-[12px] font-semibold">
              O
            </div>
          )}
          <div className="min-w-0">
            <div className="text-sidebar-foreground truncate text-sm font-semibold">
              Hiro
            </div>
            <div className="text-muted-foreground truncate text-[11px] leading-none">
              {t("chat.workspace.agentConsole", {
                defaultValue: "Agent console",
              })}
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center">
            <SessionHistoryMenu
              sessions={sessions}
              activeSessionId={activeSessionId}
              hasMore={hasMore}
              loadError={loadError}
              loadErrorMessage={loadErrorMessage}
              observerRef={observerRef}
              onOpenChange={() => undefined}
              onSwitchSession={handleSwitchSession}
              onDeleteSession={onDeleteSession}
              compact
            />
          </div>
        </div>

        <div className="border-sidebar-border border-b px-3 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-sidebar-border bg-sidebar-accent/45 text-sidebar-accent-foreground hover:bg-sidebar-accent h-8 w-full justify-start gap-2"
            onClick={handleNewSession}
          >
            <IconPlus className="size-4" />
            {t("chat.newChat", { defaultValue: "New Session" })}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium tracking-wide uppercase">
            <IconStack2 className="size-3.5" />
            {t("chat.workspace.workspaces", { defaultValue: "Workspaces" })}
          </div>

          {loadError && (
            <div className="text-destructive px-2 py-2 text-xs">
              {loadErrorMessage}
            </div>
          )}

          {!loadError && sessions.length === 0 && (
            <div className="text-muted-foreground px-2 py-2 text-xs">
              {t("chat.noHistory", { defaultValue: "No sessions yet" })}
            </div>
          )}

          <div className="flex flex-col gap-0.5">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId

              return (
                <div
                  key={session.id}
                  className={cn(
                    "group/session relative rounded-md border border-transparent",
                    isActive &&
                      "border-sidebar-border bg-sidebar-accent/70 text-sidebar-accent-foreground",
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      "flex w-full min-w-0 items-start gap-1.5 rounded-md px-1.5 py-1 pr-7 text-left transition-colors",
                      isActive
                        ? "text-sidebar-accent-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent/55 hover:text-sidebar-accent-foreground",
                    )}
                    onClick={() => handleSwitchSession(session.id)}
                  >
                    <IconMessageCircle className="text-muted-foreground mt-0.5 size-3 shrink-0" />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="line-clamp-1 text-[12px] leading-4 font-medium">
                        {session.title ||
                          t("chat.workspace.untitledSession", {
                            defaultValue: "Untitled session",
                          })}
                      </span>
                      <span className="text-muted-foreground line-clamp-1 text-[10.5px] leading-3">
                        {t("chat.messagesCount", {
                          count: session.message_count,
                        })}{" "}
                        - {dayjs(session.updated).fromNow()}
                      </span>
                    </span>
                  </button>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("chat.historyActions.open", {
                          defaultValue: "Session actions",
                        })}
                        title={t("chat.historyActions.open", {
                          defaultValue: "Session actions",
                        })}
                        className="text-muted-foreground hover:text-foreground absolute top-1.5 right-1 opacity-100"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <IconDotsVertical className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36">
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeleteTarget(session)}
                      >
                        <IconTrash className="size-4" />
                        {t("chat.historyActions.delete", {
                          defaultValue: "Delete",
                        })}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )
            })}
          </div>

          {hasMore && sessions.length > 0 && (
            <div ref={observerRef} className="py-3 text-center">
              <span className="text-muted-foreground animate-pulse text-[11px]">
                {t("chat.loadingMore", { defaultValue: "Loading more" })}
              </span>
            </div>
          )}
        </div>
      </div>
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
