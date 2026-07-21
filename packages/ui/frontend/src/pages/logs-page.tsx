import { IconCopy, IconPlayerPlay, IconTrash } from "@tabler/icons-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { PageHeader } from "@/app/layout/page-header"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"
import { ScrollArea } from "@/shared/ui/scroll-area"
import { useGateway } from "@/hooks/use-gateway"
import { useGatewayLogs } from "@/hooks/use-gateway-logs"

export function LogsPage() {
  const { t } = useTranslation()
  const { clearLogs, clearing, logs } = useGatewayLogs()
  const { state: gatewayStatus } = useGateway()
  const bottomRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [logs.length, autoScroll])

  const handleClear = async () => {
    try {
      await clearLogs()
      toast.success(t("pages.logs.cleared"))
    } catch {
      toast.error(t("pages.logs.clear_failed"))
    }
  }

  const handleCopy = async () => {
    if (logs.length === 0) return
    try {
      await navigator.clipboard.writeText(logs.join("\n"))
      toast.success(t("pages.logs.copied"))
    } catch {
      toast.error(t("pages.logs.copy_failed"))
    }
  }

  const isRunning =
    gatewayStatus === "running" ||
    gatewayStatus === "starting" ||
    gatewayStatus === "restarting" ||
    gatewayStatus === "stopping"

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("navigation.logs")}
        titleExtra={
          logs.length > 0
            ? (
                <span className="text-muted-foreground text-xs">
                  {t("pages.logs.line_count", { count: logs.length })}
                </span>
              )
            : undefined
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAutoScroll((prev) => !prev)}
          className={autoScroll ? "bg-primary/10" : undefined}
        >
          <IconPlayerPlay data-icon="inline-start" />
          {autoScroll ? t("pages.logs.auto_scroll_on") : t("pages.logs.auto_scroll_off")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleCopy()}
          disabled={logs.length === 0}
        >
          <IconCopy data-icon="inline-start" />
          {t("pages.logs.copy")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleClear()}
          disabled={clearing || logs.length === 0}
        >
          <IconTrash data-icon="inline-start" />
          {t("pages.logs.clear")}
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 p-4 sm:p-6">
        <Card className="flex h-full flex-col overflow-hidden">
          <CardHeader className="shrink-0">
            <CardTitle className="text-sm font-medium">
              {t("pages.logs.stream_title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-hidden p-0">
            {!isRunning && logs.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-muted-foreground text-sm">
                  {t("pages.logs.waiting_gateway")}
                </p>
              </div>
            ) : logs.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-muted-foreground text-sm">
                  {t("pages.logs.no_logs")}
                </p>
              </div>
            ) : (
              <ScrollArea className="h-full">
                <pre className="bg-muted/40 text-muted-foreground p-4 font-mono text-xs leading-5">
                  {logs.map((line, index) => (
                    <div key={index} className="min-h-5 whitespace-pre-wrap break-all">
                      {line}
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </pre>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
