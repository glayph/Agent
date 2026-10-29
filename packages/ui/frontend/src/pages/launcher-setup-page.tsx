import { IconEye, IconEyeOff, IconLanguage, IconMoon, IconSettings, IconSun } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import * as React from "react"
import { useTranslation } from "react-i18next"

import { getLauncherAuthStatus, postLauncherDashboardSetup } from "@/api/launcher-auth"
import { LauncherAuthShell } from "@/features/auth/launcher-auth-shell"
import { useTheme } from "@/hooks/use-theme"
import { Button } from "@/shared/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu"
import { Input } from "@/shared/ui/input"
import { Label } from "@/shared/ui/label"

export function LauncherSetupPage() {
  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useTheme()
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [showPasswords, setShowPasswords] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState("")
  const [showLoginLink, setShowLoginLink] = React.useState(false)

  React.useEffect(() => {
    let active = true
    void getLauncherAuthStatus().then((status) => {
      if (active) setShowLoginLink(status.initialized)
    }).catch(() => {
      // Setup remains available if auth status cannot be checked.
    })
    return () => { active = false }
  }, [])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
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

  const passwordType = showPasswords ? "text" : "password"
  const revealLabel = showPasswords
    ? t("launcherLogin.hidePassword")
    : t("launcherLogin.showPassword")

  return (
    <LauncherAuthShell
      page="setup"
      actions={
        <div className="launcher-auth-actions gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="launcher-auth-language"
              aria-label={t("header.appearance.label")}
              title={t("header.appearance.label")}
            >
              {theme === "dark" ? <IconMoon className="size-[18px]" /> : <IconSun className="size-[18px]" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setTheme("system")}>
              <IconSettings className="mr-2 size-4" />{t("header.appearance.system")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <IconSun className="mr-2 size-4" />{t("header.appearance.light")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <IconMoon className="mr-2 size-4" />{t("header.appearance.dark")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="launcher-auth-language"
              aria-label={t("header.language")}
              title={t("header.language")}
            >
              <IconLanguage className="size-[18px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => i18n.changeLanguage("bn")}>
              বাংলা
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => i18n.changeLanguage("en")}>
              English
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => i18n.changeLanguage("pt-BR")}>
              Português (Brasil)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => i18n.changeLanguage("zh")}>
              简体中文
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      }
    >
      <Card
        data-launcher-auth-card="true"
        className="launcher-auth-card"
        size="sm"
      >
        <CardHeader className="launcher-auth-card-header">
          <CardTitle className="launcher-auth-title">
            {t("launcherSetup.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="launcher-auth-card-content">
          <form className="launcher-auth-form" onSubmit={onSubmit}>
            <div className="launcher-auth-field">
              <Label className="launcher-auth-label" htmlFor="setup-password">
                {t("launcherSetup.passwordLabel")}
              </Label>
              <div className="launcher-auth-password-wrap">
                <Input
                  id="setup-password"
                  name="password"
                  type={passwordType}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t("launcherSetup.passwordPlaceholder")}
                  className="launcher-auth-input"
                />
                <button
                  type="button"
                  className="launcher-auth-reveal"
                  onClick={() => setShowPasswords((visible) => !visible)}
                  aria-label={revealLabel}
                  aria-pressed={showPasswords}
                >
                  {showPasswords ? <IconEyeOff /> : <IconEye />}
                </button>
              </div>
            </div>
            <div className="launcher-auth-field">
              <Label className="launcher-auth-label" htmlFor="setup-confirm">
                {t("launcherSetup.confirmLabel")}
              </Label>
              <Input
                id="setup-confirm"
                name="confirm"
                type={passwordType}
                autoComplete="new-password"
                required
                minLength={8}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder={t("launcherSetup.confirmPlaceholder")}
                className="launcher-auth-input"
              />
            </div>
            <Button
              type="submit"
              disabled={submitting}
              className="launcher-auth-submit"
            >
              {submitting ? t("labels.loading") : t("launcherSetup.submit")}
            </Button>
            {error ? (
              <p className="launcher-auth-error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
          {showLoginLink && (
            <Link
              to="/launcher-login"
              className="text-primary hover:underline mt-4 inline-flex text-sm underline-offset-4"
            >
              {t("launcherSetup.backToLogin", { defaultValue: "Back to login" })}
            </Link>
          )}
        </CardContent>
      </Card>
    </LauncherAuthShell>
  )
}
