import { IconSearch } from "@tabler/icons-react"
import { type ReactNode, useMemo } from "react"
import { useTranslation } from "react-i18next"

import { GlobalHeaderActions } from "@/app/layout/global-header-actions"
import { cn } from "@/lib/utils"
import { Button } from "@/shared/ui/button"
import { SidebarTrigger } from "@/shared/ui/sidebar"

interface PageHeaderProps {
  title: string
  titleLevel?: 1 | 2
  titleExtra?: ReactNode
  children?: ReactNode
  className?: string
  leftClassName?: string
  rightClassName?: string
  titleClassName?: string
}

export function PageHeader({
  title,
  titleLevel = 2,
  titleExtra,
  children,
  className,
  leftClassName,
  rightClassName,
  titleClassName,
}: PageHeaderProps) {
  const { t } = useTranslation()
  const TitleTag = titleLevel === 1 ? "h1" : "h2"
  const commandShortcut = useMemo(() => {
    if (typeof navigator === "undefined") return "Ctrl K"
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "Cmd K" : "Ctrl K"
  }, [])
  const openCommand = () => {
    window.dispatchEvent(new Event("Miki:command"))
  }

  return (
    <div
      data-miki-topbar="true"
      data-page-header="true"
      className={cn(
        "page-header-surface miki-topbar z-20 flex h-[var(--app-topbar-height)] min-h-[var(--app-topbar-height)] shrink-0 items-center justify-between gap-3 border-b px-[var(--app-content-gutter)]",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 sm:gap-3",
          leftClassName,
        )}
      >
        <SidebarTrigger
          className="size-8 shrink-0 rounded-md md:hidden"
          aria-label={t("navigation.toggle_sidebar")}
          title={t("navigation.toggle_sidebar")}
        />
        <TitleTag
          data-page-title="true"
          className={cn("page-header-title min-w-0 truncate", titleClassName)}
        >
          {title}
        </TitleTag>
        {titleExtra}
      </div>
      <div
        data-page-actions="true"
        className={cn(
          "flex min-w-0 items-center justify-end gap-1.5 overflow-x-auto whitespace-nowrap",
          rightClassName,
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={openCommand}
          className="text-muted-foreground hover:text-foreground hidden size-8 rounded-md lg:inline-flex"
          aria-label={`${t("command.search")} (${commandShortcut})`}
          title={`${t("command.search")} (${commandShortcut})`}
        >
          <IconSearch className="size-4" />
        </Button>
        {children}
        <GlobalHeaderActions />
      </div>
    </div>
  )
}
