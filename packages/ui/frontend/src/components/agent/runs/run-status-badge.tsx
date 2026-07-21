import type { AgentRunStatus } from "@/api/agent-runs"
import { Badge } from "@/components/ui/badge"

export function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  if (status === "completed") {
    return <Badge variant="default">{status}</Badge>
  }
  if (status === "failed") {
    return <Badge variant="destructive">{status}</Badge>
  }
  if (status === "running") {
    return <Badge variant="secondary">{status}</Badge>
  }
  return <Badge variant="outline">{status}</Badge>
}
