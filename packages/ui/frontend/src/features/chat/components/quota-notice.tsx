import { useAtomValue } from "jotai"
import { chatAtom } from "@/store/chat"

export function QuotaNotice() {
  const quotaNotice = useAtomValue(chatAtom).quotaNotice
  if (!quotaNotice) return null

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="quota-notice"
      className="border-border/60 bg-muted/40 text-muted-foreground mx-auto w-full max-w-[var(--chat-message-max)] rounded-lg border px-3 py-2 text-center text-xs"
    >
      {quotaNotice}
    </div>
  )
}
