import type { ReactNode } from "react"

import { UnsavedChangesProvider } from "./unsaved-changes-provider"
import { useHighlightTheme } from "@/hooks/use-highlight-theme"

interface AppProvidersProps {
  children: ReactNode
}

export function AppProviders({ children }: AppProvidersProps) {
  useHighlightTheme()

  return <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
}
