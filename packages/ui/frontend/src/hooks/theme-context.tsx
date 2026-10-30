import { createContext } from "react"

export type ThemePreference = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

export interface ThemeContextValue {
  theme: ResolvedTheme
  preference: ThemePreference
  setTheme: (next: ThemePreference) => void
  toggleTheme: () => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)
