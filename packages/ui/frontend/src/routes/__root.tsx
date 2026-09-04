import { IconX } from "@tabler/icons-react"
import { Outlet, createRootRoute, useRouterState } from "@tanstack/react-router"
import { useEffect, useState } from "react"

import { getLauncherAuthStatus } from "@/api/launcher-auth"
import { AppLayout } from "@/app/layout/app-layout"
import { initializeChatStore } from "@/features/chat/controller"
import { isLauncherAuthPathname } from "@/lib/launcher-login-path"

type AuthGateState = "checking" | "authenticated" | "redirecting" | "degraded"

function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

function AuthGateFallback() {
  return (
    <div
      className="bg-background text-muted-foreground flex h-dvh items-center justify-center text-sm"
      role="status"
      aria-live="polite"
    >
      Loading…
    </div>
  )
}

const RootLayout = () => {
  // Prefer the actual address bar path. Stale embedded bundles may not
  // register /launcher-login or /launcher-setup in the route tree.
  const routerState = useRouterState({
    select: (s) => ({
      pathname: s.location?.pathname ?? "/",
      matches: s.matches ?? [],
    }),
  })

  const windowPath =
    typeof globalThis.location !== "undefined"
      ? globalThis.location.pathname || "/"
      : routerState.pathname

  const isAuthPage =
    isLauncherAuthPathname(windowPath) ||
    isLauncherAuthPathname(routerState.pathname) ||
    routerState.matches.some(
      (m) => m.routeId === "/launcher-login" || m.routeId === "/launcher-setup",
    )

  const [authError, setAuthError] = useState<string | null>(null)
  const [authGateState, setAuthGateState] = useState<AuthGateState>("checking")
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null)
  const [sessionRemainingMs, setSessionRemainingMs] = useState<number | null>(
    null,
  )

  useEffect(() => {
    if (isAuthPage) return
    let cancelled = false

    setAuthError(null)
    setAuthGateState("checking")

    const checkAuth = () => {
      void getLauncherAuthStatus()
        .then((s) => {
          if (cancelled) return
          setSessionExpiresAt(s.session_expires_at ?? null)
          if (!s.initialized && !s.authenticated) {
            setAuthGateState("redirecting")
            globalThis.location.assign("/launcher-setup")
          } else if (!s.authenticated) {
            setAuthGateState("redirecting")
            globalThis.location.assign("/launcher-login")
          } else {
            setAuthGateState("authenticated")
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return
          if (err instanceof Error && /^status 40[13]$/.test(err.message)) {
            setAuthGateState("redirecting")
            globalThis.location.assign("/launcher-login")
          } else {
            setAuthError(
              err instanceof Error
                ? err.message
                : "Auth service unavailable. Reset dashboard password storage and restart the application.",
            )
            setAuthGateState("degraded")
          }
        })
    }

    checkAuth()
    const pollTimer = globalThis.setInterval(checkAuth, 15_000)

    return () => {
      cancelled = true
      globalThis.clearInterval(pollTimer)
    }
  }, [isAuthPage])

  useEffect(() => {
    if (sessionExpiresAt === null) {
      setSessionRemainingMs(null)
      return
    }
    const update = () => {
      const remaining = sessionExpiresAt - Date.now()
      setSessionRemainingMs(remaining)
      if (remaining <= 0) {
        globalThis.location.assign("/launcher-login")
      }
    }
    update()
    const timer = globalThis.setInterval(update, 1000)
    return () => globalThis.clearInterval(timer)
  }, [sessionExpiresAt])

  useEffect(() => {
    if (
      isAuthPage ||
      (authGateState !== "authenticated" && authGateState !== "degraded")
    ) {
      return
    }
    initializeChatStore()
  }, [authGateState, isAuthPage])

  if (isAuthPage) {
    return <Outlet />
  }

  if (authGateState === "checking" || authGateState === "redirecting") {
    return <AuthGateFallback />
  }

  const showSessionCountdown =
    authGateState === "authenticated" &&
    sessionRemainingMs !== null &&
    sessionRemainingMs > 0

  return (
    <div className="h-dvh overflow-hidden">
      {showSessionCountdown && (
        <div className="border-primary/30 bg-card/95 text-foreground fixed inset-x-0 top-0 z-[100] border-b px-4 py-2 text-center text-sm backdrop-blur">
          Session expires in {formatCountdown(sessionRemainingMs)}
        </div>
      )}
      {authError && (
        <div
          className={`border-destructive/40 bg-card/95 text-foreground fixed inset-x-0 z-[100] flex items-center justify-between border-b px-4 py-2 text-sm backdrop-blur ${showSessionCountdown ? "top-10" : "top-0"}`}
        >
          <span>Auth service error: {authError}</span>
          <button
            className="text-muted-foreground hover:bg-accent ml-4 inline-flex size-8 items-center justify-center rounded-md hover:opacity-100"
            onClick={() => setAuthError(null)}
            aria-label="Dismiss"
          >
            <IconX className="size-4" />
          </button>
        </div>
      )}
      <div
        className={
          authError
            ? "mt-10 h-[calc(100dvh-2.5rem)] min-h-0"
            : showSessionCountdown
              ? "mt-10 h-[calc(100dvh-2.5rem)] min-h-0"
              : "h-full min-h-0"
        }
      >
        <AppLayout>
          <Outlet />
        </AppLayout>
      </div>
    </div>
  )
}

export const Route = createRootRoute({ component: RootLayout })
