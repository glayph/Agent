import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

export function TypingIndicator() {
  const { t } = useTranslation()
  const thinkingSteps = [
    t("chat.thinking.step1"),
    t("chat.thinking.step2"),
    t("chat.thinking.step3"),
    t("chat.thinking.step4"),
  ]
  const [stepIndex, setStepIndex] = useState(0)

  useEffect(() => {
    const stepsCount = thinkingSteps.length
    const interval = setInterval(() => {
      setStepIndex((prev) => (prev + 1) % stepsCount)
    }, 3000)
    return () => clearInterval(interval)
  }, [thinkingSteps.length])

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="bg-card/86 inline-flex w-fit max-w-[min(100%,20rem)] flex-col gap-3 rounded-xl px-5 py-4">
        <div className="flex items-center gap-1.5">
          <span className="bg-primary/70 size-2 animate-bounce rounded-full [animation-delay:-0.3s] motion-reduce:animate-none" />
          <span className="bg-primary/70 size-2 animate-bounce rounded-full [animation-delay:-0.15s] motion-reduce:animate-none" />
          <span className="bg-primary/70 size-2 animate-bounce rounded-full motion-reduce:animate-none" />
        </div>

        <div className="bg-muted relative h-1 w-36 overflow-hidden rounded-full">
          <div className="from-primary/50 via-primary to-primary/50 absolute inset-0 animate-[shimmer_2s_infinite] rounded-full bg-gradient-to-r bg-[length:200%_100%] motion-reduce:animate-none" />
        </div>

        <p
          key={stepIndex}
          className="text-muted-foreground animate-[fadeSlideIn_0.4s_ease-out] text-xs motion-reduce:animate-none"
        >
          {thinkingSteps[stepIndex]}
        </p>
      </div>
    </div>
  )
}
