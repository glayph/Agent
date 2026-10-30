import { IconEye, IconEyeOff, IconLanguage, IconMoon, IconSettings, IconSun } from "@tabler/icons-react"
import * as React from "react"
import { useTranslation } from "react-i18next"

import {
  getLauncherAuthStatus,
  postLauncherDashboardLogin,
} from "@/api/launcher-auth"
import { LauncherAuthShell } from "@/features/auth/launcher-auth-shell"
import { useTheme } from "@/hooks/use-theme-hook"
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

export function LauncherLoginPage() {
  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useTheme()
  const [password, setPassword] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState("")

  React.useEffect(() => {
    void getLauncherAuthStatus()
      .then((status) => {
        if (!status.initialized) {
          globalThis.location.assign("/launcher-setup")
        }
      })
      .catch(() => {
        // Keep the login screen available if the status check cannot connect.
      })
  }, [])

  const loginWithPassword = React.useCallback(
    async (passwordValue: string) => {
      setError("")
      setSubmitting(true)
      try {
        const result = await postLauncherDashboardLogin(passwordValue)
        if (result.ok) {
          globalThis.location.assign(
            result.defaultModelConfigured ? "/" : "/models?setup=required",
          )
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

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await loginWithPassword(password)
  }

  return (
    <LauncherAuthShell
      page="login"
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
            {t("launcherLogin.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="launcher-auth-card-content">
          <form className="launcher-auth-form" onSubmit={onSubmit}>
            <div className="launcher-auth-field">
              <Label className="launcher-auth-label" htmlFor="launcher-password">
                {t("launcherLogin.passwordLabel")}
              </Label>
              <div className="launcher-auth-password-wrap">
                <Input
                  id="launcher-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t("launcherLogin.passwordPlaceholder")}
                  className="launcher-auth-input"
                />
                <button
                  type="button"
                  className="launcher-auth-reveal"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={
                    showPassword
                      ? t("launcherLogin.hidePassword")
                      : t("launcherLogin.showPassword")
                  }
                  aria-pressed={showPassword}
                >
                  {showPassword ? <IconEyeOff /> : <IconEye />}
                </button>
              </div>
            </div>
            <Button
              type="submit"
              disabled={submitting}
              className="launcher-auth-submit"
            >
              {submitting ? t("labels.loading") : t("launcherLogin.submit")}
            </Button>
            {error ? (
              <p className="launcher-auth-error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </LauncherAuthShell>
  )
}
