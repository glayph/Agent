import {
  IconLayoutSidebarLeftCollapse,
  IconMessageCircle,
} from "@tabler/icons-react"
import type { RefObject } from "react"
import { useTranslation } from "react-i18next"

import type { SessionSummary } from "@/api/sessions"
import { Button } from "@/shared/ui/button"
import { useSidebar as useAppSidebar } from "@/shared/ui/sidebar"

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

/**
 * Miki intentionally exposes one persistent conversation. The historical
 * session controls remain available in the data layer for compatibility, but
 * they are not rendered and therefore cannot create or switch conversations.
 */
export function Sidebar(props: SidebarProps) {
  const { t } = useTranslation()
  const { isMobile, setOpen, setOpenMobile } = useAppSidebar()
  const { onClose } = props

  // Keep the public prop contract stable for callers while disabling the
  // multi-session actions in the single-chat product surface.
  void props.sessions
  void props.activeSessionId
  void props.hasMore
  void props.loadError
  void props.loadErrorMessage
  void props.observerRef
  void props.onNewSession
  void props.onSwitchSession
  void props.onDeleteSession

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

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[#ecece8] px-4">
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 rounded-full bg-[#242422] text-white hover:bg-[#3b3b37]"
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
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#242422] text-[11px] font-semibold text-white">
            O
          </div>
        )}
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[#242422]">
            Miki
          </div>
          <div className="truncate text-[10px] leading-none text-[#999992]">
            {t("chat.workspace.agentConsole", {
              defaultValue: "Agent console",
            })}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 px-4 py-5">
        <div className="flex items-start gap-2 rounded-xl border border-[#ecece8] bg-white/70 px-3 py-3 shadow-[0_1px_2px_rgba(30,30,25,0.03)]">
          <IconMessageCircle className="mt-0.5 size-4 shrink-0 text-[#777771]" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[#242422]">
              {t("chat.workspace.singleChat", { defaultValue: "Single chat" })}
            </div>
            <p className="text-muted-foreground mt-1 text-[11px] leading-4">
              {t("chat.workspace.singleChatDescription", {
                defaultValue:
                  "This is Miki's only conversation. Continue here while tasks run; follow-up messages are queued safely.",
              })}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
