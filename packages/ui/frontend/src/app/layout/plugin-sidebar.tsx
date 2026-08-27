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
        className="fixed inset-0 z-40 cursor-default bg-black/10 md:bg-transparent"
        onClick={() => onOpenChange(false)}
      />
      <div className="fixed inset-y-3 left-3 z-50 w-[min(18rem,calc(100vw-1.5rem))] md:left-[4.5rem]">
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
            style={{ "--sidebar-width": "288px" } as CSSProperties}
            className="material-sidebar h-full w-full border shadow-xl"
          >
            <SidebarHeader className="material-sidebar-header flex h-14 flex-row items-center gap-3 border-b px-4">
              <div className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg">
                <IconPuzzle className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {t("navigation.plugins")}
                </p>
                <p className="text-muted-foreground truncate text-[11px]">
                  Modular capabilities
                </p>
              </div>
            </SidebarHeader>
            <SidebarContent className="gap-0 px-2 py-3">
              {pluginNavGroups.map((group) => (
                <SidebarGroup key={group.label} className="py-2">
                  <SidebarGroupLabel className="text-muted-foreground px-2 text-[10px] font-semibold tracking-[0.16em] uppercase">
                    {group.label}
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu className="gap-1">
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
                                "h-9 font-mono text-xs",
                                active && "bg-primary/10 text-primary",
                              )}
                            >
                              <Link
                                to={item.to}
                                onClick={() => onOpenChange(false)}
                                aria-current={active ? "page" : undefined}
                              >
                                <Icon className="size-4" />
                                <span>{item.label}</span>
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
          </Sidebar>
        </SidebarProvider>
      </div>
    </>
  )
}
