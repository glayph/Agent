import {
  IconAlertTriangle,
  IconCheck,
  IconLoader2,
  IconLogout,
  IconMenu2,
  IconMoon,
  IconPlayerPlay,
  IconPower,
  IconRefresh,
  IconSettings,
  IconSun,
} from "@tabler/icons-react"
import * as React from "react"
import { useTranslation } from "react-i18next"

import { postLauncherDashboardLogout } from "@/api/launcher-auth"
import { shutdownGateway } from "@/api/gateway"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog.tsx"
import { Button } from "@/shared/ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu.tsx"
import { useGateway } from "@/hooks/use-gateway.ts"
import { type ThemePreference, useTheme } from "@/hooks/use-theme.ts"

type ThemeOption = {
  value: ThemePreference
  label: string
  Icon: React.ComponentType<{ className?: string }>
}

export function GlobalHeaderActions() {
  const { t } = useTranslation()
  const { theme, preference, setTheme } = useTheme()
  const {
    state: gwState,
    loading: gwLoading,
    canStart,
    startReason,
    restartRequired,
    pendingRestartFields,
    start,
    restart,
    stop,
    error: gwError,
  } = useGateway()

  const isRunning = gwState === "running"
  const isStarting = gwState === "starting"
  const isRestarting = gwState === "restarting"
  const isStopping = gwState === "stopping"
  const processRestartFields = pendingRestartFields.filter(
    (field) => field === "gateway.port" || field === "gateway.host",
  )
  const requiresProcessRestart =
    restartRequired && processRestartFields.length > 0
  const restartHint = requiresProcessRestart
    ? t("header.gateway.processRestartRequired", {
        fields: processRestartFields.join(", "),
      })
    : null
  const showNotConnectedHint =
    !isRestarting &&
    !isStopping &&
    canStart &&
    (gwState === "stopped" || gwState === "error")

  const [showStopDialog, setShowStopDialog] = React.useState(false)
  const [showLogoutDialog, setShowLogoutDialog] = React.useState(false)

  const handleLogout = async () => {
    await postLauncherDashboardLogout()
    globalThis.location.assign("/launcher-login")
  }

  const handleShutdownBackend = async () => {
    if (confirm("Are you sure you want to completely shut down the backend daemon?")) {
      await shutdownGateway();
      alert("Backend shutting down. You can close this tab.");
    }
  };

  const handleGatewayToggle = () => {
    if (gwLoading || isRestarting || isStopping || (!isRunning && !canStart)) {
      return
    }
    if (isRunning) {
      setShowStopDialog(true)
    } else {
      void start()
    }
  }

  const handleGatewayRestart = () => {
    if (
      gwLoading ||
      isRestarting ||
      !isRunning ||
      !restartRequired ||
      !canStart ||
      requiresProcessRestart
    ) {
      return
    }
    void restart()
  }

  const confirmStop = () => {
    setShowStopDialog(false)
    stop()
  }

  const gatewaySummary = restartRequired
    ? t("header.gateway.action.restartApp")
    : isStopping
      ? t("header.gateway.status.stopping")
      : isRestarting
        ? t("header.gateway.status.restarting")
        : isStarting
          ? t("header.gateway.status.starting")
          : isRunning
            ? t("header.gateway.status.running")
            : t("header.gateway.action.start")
  const gatewayNotice =
    gwError ?? restartHint ?? (!canStart && startReason ? startReason : null)
  const gatewayBusy = gwLoading || isStarting || isRestarting || isStopping
  const gatewayActionLabel = isRunning
    ? t("header.gateway.action.stop")
    : isStopping
      ? t("header.gateway.status.stopping")
      : isRestarting
        ? t("header.gateway.status.restarting")
        : isStarting
          ? t("header.gateway.status.starting")
          : t("header.gateway.action.start")
  const themeOptions: ThemeOption[] = [
    {
      value: "system",
      label: t("header.appearance.system"),
      Icon: IconSettings,
    },
    {
      value: "light",
      label: t("header.appearance.light"),
      Icon: IconSun,
    },
    {
      value: "dark",
      label: t("header.appearance.dark"),
      Icon: IconMoon,
    },
  ]

  return (
    <>
      <AlertDialog open={showStopDialog} onOpenChange={setShowStopDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("header.gateway.stopDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("header.gateway.stopDialog.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmStop}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("header.gateway.stopDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showLogoutDialog} onOpenChange={setShowLogoutDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("header.logout.tooltip")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("header.logout.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleLogout()}>
              {t("header.logout.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex items-center gap-1.5">
        {showNotConnectedHint && (
          <div className="border-border text-muted-foreground bg-card hidden items-center gap-2 rounded-md border border-dashed px-3 py-1.5 text-xs xl:flex">
            <span className="bg-destructive/50 relative flex size-2 shrink-0 items-center justify-center rounded-full">
              <span className="bg-destructive absolute inline-flex size-full animate-ping rounded-full opacity-75"></span>
            </span>
            {t("chat.notConnected")}
          </div>
        )}

        <Button
          variant="destructive"
          size="sm"
          className="h-8 rounded-md px-3 text-xs"
          onClick={() => void handleShutdownBackend()}
        >
          Shutdown Backend
        </Button>

        <DropdownMenu>

          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hover:bg-accent/60 hover:text-foreground size-8 rounded-md"
              aria-label={t("header.menu.open")}
              title={t("header.menu.open")}
            >
              <IconMenu2 className="size-4.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            className="w-52 min-w-52 rounded-md p-1.5"
          >
            <div className="text-muted-foreground flex h-7 items-center gap-2 px-2 text-xs">
              {gatewayBusy ? (
                <IconLoader2 className="size-3.5 animate-spin" />
              ) : restartRequired ? (
                <IconAlertTriangle className="text-warning size-3.5" />
              ) : isRunning ? (
                <IconPower className="size-3.5" />
              ) : (
                <IconPlayerPlay className="size-3.5" />
              )}
              <span className="min-w-0 flex-1 truncate">{gatewaySummary}</span>
            </div>
            {restartRequired && !requiresProcessRestart && (
              <DropdownMenuItem
                onSelect={handleGatewayRestart}
                className="h-8 px-2 py-1.5 text-xs"
                disabled={
                  gwLoading ||
                  isRestarting ||
                  isStopping ||
                  !isRunning ||
                  !canStart ||
                  requiresProcessRestart
                }
              >
                <IconRefresh className="size-3.5" />
                <span className="truncate">
                  {t("header.gateway.action.restart")}
                </span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={handleGatewayToggle}
              className="h-8 px-2 py-1.5 text-xs"
              disabled={
                gwLoading ||
                isStarting ||
                isRestarting ||
                isStopping ||
                !canStart
              }
              variant={isRunning ? "destructive" : "default"}
            >
              {gatewayBusy ? (
                <IconLoader2 className="size-3.5 animate-spin" />
              ) : isRunning ? (
                <IconPower className="size-3.5" />
              ) : (
                <IconPlayerPlay className="size-3.5" />
              )}
              <span className="truncate">{gatewayActionLabel}</span>
            </DropdownMenuItem>
            {gatewayNotice ? (
              <div className="text-warning truncate px-2 py-1 text-[11px] leading-none">
                {gatewayNotice}
              </div>
            ) : null}

            <div className="bg-border/70 my-1 h-px" />

            <div
              className="grid grid-cols-3 gap-1 p-1"
              aria-label={`${t("header.appearance.label")}: ${t(
                "header.appearance.current",
                { theme },
              )}`}
            >
              {themeOptions.map(({ value, label, Icon }) => {
                const active = preference === value

                return (
                  <button
                    key={value}
                    type="button"
                    className={`relative flex h-7 items-center justify-center rounded-md transition-colors ${
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    }`}
                    aria-label={label}
                    aria-pressed={active}
                    title={label}
                    onClick={() => setTheme(value)}
                  >
                    <Icon className="size-3.5" />
                    {active && (
                      <IconCheck className="absolute top-0.5 right-0.5 size-2.5" />
                    )}
                  </button>
                )
              })}
            </div>

            <div className="bg-border/70 my-1 h-px" />

            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setShowLogoutDialog(true)}
              className="h-8 px-2 py-1.5 text-xs"
            >
              <IconLogout className="size-3.5" />
              <span className="truncate">{t("header.logout.confirm")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )
}
