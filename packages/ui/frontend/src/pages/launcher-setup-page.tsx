import { IconLanguage } from "@tabler/icons-react"
import * as React from "react"
import { useTranslation } from "react-i18next"

import { postLauncherDashboardSetup } from "@/api/launcher-auth"
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

export function LauncherSetupPage() {
  const { t, i18n } = useTranslation()
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
