import {
  IconActivity,
  IconFolder,
  IconMessageCircle,
  IconPuzzle,
  IconSearch,
  IconSettings,
} from "@tabler/icons-react"
import { Link, useRouterState } from "@tanstack/react-router"
import * as React from "react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from "@/shared/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

import { PluginSidebar } from "./plugin-sidebar"

interface NavItem {
  titleKey: string
  url: string
  icon: React.ComponentType<{ className?: string }>
  kind?: "link" | "plugin"
}

const primaryNav: NavItem[] = [
  { titleKey: "navigation.chat", url: "/", icon: IconMessageCircle },
  { titleKey: "navigation.file", url: "/drive", icon: IconFolder },
  { titleKey: "navigation.search", url: "/agent/hub", icon: IconSearch },
  { titleKey: "navigation.settings", url: "/config", icon: IconSettings },
  {
    titleKey: "navigation.plugins",
    url: "/plugins",
    icon: IconPuzzle,
    kind: "plugin",
  },
  { titleKey: "navigation.health", url: "/health", icon: IconActivity },
]

function isActivePath(pathname: string, url: string): boolean {
  return pathname === url || (url !== "/" && pathname.startsWith(`${url}/`))
}

const WORKSPACE_SIDEBAR_TOGGLE_EVENT = "Miki:toggle-workspace-sidebar"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const routerState = useRouterState()
  const { t } = useTranslation()
  const { isMobile, setOpenMobile } = useSidebar()
  const [pluginSidebarOpen, setPluginSidebarOpen] = React.useState(false)
  const currentPath = routerState.location.pathname
  const isPluginPath = [
    "/plugins",
    "/models",
    "/credentials",
    "/channels",
    "/agent/skills",
    "/agent/tools",
    "/memory",
    "/config",
    "/agent/automations",
    "/health",
    "/logs",
  ].some((path) => isActivePath(currentPath, path))

  const closeMobileSidebar = () => {
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
      <PluginSidebar
        open={pluginSidebarOpen}
        onOpenChange={setPluginSidebarOpen}
      />
      <Sidebar
        {...props}
        collapsible={isMobile ? "offcanvas" : "none"}
        style={{ "--sidebar-width": "64px" } as React.CSSProperties}
        className="miki-sidebar border-r"
      >
        <SidebarHeader className="miki-sidebar__header flex h-14 items-center justify-center border-b px-0">
          <Link
            to="/"
            onClick={closeMobileSidebar}
            className="miki-sidebar__brand mx-auto flex size-9 items-center justify-center overflow-hidden rounded-md border p-0 transition-colors"
            aria-label="Miki"
            title="Miki"
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
              if (item.kind === "plugin") {
                return (
                  <SidebarMenuItem key={item.url}>
                    <Tooltip delayDuration={250}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => setPluginSidebarOpen((open) => !open)}
                          aria-label={label}
                          aria-expanded={pluginSidebarOpen}
                          title={label}
                          data-active={pluginSidebarOpen || isPluginPath}
                          className={cn(
                            "miki-sidebar__nav-item mx-auto flex size-9 items-center justify-center border border-transparent",
                            (pluginSidebarOpen || isPluginPath) && "active",
                          )}
                        >
                          <Icon className="size-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">{label}</TooltipContent>
                    </Tooltip>
                  </SidebarMenuItem>
                )
              }
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
                          "miki-sidebar__nav-item mx-auto flex size-9 items-center justify-center border border-transparent",
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

        <SidebarFooter className="miki-sidebar__footer border-t px-0 py-3" />
      </Sidebar>
    </>
  )
}
