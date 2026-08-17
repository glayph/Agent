import { IconDatabase, IconInfoCircle, IconTool } from "@tabler/icons-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/shared/ui/badge"
import { formatCompactNumber } from "@/lib/format"
import type { ContextUsage } from "@/store/chat"

import type { ContextSummaryItem } from "./types"

function PanelSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="border-border/60 bg-background/45 rounded-md border p-3">
      <h3 className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

interface ContextPanelProps {
  activeTools: string[]
  summaries: ContextSummaryItem[]
  memoryUsage?: ContextUsage
  metadata: ContextSummaryItem[]
}

export function ContextPanel({
  activeTools,
  summaries,
  memoryUsage,
  metadata,
}: ContextPanelProps) {
  const { t } = useTranslation()
  const memoryPercent = Math.min(memoryUsage?.used_percent ?? 0, 100)

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <PanelSection title={t("chat.contextPanel.activeTools")}>
        {activeTools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {activeTools.map((tool) => (
              <Badge
                key={tool}
                variant="outline"
                className="border-border bg-muted/25 text-[11px]"
              >
                <IconTool className="size-3" />
                {tool}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-[12px] leading-5">
            {t("chat.contextPanel.noTools")}
          </p>
        )}
      </PanelSection>

      <PanelSection title={t("chat.contextPanel.summaries")}>
        <div className="flex flex-col gap-2">
          {summaries.map((item) => (
            <div
              key={item.label}
              className="flex items-start justify-between gap-3 text-[12px]"
            >
              <span className="text-muted-foreground">{item.label}</span>
              <span className="min-w-0 text-right font-medium">
                {item.value}
              </span>
            </div>
          ))}
        </div>
      </PanelSection>

      <PanelSection title={t("chat.contextPanel.memory")}>
        {memoryUsage ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <IconDatabase className="size-3.5" />
                {t("chat.contextPanel.contextWindow")}
              </span>
              <span className="font-medium">
                {formatCompactNumber(memoryUsage.used_tokens)} /{" "}
                {formatCompactNumber(memoryUsage.compress_at_tokens)}
              </span>
            </div>
            <div
              className="bg-muted h-1.5 overflow-hidden rounded-full"
              role="progressbar"
              aria-label={t("chat.contextPanel.contextWindow")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(memoryPercent)}
            >
              <div
                className="bg-primary h-full rounded-full"
                style={{ width: `${memoryPercent}%` }}
              />
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-[12px] leading-5">
            {t("chat.contextPanel.noMemory")}
          </p>
        )}
      </PanelSection>

      <PanelSection title={t("chat.contextPanel.metadata")}>
        <div className="flex flex-col gap-2">
          {metadata.map((item) => (
            <div
              key={item.label}
              className="flex items-start justify-between gap-3 text-[12px]"
            >
              <span className="text-muted-foreground flex items-center gap-1.5">
                <IconInfoCircle className="size-3.5" />
                {item.label}
              </span>
              <span className="min-w-0 text-right font-medium">
                {item.value}
              </span>
            </div>
          ))}
        </div>
      </PanelSection>
    </div>
  )
}
