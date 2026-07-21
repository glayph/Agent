import { IconX } from "@tabler/icons-react"
import { Outlet, createRootRoute, useRouterState } from "@tanstack/react-router"
import { useEffect, useState } from "react"

import { getLauncherAuthStatus } from "@/api/launcher-auth"
import { AppLayout } from "@/components/app-layout"
import { initializeChatStore } from "@/features/chat/controller"
import { isLauncherAuthPathname } from "@/lib/launcher-login-path"

type AuthGateState = "checking" | "authenticated" | "redirecting" | "degraded"

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

  useEffect(() => {
    if (isAuthPage) return
    let cancelled = false

    setAuthError(null)
    setAuthGateState("checking")

    void getLauncherAuthStatus()
      .then((s) => {
        if (cancelled) return
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

    return () => {
      cancelled = true
    }
  }, [isAuthPage])

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

  return (
    <div className="h-dvh overflow-hidden">
      {authError && (
        <div className="border-destructive/40 bg-card/95 text-foreground fixed inset-x-0 top-0 z-[100] flex items-center justify-between border-b px-4 py-2 text-sm backdrop-blur">
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
          authError ? "mt-10 h-[calc(100dvh-2.5rem)] min-h-0" : "h-full min-h-0"
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
