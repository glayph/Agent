import { useCallback, useEffect, useState } from "react"

export type ThemePreference = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "light"

  try {
    const stored = window.localStorage.getItem("theme")
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored
    }
  } catch {
    // Theme persistence is optional.
  }

  return "system"
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference
}

export function useTheme() {
  const [preference, setPreference] =
    useState<ThemePreference>(readStoredPreference)
  const [theme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredPreference()),
  )

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia("(prefers-color-scheme: dark)")

    const applyTheme = () => {
      const nextTheme = resolveTheme(preference)
      root.classList.toggle("dark", nextTheme === "dark")
      root.dataset.themePreference = preference
      root.dataset.theme = nextTheme
      root.style.colorScheme = nextTheme
      setResolvedTheme(nextTheme)
    }

    applyTheme()
    if (preference !== "system") return

    media.addEventListener("change", applyTheme)
    return () => media.removeEventListener("change", applyTheme)
  }, [preference])

  const setTheme = useCallback((next: ThemePreference) => {
    setPreference(next)
    try {
      window.localStorage.setItem("theme", next)
    } catch {
      // Theme persistence is optional.
    }
  }, [])

  const toggleTheme = useCallback(() => {
    const next: ThemePreference = theme === "dark" ? "light" : "dark"
    setTheme(next)
  }, [setTheme, theme])

  return {
    theme,
    preference,
    setTheme,
    toggleTheme,
  }
}
