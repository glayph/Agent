import {
  IconDeviceDesktop,
  IconLanguage,
  IconMoon,
  IconSun,
} from "@tabler/icons-react"
import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { useTranslation } from "react-i18next"

import { postLauncherDashboardSetup } from "@/api/launcher-auth"
import { LauncherAuthShell } from "@/components/launcher-auth-shell"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useTheme } from "@/hooks/use-theme"

function LauncherSetupPage() {
  const { t, i18n } = useTranslation()
  const { theme, preference, setTheme } = useTheme()
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState("")

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError("")
    if (password !== confirm) {
      setError(t("launcherSetup.errorMismatch"))
      return
    }
    setSubmitting(true)
    try {
      const result = await postLauncherDashboardSetup(password, confirm)
      if (result.ok) {
        globalThis.location.assign("/launcher-login")
        return
      }
      setError(result.error)
    } catch {
      setError(t("launcherSetup.errorNetwork"))
    } finally {
      setSubmitting(false)
    }
  }
  const ThemeIcon =
    preference === "system"
      ? IconDeviceDesktop
      : theme === "dark"
        ? IconMoon
        : IconSun

  return (
    <LauncherAuthShell
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="border-white/30 bg-white/20 text-white hover:bg-white/30 hover:text-white focus-visible:ring-white/70 dark:border-white/20 dark:bg-black/20"
                aria-label={t("header.language")}
                title={t("header.language")}
              >
                <IconLanguage className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => i18n.changeLanguage("en")}>
                English
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => i18n.changeLanguage("zh")}>
                简体中文
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                type="button"
                className="border-white/30 bg-white/20 text-white hover:bg-white/30 hover:text-white focus-visible:ring-white/70 dark:border-white/20 dark:bg-black/20"
                aria-label={t("header.appearance.label")}
                title={t("header.appearance.label")}
              >
                <ThemeIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>
                {t("header.appearance.label")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setTheme("system")}>
                <IconDeviceDesktop className="size-4" />
                {t("header.appearance.system")}
                {preference === "system" && (
                  <span className="text-muted-foreground ml-auto text-xs">
                    {t("common.active")}
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("light")}>
                <IconSun className="size-4" />
                {t("header.appearance.light")}
                {preference === "light" && (
                  <span className="text-muted-foreground ml-auto text-xs">
                    {t("common.active")}
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("dark")}>
                <IconMoon className="size-4" />
                {t("header.appearance.dark")}
                {preference === "dark" && (
                  <span className="text-muted-foreground ml-auto text-xs">
                    {t("common.active")}
                  </span>
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <Card
        data-launcher-auth-card="true"
        className="border-white/25 bg-white/15 text-white shadow-2xl shadow-black/25 ring-1 ring-white/10 backdrop-blur-2xl dark:border-white/20 dark:bg-white/10"
        size="sm"
      >
        <CardHeader>
          <CardTitle>{t("launcherSetup.title")}</CardTitle>
          <CardDescription>{t("launcherSetup.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="setup-password">
                {t("launcherSetup.passwordLabel")}
              </Label>
              <Input
                id="setup-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("launcherSetup.passwordPlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="setup-confirm">
                {t("launcherSetup.confirmLabel")}
              </Label>
              <Input
                id="setup-confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={t("launcherSetup.confirmPlaceholder")}
              />
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("labels.loading") : t("launcherSetup.submit")}
            </Button>
            {error ? (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </LauncherAuthShell>
  )
}

export const Route = createFileRoute("/launcher-setup")({
  component: LauncherSetupPage,
})
