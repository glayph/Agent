import { useTranslation } from "react-i18next"

export function TypingIndicator() {
  const { t } = useTranslation()
  const label = t("chat.thinking.step1")

  return (
    <div
      className="flex items-center py-1"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <span className="sr-only">{label}</span>
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="bg-muted-foreground/55 size-1.5 animate-pulse rounded-full [animation-delay:-0.3s] motion-reduce:animate-none" />
        <span className="bg-muted-foreground/55 size-1.5 animate-pulse rounded-full [animation-delay:-0.15s] motion-reduce:animate-none" />
        <span className="bg-muted-foreground/55 size-1.5 animate-pulse rounded-full motion-reduce:animate-none" />
      </span>
    </div>
  )
}
