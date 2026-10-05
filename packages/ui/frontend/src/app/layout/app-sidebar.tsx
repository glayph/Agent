import { Link, useRouterState } from "@tanstack/react-router"
import * as React from "react"
import { useTranslation } from "react-i18next"

import {
  secondaryNavigation,
  utilityNavigation,
  type AppNavigationItem,
} from "@/app/layout/app-navigation"
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

function isActivePath(pathname: string, url: string): boolean {
  return pathname === url || (url !== "/" && pathname.startsWith(`${url}/`))
}

const WORKSPACE_SIDEBAR_TOGGLE_EVENT = "Miki:toggle-workspace-sidebar"

function NavList({
  items,
  currentPath,
  onClick,
  t,
  showLabels = false,
}: {
  items: AppNavigationItem[]
  currentPath: string
  onClick: (item: AppNavigationItem, event: React.MouseEvent<HTMLAnchorElement>) => void
  t: (key: string) => string
  showLabels?: boolean
}) {
  return (
    <SidebarMenu className="gap-1">
      {items.map((item) => {
        const Icon = item.icon
        const isActive = isActivePath(currentPath, item.url)
        const label = t(item.titleKey)
        const link = (
          <Link
            to={item.url}
            onClick={(event) => onClick(item, event)}
            aria-label={label}
            title={showLabels ? undefined : label}
            data-active={isActive}
            className={cn(
              "miki-sidebar__nav-item mx-auto flex items-center border border-transparent",
              showLabels
                ? "w-full justify-start gap-3 rounded-lg px-3"
                : "size-9 justify-center",
              isActive && "active",
            )}
          >
            <Icon className="size-4 shrink-0" />
            {showLabels && <span className="miki-sidebar__nav-label truncate">{label}</span>}
          </Link>
        )

        return (
          <SidebarMenuItem key={item.url}>
            {showLabels ? (
              link
            ) : (
              <Tooltip delayDuration={250}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            )}
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const routerState = useRouterState()
  const { t } = useTranslation()
  const { isMobile, setOpenMobile } = useSidebar()
  const currentPath = routerState.location.pathname

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false)
  }

  const handleNavClick = (
    item: AppNavigationItem,
    event: React.MouseEvent<HTMLAnchorElement>,
  ) => {
    if (item.url === "/" && currentPath === "/" && !isMobile) {
      event.preventDefault()
      window.dispatchEvent(new Event(WORKSPACE_SIDEBAR_TOGGLE_EVENT))
      return
    }

    closeMobileSidebar()
  }

  const mainNavigation = secondaryNavigation.filter(
    (item) => !utilityNavigation.some((utility) => utility.id === item.id),
  )

  return (
    <Sidebar
      {...props}
      collapsible={isMobile ? "offcanvas" : "none"}
      style={
        { "--sidebar-width": isMobile ? "17rem" : "var(--app-rail-width)" } as React.CSSProperties
      }
      className="miki-sidebar border-r"
    >
      <SidebarHeader className="miki-sidebar__header flex h-[var(--app-topbar-height)] items-center justify-center border-b px-0">
        <Link
          to="/"
          onClick={closeMobileSidebar}
          className={cn(
            "miki-sidebar__brand flex size-9 items-center justify-center overflow-hidden rounded-md border p-0 transition-colors",
            isMobile ? "mx-0" : "mx-auto",
          )}
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
        {isMobile && <span className="miki-sidebar__brand-label">Agent Miki</span>}
      </SidebarHeader>

      <SidebarContent className="px-0 py-3">
        <NavList
          items={mainNavigation}
          currentPath={currentPath}
          onClick={handleNavClick}
          t={t}
          showLabels={isMobile}
        />
      </SidebarContent>

      <SidebarFooter className="miki-sidebar__footer border-t px-0 py-2">
        <NavList
          items={utilityNavigation}
          currentPath={currentPath}
          onClick={handleNavClick}
          t={t}
          showLabels={isMobile}
        />
      </SidebarFooter>
    </Sidebar>
  )
}
