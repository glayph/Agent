import {
  IconActivityHeartbeat,
  IconAtom,
  IconBrain,
  IconBroadcast,
  IconClockPlay,
  IconKey,
  IconListDetails,
  IconPuzzle,
  IconSettings,
  IconSparkles,
  IconTools,
} from "@tabler/icons-react"
import { Link, useRouterState } from "@tanstack/react-router"
import { type CSSProperties, type ComponentType, useEffect } from "react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/shared/ui/sidebar"

interface PluginNavItem {
  label: string
  to: string
  icon: ComponentType<{ className?: string }>
}

const pluginNavGroups: Array<{
  label: string
  items: PluginNavItem[]
}> = [
  {
    label: "Plugin catalog",
    items: [{ label: "Catalog", to: "/plugins", icon: IconPuzzle }],
  },
  {
    label: "Adapters",
    items: [
      { label: "Providers & Models", to: "/models", icon: IconAtom },
      { label: "Credentials", to: "/credentials", icon: IconKey },
      { label: "Channels", to: "/channels", icon: IconBroadcast },
      { label: "Skills", to: "/agent/skills", icon: IconSparkles },
      { label: "Tools", to: "/agent/tools", icon: IconTools },
    ],
  },
  {
    label: "Core services",
    items: [
      { label: "Memory", to: "/memory", icon: IconBrain },
      { label: "Configuration", to: "/config", icon: IconSettings },
      { label: "Automation", to: "/agent/automations", icon: IconClockPlay },
      { label: "Health", to: "/health", icon: IconActivityHeartbeat },
      { label: "Logs", to: "/logs", icon: IconListDetails },
    ],
  },
]

function isActivePath(pathname: string, url: string): boolean {
  return pathname === url || (url !== "/" && pathname.startsWith(`${url}/`))
}

export function PluginSidebar({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onOpenChange, open])

  if (!open) return null

  return (
    <>
      <button
        type="button"
        aria-label="Close Plugin navigation"
        className="plugin-sidebar__scrim fixed inset-0 z-40 cursor-default"
        onClick={() => onOpenChange(false)}
      />
      <div className="plugin-sidebar__position fixed inset-y-0 left-0 z-50 w-[min(20rem,calc(100vw-1rem))] md:left-16 md:w-80">
        <SidebarProvider
          defaultOpen
          open={true}
          onOpenChange={onOpenChange}
          className="h-full w-full"
        >
          <Sidebar
            side="left"
            variant="floating"
            collapsible="none"
            style={{ "--sidebar-width": "320px" } as CSSProperties}
            className="plugin-sidebar h-full w-full border-r shadow-none"
          >
            <SidebarHeader className="plugin-sidebar__header flex h-16 flex-row items-center justify-between border-b px-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="plugin-sidebar__mark flex size-7 shrink-0 items-center justify-center rounded-sm">
                  <IconPuzzle className="size-3.5" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold tracking-tight">
                    {t("navigation.plugins")}
                  </p>
                  <p className="plugin-sidebar__eyebrow truncate text-[10px] tracking-[0.18em] uppercase">
                    Runtime surfaces
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="plugin-sidebar__close flex size-7 items-center justify-center rounded-sm"
                aria-label="Close Plugin navigation"
              >
                <span aria-hidden="true">×</span>
              </button>
            </SidebarHeader>
            <SidebarContent className="gap-0 px-3 py-4">
              {pluginNavGroups.map((group) => (
                <SidebarGroup key={group.label} className="px-0 py-3">
                  <SidebarGroupLabel className="plugin-sidebar__label h-6 px-2 text-[10px] font-semibold tracking-[0.18em] uppercase">
                    {group.label}
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu className="gap-0.5">
                      {group.items.map((item) => {
                        const Icon = item.icon
                        const active = isActivePath(pathname, item.to)
                        return (
                          <SidebarMenuItem key={item.to}>
                            <SidebarMenuButton
                              asChild
                              isActive={active}
                              tooltip={item.label}
                              className={cn(
                                "plugin-sidebar__item h-9 rounded-sm px-2 text-[13px]",
                                active && "active",
                              )}
                            >
                              <Link
                                to={item.to}
                                onClick={() => onOpenChange(false)}
                                aria-current={active ? "page" : undefined}
                              >
                                <Icon className="size-3.5" />
                                <span>{item.label}</span>
                                {active && (
                                  <span
                                    className="plugin-sidebar__active-dot"
                                    aria-hidden="true"
                                  />
                                )}
                              </Link>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        )
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </SidebarContent>
            <div className="plugin-sidebar__footer px-5 py-4 text-[11px]">
              <span className="plugin-sidebar__eyebrow">ESC</span>
              <span className="ml-2">Close navigation</span>
            </div>
          </Sidebar>
        </SidebarProvider>
      </div>
    </>
  )
}
