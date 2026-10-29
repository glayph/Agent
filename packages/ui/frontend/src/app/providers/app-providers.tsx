import type { ReactNode } from "react"

import { useHighlightTheme } from "@/hooks/use-highlight-theme"
import { ThemeProvider } from "@/hooks/use-theme"

import { UnsavedChangesProvider } from "./unsaved-changes-provider"

interface AppProvidersProps {
  children: ReactNode
}

export function AppProviders({ children }: AppProvidersProps) {
  useHighlightTheme()
  return (
    <ThemeProvider>
      <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
    </ThemeProvider>
  )
}
