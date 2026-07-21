import { type ReactNode, useEffect, useState } from "react"

import { ResizableSidebarSplitter } from "@/components/resizable-sidebar-splitter"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

const WORKSPACE_SIDEBAR_STORAGE_KEY = "Hiro:workspace-sidebar-width"
const WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_KEY =
  "Hiro:workspace-sidebar-collapsed"
const WORKSPACE_SIDEBAR_DEFAULT_WIDTH = 240
const WORKSPACE_SIDEBAR_MIN_WIDTH = 208
const WORKSPACE_SIDEBAR_MAX_WIDTH = 420
const WORKSPACE_SIDEBAR_COLLAPSE_WIDTH = 168
const WORKSPACE_SIDEBAR_TOGGLE_EVENT = "Hiro:toggle-workspace-sidebar"

function clampWorkspaceSidebarWidth(value: number) {
  return Math.min(
    WORKSPACE_SIDEBAR_MAX_WIDTH,
    Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH, Math.round(value)),
  )
}

function getInitialWorkspaceSidebarWidth() {
  if (typeof window === "undefined") return WORKSPACE_SIDEBAR_DEFAULT_WIDTH

  const storedWidth = Number(
    window.localStorage.getItem(WORKSPACE_SIDEBAR_STORAGE_KEY),
  )

  return Number.isFinite(storedWidth)
    ? clampWorkspaceSidebarWidth(storedWidth)
    : WORKSPACE_SIDEBAR_DEFAULT_WIDTH
}

function getInitialWorkspaceSidebarCollapsed() {
  if (typeof window === "undefined") return false
  return (
    window.localStorage.getItem(WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_KEY) ===
    "true"
  )
}

function useDesktopInspector() {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(min-width: 1280px)").matches,
  )

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)")
    const handleChange = () => setIsDesktop(media.matches)

    handleChange()
    media.addEventListener("change", handleChange)
    return () => media.removeEventListener("change", handleChange)
  }, [])

  return isDesktop
}

interface WorkspaceShellProps {
  sidebar: ReactNode
  mobileSidebar: ReactNode
  header: ReactNode
  activityStream: ReactNode
  composer: ReactNode
  rightPanel: ReactNode
  leftSidebarOpen: boolean
  rightPanelOpen: boolean
  isMobile: boolean
  onLeftSidebarOpenChange: (open: boolean) => void
  onRightPanelOpenChange: (open: boolean) => void
}

export function WorkspaceShell({
  sidebar,
  mobileSidebar,
  header,
  activityStream,
  composer,
  rightPanel,
  leftSidebarOpen,
  rightPanelOpen,
  isMobile,
  onLeftSidebarOpenChange,
  onRightPanelOpenChange,
}: WorkspaceShellProps) {
  const isDesktopInspector = useDesktopInspector()
  const useInspectorSheet = rightPanelOpen && !isDesktopInspector
  const [sidebarWidth, setSidebarWidth] = useState(
    getInitialWorkspaceSidebarWidth,
  )
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(
    getInitialWorkspaceSidebarCollapsed,
  )
  const shouldShowDesktopSidebar = !isMobile && !desktopSidebarCollapsed

  const setPersistedDesktopSidebarCollapsed = (collapsed: boolean) => {
    setDesktopSidebarCollapsed(collapsed)
    try {
      window.localStorage.setItem(
        WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_KEY,
        String(collapsed),
      )
    } catch {
      // Persisting layout preference is optional.
    }
  }

  const setPersistedSidebarWidth = (width: number) => {
    const nextWidth = clampWorkspaceSidebarWidth(width)
    setSidebarWidth(nextWidth)
    try {
      window.localStorage.setItem(WORKSPACE_SIDEBAR_STORAGE_KEY, String(nextWidth))
    } catch {
      // Persisting layout preference is optional.
    }
  }

  useEffect(() => {
    const handleToggle = () => {
      if (isMobile) return
      setPersistedDesktopSidebarCollapsed(!desktopSidebarCollapsed)
    }

    window.addEventListener(WORKSPACE_SIDEBAR_TOGGLE_EVENT, handleToggle)
    return () => {
      window.removeEventListener(WORKSPACE_SIDEBAR_TOGGLE_EVENT, handleToggle)
    }
  }, [desktopSidebarCollapsed, isMobile])

  return (
    <div
      data-workspace-shell="true"
      className="bg-background flex h-full min-h-0 overflow-hidden"
    >
      {shouldShowDesktopSidebar && (
        <aside
          id="workspace-sidebar"
          className="bg-sidebar/95 border-border/70 hidden shrink-0 border-r md:flex"
          style={{ width: `${sidebarWidth}px` }}
        >
          {sidebar}
        </aside>
      )}

      {shouldShowDesktopSidebar && (
        <ResizableSidebarSplitter
          width={sidebarWidth}
          minWidth={WORKSPACE_SIDEBAR_MIN_WIDTH}
          maxWidth={WORKSPACE_SIDEBAR_MAX_WIDTH}
          onWidthChange={setSidebarWidth}
          collapseBelowWidth={WORKSPACE_SIDEBAR_COLLAPSE_WIDTH}
          onCollapse={(restoreWidth) => {
            setPersistedSidebarWidth(restoreWidth)
            setPersistedDesktopSidebarCollapsed(true)
          }}
          controls="workspace-sidebar"
          label="Resize workspace sidebar"
          storageKey={WORKSPACE_SIDEBAR_STORAGE_KEY}
        />
      )}

      <Sheet
        open={isMobile && leftSidebarOpen}
        onOpenChange={onLeftSidebarOpenChange}
      >
        <SheetContent
          side="left"
          showCloseButton={false}
          className="bg-sidebar border-border w-[min(88vw,19rem)] gap-0 p-0"
        >
          <SheetTitle className="sr-only">Workspaces</SheetTitle>
          <SheetDescription className="sr-only">
            Session and workspace navigation
          </SheetDescription>
          {mobileSidebar}
        </SheetContent>
      </Sheet>

      <section className="flex min-w-0 flex-1 flex-col">
        {header}
        <div className="min-h-0 flex-1">{activityStream}</div>
        {composer}
      </section>

      {rightPanelOpen && isDesktopInspector && (
        <aside className="border-border/70 bg-card/80 hidden w-[20rem] shrink-0 border-l xl:flex">
          {rightPanel}
        </aside>
      )}

      <Sheet open={useInspectorSheet} onOpenChange={onRightPanelOpenChange}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          showCloseButton={false}
          className={cn(
            "border-border bg-card gap-0 p-0",
            isMobile
              ? "max-h-[82svh] rounded-t-lg"
              : "w-[min(88vw,22rem)] sm:max-w-[22rem]",
          )}
        >
          <SheetTitle className="sr-only">Workspace Inspector</SheetTitle>
          <SheetDescription className="sr-only">
            Assets and context for the current workspace
          </SheetDescription>
          {rightPanel}
        </SheetContent>
      </Sheet>
    </div>
  )
}
