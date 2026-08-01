import { IconSearch } from "@tabler/icons-react"
import { type ReactNode, useMemo } from "react"
import { useTranslation } from "react-i18next"

import { GlobalHeaderActions } from "@/app/layout/global-header-actions"
import { Button } from "@/shared/ui/button"
import { SidebarTrigger } from "@/shared/ui/sidebar"
import { cn } from "@/lib/utils"

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

// Material Design typography styles
const materialStyles = `
  .page-header-title {
    font: var(--md-sys-typescale-title-large);
    color: var(--md-sys-color-on-surface);
  }
  .page-header-surface {
    background-color: var(--md-sys-color-surface);
    border-bottom-color: var(--md-sys-color-outline-variant);
  }
`

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
    window.dispatchEvent(new Event("Hiro:command"))
  }

  return (
    <>
      <style>{materialStyles}</style>
      <div
        className={cn(
          "page-header-surface z-20 flex h-14 min-h-14 shrink-0 items-center justify-between gap-3 border-b px-3 sm:px-5",
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
            className={cn(
              "page-header-title min-w-0 truncate",
              titleClassName,
            )}
          >
            {title}
          </TitleTag>
          {titleExtra}
        </div>
        <div
          className={cn(
            "flex min-w-0 items-center justify-end gap-1.5 overflow-x-auto whitespace-nowrap",
            rightClassName,
          )}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openCommand}
            className="text-muted-foreground hidden h-8 gap-2 rounded-md px-2.5 text-xs lg:inline-flex"
            aria-label={t("command.open")}
            title={t("command.open")}
          >
            <IconSearch className="size-3.5" />
            <span>{t("command.search")}</span>
            <kbd className="border-border bg-muted text-muted-foreground rounded border px-1 text-[10px] font-medium">
              {commandShortcut}
            </kbd>
          </Button>
          {children}
          <GlobalHeaderActions />
        </div>
      </div>
    </>
  )
}
