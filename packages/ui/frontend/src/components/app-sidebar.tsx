import {
  IconActivityHeartbeat,
  IconAtom,
  IconFolder,
  IconKey,
  IconListDetails,
  IconMessageCircle,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTimeline,
  IconTools,
  IconRobot,
} from "@tabler/icons-react"
import { Link, useRouterState } from "@tanstack/react-router"
import * as React from "react"
import { useTranslation } from "react-i18next"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// Material Design sidebar styles
const materialSidebarStyles = `
  .material-sidebar {
    background-color: var(--md-sys-color-surface);
    border-color: var(--md-sys-color-outline-variant);
  }
  .material-sidebar-nav-item {
    border-radius: var(--md-sys-radius-sm);
    color: var(--md-sys-color-on-surface-variant);
    transition: all 0.2s ease;
  }
  .material-sidebar-nav-item:hover {
    background-color: var(--md-sys-color-surface-variant);
    color: var(--md-sys-color-on-surface);
  }
  .material-sidebar-nav-item.active {
    background-color: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
  }
  .material-sidebar-header {
    border-color: var(--md-sys-color-outline-variant);
  }
  .material-sidebar-footer {
    border-color: var(--md-sys-color-outline-variant);
  }
`

interface NavItem {
  titleKey: string
  url: string
  icon: React.ComponentType<{ className?: string }>
}

const primaryNav: NavItem[] = [
  { titleKey: "navigation.chat", url: "/", icon: IconMessageCircle },
  { titleKey: "navigation.drive", url: "/drive", icon: IconFolder },
  { titleKey: "navigation.models", url: "/models", icon: IconAtom },
  { titleKey: "navigation.credentials", url: "/credentials", icon: IconKey },
  { titleKey: "navigation.hub", url: "/agent/hub", icon: IconSearch },
  { titleKey: "navigation.skills", url: "/agent/skills", icon: IconSparkles },
  { titleKey: "navigation.tools", url: "/agent/tools", icon: IconTools },
  { titleKey: "navigation.runs", url: "/agent/runs", icon: IconTimeline },
  { titleKey: "navigation.agents", url: "/agents", icon: IconRobot },
  { titleKey: "navigation.config", url: "/config", icon: IconSettings },
  { titleKey: "navigation.logs", url: "/logs", icon: IconListDetails },
  {
    titleKey: "navigation.health",
    url: "/health",
    icon: IconActivityHeartbeat,
  },
]

function isActivePath(pathname: string, url: string): boolean {
  return pathname === url || (url !== "/" && pathname.startsWith(`${url}/`))
}

function commandShortcutLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl K"
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "Cmd K" : "Ctrl K"
}

const WORKSPACE_SIDEBAR_TOGGLE_EVENT = "Hiro:toggle-workspace-sidebar"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const routerState = useRouterState()
  const { t } = useTranslation()
  const { isMobile, setOpenMobile } = useSidebar()
  const currentPath = routerState.location.pathname
  const commandShortcut = commandShortcutLabel()

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false)
  }

  const openCommand = () => {
    window.dispatchEvent(new Event("Hiro:command"))
    if (isMobile) setOpenMobile(false)
  }

  const handleNavClick = (
    item: NavItem,
    event: React.MouseEvent<HTMLAnchorElement>,
  ) => {
    if (item.url === "/" && currentPath === "/" && !isMobile) {
      event.preventDefault()
      window.dispatchEvent(new Event(WORKSPACE_SIDEBAR_TOGGLE_EVENT))
      return
    }

    closeMobileSidebar()
  }

  return (
    <>
      <style>{materialSidebarStyles}</style>
      <Sidebar
        {...props}
        collapsible={isMobile ? "offcanvas" : "none"}
        style={{ "--sidebar-width": "64px" } as React.CSSProperties}
        className="material-sidebar border-r"
      >
        <SidebarHeader className="material-sidebar-header flex h-14 items-center justify-center border-b px-0">
          <Link
            to="/"
            onClick={closeMobileSidebar}
            className="bg-primary/10 text-primary mx-auto flex size-10 items-center justify-center overflow-hidden rounded-xl border p-0 shadow-sm hover:bg-primary/20 transition-colors"
            aria-label="Hiro"
            title="Hiro"
          >
            <img
              src="/icon.png"
              alt=""
              aria-hidden="true"
              draggable={false}
              loading="eager"
              decoding="async"
              className="size-full rounded-[inherit] object-cover"
            />
          </Link>
        </SidebarHeader>

        <SidebarContent className="px-0 py-3">
          <SidebarMenu className="gap-1">
            {primaryNav.map((item) => {
              const Icon = item.icon
              const isActive = isActivePath(currentPath, item.url)
              const label = t(item.titleKey)
              return (
                <SidebarMenuItem key={item.url}>
                  <Tooltip delayDuration={250}>
                    <TooltipTrigger asChild>
                      <Link
                        to={item.url}
                        onClick={(event) => handleNavClick(item, event)}
                        aria-label={label}
                        title={label}
                        data-active={isActive}
                        className={cn(
                          "material-sidebar-nav-item mx-auto flex size-9 items-center justify-center border border-transparent",
                          isActive && "active",
                        )}
                      >
                        <Icon className="size-4" />
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="right">{label}</TooltipContent>
                  </Tooltip>
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarContent>

        <SidebarFooter className="material-sidebar-footer border-t px-0 py-3">
          <Tooltip delayDuration={250}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={openCommand}
                className="material-sidebar-nav-item mx-auto flex h-9 w-9 items-center justify-center border border-transparent"
                aria-label={t("command.open")}
                title={t("command.open")}
              >
                <IconSearch className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {t("command.open")}{" "}
              <span className="opacity-60">{commandShortcut}</span>
            </TooltipContent>
          </Tooltip>
        </SidebarFooter>
      </Sidebar>
    </>
  )
}
