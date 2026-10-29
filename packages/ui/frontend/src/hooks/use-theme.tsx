import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type ThemePreference = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system"
  try {
    const stored = window.localStorage.getItem("theme")
    if (stored === "light" || stored === "dark" || stored === "system") return stored
  } catch {
    // Storage is optional; fall back to the system setting.
  }
  return "system"
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

interface ThemeContextValue {
  theme: ResolvedTheme
  preference: ThemePreference
  setTheme: (next: ThemePreference) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(readStoredPreference)
  const [theme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(readStoredPreference()))

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const applyTheme = () => {
      const next = resolveTheme(preference)
      root.classList.toggle("dark", next === "dark")
      root.dataset.themePreference = preference
      root.dataset.theme = next
      root.style.colorScheme = next
      setResolvedTheme(next)
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
  const toggleTheme = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [setTheme, theme])
  const value = useMemo(() => ({ theme, preference, setTheme, toggleTheme }), [theme, preference, setTheme, toggleTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error("useTheme must be used inside ThemeProvider")
  return value
}
