/**
 * Programmatic Design Tokens
 * TypeScript token mapping referencing CSS custom properties and Material Design 3 system.
 */

export const theme = {
  colors: {
    background: "var(--background)",
    foreground: "var(--foreground)",
    card: "var(--card)",
    cardForeground: "var(--card-foreground)",
    popover: "var(--popover)",
    popoverForeground: "var(--popover-foreground)",
    primary: "var(--primary)",
    primaryForeground: "var(--primary-foreground)",
    secondary: "var(--secondary)",
    secondaryForeground: "var(--secondary-foreground)",
    muted: "var(--muted)",
    mutedForeground: "var(--muted-foreground)",
    accent: "var(--accent)",
    accentForeground: "var(--accent-foreground)",
    destructive: "var(--destructive)",
    destructiveForeground: "var(--destructive-foreground)",
    border: "var(--border)",
    input: "var(--input)",
    ring: "var(--ring)",
    success: "var(--color-success, #22c55e)",
    warning: "var(--color-warning, #f59e0b)",
    sidebar: {
      background: "var(--sidebar)",
      foreground: "var(--sidebar-foreground)",
      primary: "var(--sidebar-primary)",
      primaryForeground: "var(--sidebar-primary-foreground)",
      accent: "var(--sidebar-accent)",
      accentForeground: "var(--sidebar-accent-foreground)",
      border: "var(--sidebar-border)",
      ring: "var(--sidebar-ring)",
    },
  },
  radii: {
    sm: "var(--radius-sm, 4px)",
    md: "var(--radius-md, 6px)",
    lg: "var(--radius-lg, 8px)",
    xl: "var(--radius-xl, 12px)",
    "2xl": "var(--radius-2xl, 16px)",
    full: "9999px",
  },
  typography: {
    fontSans: "var(--font-sans, 'Inter Variable', sans-serif)",
    fontMono: "var(--font-mono, monospace)",
  },
  motion: {
    duration: {
      fast: "150ms",
      normal: "250ms",
      slow: "350ms",
    },
    easing: {
      default: "cubic-bezier(0.4, 0, 0.2, 1)",
      easeOut: "cubic-bezier(0, 0, 0.2, 1)",
      easeIn: "cubic-bezier(0.4, 0, 1, 1)",
      spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    },
    enter: "animate-in fade-in zoom-in-95 duration-200",
    exit: "animate-out fade-out zoom-out-95 duration-150",
    press: "active:scale-[0.98] transition-transform duration-100",
  },
} as const

export type ThemeTokens = typeof theme
