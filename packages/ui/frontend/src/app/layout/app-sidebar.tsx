import { Link, useRouterState } from "@tanstack/react-router"
import * as React from "react"
import { useTranslation } from "react-i18next"

import {
  secondaryNavigation,
  sidebarNavigationGroups,
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
  SidebarTrigger,
  useSidebar,
} from "@/shared/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

function isActivePath(pathname: string, url: string): boolean {
  return pathname === url || (url !== "/" && pathname.startsWith(`${url}/`))
}

const WORKSPACE_SIDEBAR_TOGGLE_EVENT = "Miki:toggle-workspace-sidebar"

const navigationById = new Map(
  secondaryNavigation.map((item) => [item.id, item] as const),
)
const resolvedSidebarGroups = sidebarNavigationGroups.map((group) => ({
  ...group,
  items: group.itemIds.flatMap((id) => {
    const item = navigationById.get(id)
    return item ? [item] : []
  }),
}))

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
            aria-current={isActive ? "page" : undefined}
            title={showLabels ? undefined : label}
            data-labels={showLabels ? "true" : "false"}
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
  const currentPath = useRouterState({
    select: (state) => state.location.pathname,
  })
  const { t } = useTranslation()
  const { isMobile, setOpenMobile, state } = useSidebar()
  const showLabels = isMobile || state === "expanded"

  const closeMobileSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile(false)
  }, [isMobile, setOpenMobile])

  const handleNavClick = React.useCallback((
    item: AppNavigationItem,
    event: React.MouseEvent<HTMLAnchorElement>,
  ) => {
    if (item.url === "/" && currentPath === "/" && !isMobile) {
      event.preventDefault()
      window.dispatchEvent(new Event(WORKSPACE_SIDEBAR_TOGGLE_EVENT))
      return
    }

    closeMobileSidebar()
  }, [closeMobileSidebar, currentPath, isMobile])

  return (
    <Sidebar
      {...props}
      collapsible={isMobile ? "offcanvas" : "icon"}
      style={isMobile ? ({ "--sidebar-width": "17rem" } as React.CSSProperties) : undefined}
      className="miki-sidebar border-r"
    >
      <SidebarHeader className={cn("miki-sidebar__header relative flex h-[var(--app-topbar-height)] items-center border-b px-2", showLabels ? "justify-between" : "justify-center")}>
        <Link
          to="/"
          onClick={closeMobileSidebar}
          className={cn("miki-sidebar__brand-row flex min-w-0 items-center gap-2 rounded-md p-0 transition-colors", showLabels ? "justify-start" : "justify-center")}
          aria-label="Miki"
          title="Miki"
        >
          <span className="miki-sidebar__brand" aria-hidden="true">
            <img
              src="/icon.png"
              alt=""
              draggable={false}
              loading="eager"
              decoding="async"
              className="size-full rounded-[inherit] object-cover"
            />
          </span>
          {showLabels && (
            <span className="miki-sidebar__brand-label">
              <strong>Agent Miki</strong>
              <small>{t("navigation.control")}</small>
            </span>
          )}
        </Link>
        <SidebarTrigger className={cn("miki-sidebar__toggle shrink-0", !showLabels && "absolute top-1.5 right-1")} aria-label="Toggle sidebar" title="Toggle sidebar" />
      </SidebarHeader>

      <SidebarContent className="miki-sidebar__content px-2 py-3">
        {resolvedSidebarGroups.map((group) => {
          const items = group.items
          if (items.length === 0) return null
          const groupLabel = t(group.titleKey)
          return (
            <section
              key={group.id}
              className="miki-sidebar__group"
              aria-label={groupLabel}
            >
              {showLabels && (
                <div className="miki-sidebar__group-title">{groupLabel}</div>
              )}
              <NavList
                items={items}
                currentPath={currentPath}
                onClick={handleNavClick}
                t={t}
                showLabels={showLabels}
              />
            </section>
          )
        })}
      </SidebarContent>

      {utilityNavigation.length > 0 && (
        <SidebarFooter className="miki-sidebar__footer border-t px-3 py-2">
          <NavList
            items={utilityNavigation}
            currentPath={currentPath}
            onClick={handleNavClick}
            t={t}
            showLabels={showLabels}
          />
        </SidebarFooter>
      )}
    </Sidebar>
  )
}
