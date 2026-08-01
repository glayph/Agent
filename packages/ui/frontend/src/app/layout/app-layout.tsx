import { useRouterState } from "@tanstack/react-router"
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react"
import { Toaster } from "sonner"

import { AppBackground } from "@/app/layout/app-background"
import { AppSidebar } from "@/app/layout/app-sidebar"
import { OfflineBanner } from "@/shared/feedback/offline-banner"
import { RouteErrorBoundary } from "@/shared/feedback/route-error-boundary"
import { SidebarProvider } from "@/shared/ui/sidebar"
import { TooltipProvider } from "@/shared/ui/tooltip"

const AppCommandPalette = lazy(() =>
  import("@/shared/navigation/app-command-palette").then((module) => ({
    default: module.AppCommandPalette,
  })),
)

function DeferredCommandPalette() {
  const [enabled, setEnabled] = useState(false)
  const [initialOpen, setInitialOpen] = useState(false)

  useEffect(() => {
    if (enabled) return

    const enableAndOpen = () => {
      setInitialOpen(true)
      setEnabled(true)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        enableAndOpen()
      }
    }

    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("Hiro:command", enableAndOpen)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("Hiro:command", enableAndOpen)
    }
  }, [enabled])

  if (!enabled) return null

  return (
    <Suspense fallback={null}>
      <AppCommandPalette initialOpen={initialOpen} />
    </Suspense>
  )
}

export function AppLayout({ children }: { children: ReactNode }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  return (
    <TooltipProvider>
      <OfflineBanner />
      <SidebarProvider
        defaultOpen={false}
        className="bg-background flex h-full min-h-0 overflow-hidden"
      >
        <a
          href="#app-main"
          className="bg-background text-foreground focus-visible:ring-ring fixed top-2 left-2 z-[100] -translate-y-16 rounded-md border px-3 py-2 text-sm shadow-none transition-transform focus-visible:translate-y-0 focus-visible:ring-2 focus-visible:outline-none"
        >
          Skip to main content
        </a>
        <AppSidebar />

        <div
          data-app-shell="content"
          className="bg-background relative flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          <AppBackground />
          <main
            id="app-main"
            key={pathname}
            data-motion-surface="route"
            className="relative z-10 flex min-h-0 w-full max-w-full flex-1 flex-col overflow-hidden bg-transparent"
          >
            <RouteErrorBoundary>{children}</RouteErrorBoundary>
          </main>
        </div>
        <DeferredCommandPalette />
        <Toaster position="bottom-center" />
      </SidebarProvider>
    </TooltipProvider>
  )
}
