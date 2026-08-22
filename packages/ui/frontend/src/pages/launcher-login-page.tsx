import { IconLanguage } from "@tabler/icons-react"
import * as React from "react"
import { useTranslation } from "react-i18next"

import {
  getLauncherAuthStatus,
  postLauncherDashboardLogin,
} from "@/api/launcher-auth"
import { LauncherAuthShell } from "@/features/auth/launcher-auth-shell"
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
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu"
import { Input } from "@/shared/ui/input"
import { Label } from "@/shared/ui/label"

export function LauncherLoginPage() {
  const { t, i18n } = useTranslation()
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
  return (
    <LauncherAuthShell
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="focus-visible:ring-primary/70 border-white/15 bg-black/40 text-white hover:border-white/30 hover:bg-black/60 hover:text-white"
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
        </>
      }
    >
      <Card
        data-launcher-auth-card="true"
        className="shadow-2xl ring-1 shadow-black/40 ring-white/5"
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
