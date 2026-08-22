import type { ReactNode } from "react"

import { useHighlightTheme } from "@/hooks/use-highlight-theme"
import { useTheme } from "@/hooks/use-theme"

import { UnsavedChangesProvider } from "./unsaved-changes-provider"

interface AppProvidersProps {
  children: ReactNode
}

export function AppProviders({ children }: AppProvidersProps) {
  useHighlightTheme()
  useTheme()

  return <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
}
