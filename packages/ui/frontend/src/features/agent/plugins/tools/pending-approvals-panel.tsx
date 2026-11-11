import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  approveApprovalRequest,
  denyApprovalRequest,
  listApprovalRequests,
  type ApprovalRequest,
} from "@/api/control"
import { notify } from "@/lib/notify"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card"

export function PendingApprovalsPanel() {
  const { t } = useTranslation()
  const [requests, setRequests] = useState<ApprovalRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await listApprovalRequests()
      setRequests(response.requests.filter((request) => request.status === "pending"))
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load pending approvals.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5_000)
    return () => clearInterval(timer)
  }, [refresh])

  const decide = async (request: ApprovalRequest, decision: "approve" | "deny") => {
    setBusyId(request.id)
    try {
      if (decision === "approve") {
        await approveApprovalRequest(request.id)
        notify.success(t("pages.agent.tools.approvalApproved", "Approval granted."))
      } else {
        await denyApprovalRequest(request.id)
        notify.success(t("pages.agent.tools.approvalDenied", "Request denied."))
      }
      await refresh()
    } catch (error) {
      notify.error(error instanceof Error ? error.message : "Could not update the approval request.")
    } finally {
      setBusyId(null)
    }
  }

  if (!loading && requests.length === 0 && !loadError) return null

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{t("pages.agent.tools.pendingApprovals", "Pending approvals")}</CardTitle>
          <Badge variant={requests.length > 0 ? "default" : "outline"}>{requests.length}</Badge>
        </div>
        <CardDescription>
          {t("pages.agent.tools.pendingApprovalsDescription", "Review tool actions that Miki must not run until you approve them. This list refreshes automatically.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && requests.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("common.loading", "Loading approvals…")}</p>
        ) : null}
        {loadError ? <p className="text-destructive text-sm" role="alert">{loadError}</p> : null}
        {requests.map((request) => (
          <div key={request.id} className="border-border flex flex-col gap-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{request.action}</span>
              <Badge variant="outline">{request.risk}</Badge>
              <Badge variant="secondary">{request.kind || "tool"}</Badge>
            </div>
            <p className="text-muted-foreground text-sm">{request.reason}</p>
            {request.preview ? (
              <pre className="bg-muted/60 max-h-36 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap break-all">{request.preview}</pre>
            ) : null}
            <p className="text-muted-foreground text-xs">
              {t("pages.agent.tools.approvalExpires", "Expires")}: {new Date(request.expiresAt).toLocaleString()}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" disabled={busyId === request.id} onClick={() => void decide(request, "deny")}>
                {t("common.deny", "Deny")}
              </Button>
              <Button size="sm" disabled={busyId === request.id} onClick={() => void decide(request, "approve")}>
                {busyId === request.id ? t("common.processing", "Processing…") : t("common.approve", "Approve")}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
