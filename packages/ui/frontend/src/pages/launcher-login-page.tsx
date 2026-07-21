import {
  IconDeviceDesktop,
  IconLanguage,
  IconMoon,
  IconSun,
} from "@tabler/icons-react"
import * as React from "react"
import { useTranslation } from "react-i18next"

import {
  getLauncherAuthStatus,
  postLauncherDashboardLogin,
} from "@/api/launcher-auth"
import { LauncherAuthShell } from "@/features/auth/launcher-auth-shell"
import { useTheme } from "@/hooks/use-theme"
import { Button } from "@/shared/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu"
import { Input } from "@/shared/ui/input"
import { Label } from "@/shared/ui/label"

export function LauncherLoginPage() {
  const { t, i18n } = useTranslation()
  const { theme, preference, setTheme } = useTheme()
  const [password, setPassword] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState("")

  // If the password store has never been initialized, go to setup instead.
  React.useEffect(() => {
    void getLauncherAuthStatus()
      .then((s) => {
        if (!s.initialized) {
          globalThis.location.assign("/launcher-setup")
        }
      })
      .catch(() => {
        /* network error — stay on login page */
      })
  }, [])

  const loginWithPassword = React.useCallback(
    async (passwordValue: string) => {
      setError("")
      setSubmitting(true)
      try {
        const result = await postLauncherDashboardLogin(passwordValue)
        if (result.ok) {
          globalThis.location.assign("/")
          return
        }
        if (result.status === 409) {
          globalThis.location.assign("/launcher-setup")
          return
        }
        if (result.status === 401) {
          setError(t("launcherLogin.errorInvalid"))
          return
        }
        setError(result.error)
      } catch {
        setError(t("launcherLogin.errorNetwork"))
      } finally {
        setSubmitting(false)
      }
    },
    [t],
  )

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    await loginWithPassword(password)
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
          <CardTitle>{t("launcherLogin.title")}</CardTitle>
          <CardDescription>{t("launcherLogin.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="launcher-password">
                {t("launcherLogin.passwordLabel")}
              </Label>
              <Input
                id="launcher-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("launcherLogin.passwordPlaceholder")}
              />
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("labels.loading") : t("launcherLogin.submit")}
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
