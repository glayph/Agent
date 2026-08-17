import { useCallback, useEffect, useState } from "react"

export type ThemePreference = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

function getStoredTheme(): ThemePreference {
  if (typeof window === "undefined") return "system"
  const stored = localStorage.getItem("theme")
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "system"
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(getStoredTheme)
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)
  const theme: ResolvedTheme =
    preference === "system" ? systemTheme : preference

  useEffect(() => {
    const root = document.documentElement
    if (theme === "dark") {
      root.classList.add("dark")
    } else {
      root.classList.remove("dark")
    }
    root.dataset.themePreference = preference
    localStorage.setItem("theme", preference)
  }, [preference, theme])

  useEffect(() => {
    if (typeof window === "undefined") return
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const sync = () => setSystemTheme(media.matches ? "dark" : "light")
    sync()
    media.addEventListener("change", sync)
    return () => media.removeEventListener("change", sync)
  }, [])

  const toggleTheme = useCallback(() => {
    setPreference(theme === "dark" ? "light" : "dark")
  }, [theme])

  return { theme, preference, setTheme: setPreference, toggleTheme }
}
