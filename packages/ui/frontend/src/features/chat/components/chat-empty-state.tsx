import {
  IconPlugConnectedX,
  IconRobot,
  IconRobotOff,
  IconStar,
} from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/shared/ui/button"

interface ChatEmptyStateProps {
  hasAvailableModels: boolean
  defaultModelName: string
  isConnected: boolean
}

export function ChatEmptyState({
  hasAvailableModels,
  defaultModelName,
  isConnected,
}: ChatEmptyStateProps) {
  const { t } = useTranslation()
  let icon: ReactNode
  let title: string
  let description: string
  let action: ReactNode = null

  if (!hasAvailableModels) {
    icon = <IconRobotOff className="size-5" />
    title = t("chat.empty.noConfiguredModel")
    description = t("chat.empty.noConfiguredModelDescription")
    action = (
      <Button asChild size="sm" className="shrink-0">
        <Link to="/models">{t("chat.empty.goToModels")}</Link>
      </Button>
    )
  } else if (!defaultModelName) {
    icon = <IconStar className="size-5" />
    title = t("chat.empty.noSelectedModel")
    description = t("chat.empty.noSelectedModelDescription")
  } else if (!isConnected) {
    icon = <IconPlugConnectedX className="size-5" />
    title = t("chat.empty.notRunning")
    description = t("chat.empty.notRunningDescription")
  } else {
    icon = <IconRobot className="size-5" />
    title = t("chat.welcome")
    description = t("chat.welcomeDesc")
  }

  return (
    <div className="flex min-h-[8.25rem] flex-col justify-center gap-3 px-4 py-4 sm:min-h-[9rem] sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex min-w-0 items-start gap-3">
        <div className="bg-warning/10 text-warning border-warning/20 flex size-10 shrink-0 items-center justify-center rounded-lg border">
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="text-foreground text-[15px] leading-6 font-semibold">
            {title}
          </h3>
          <p className="text-muted-foreground mt-1 max-w-[28rem] text-sm leading-5 text-pretty">
            {description}
          </p>
        </div>
      </div>
      {action && <div className="pl-13 sm:pl-0">{action}</div>}
    </div>
  )
}
