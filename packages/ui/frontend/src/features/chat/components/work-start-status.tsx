import { IconLoader2 } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"
import { useAtomValue } from "jotai"

import { chatAtom } from "@/store/chat"

export function WorkStartStatus() {
  const { t } = useTranslation()
  const workStatus = useAtomValue(chatAtom).workStatus

  if (!workStatus) return null

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="work-start-status"
      className="flex w-full max-w-[var(--chat-message-max)] items-center gap-2 py-1 text-[12px] text-muted-foreground/85"
    >
      <IconLoader2 className="size-3.5 shrink-0 motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span>
        {t("chat.workStarted", {
          defaultValue: "I’ve received your request and I’m working on it…",
        })}
      </span>
    </div>
  )
}
