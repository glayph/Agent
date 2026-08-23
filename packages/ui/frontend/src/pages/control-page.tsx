import { IconRefresh, IconShieldCheck } from "@tabler/icons-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  approveApprovalRequest,
  type ApprovalRequest,
  type ControlCapability,
  type ControlPlan,
  executeControlOperation,
  getApprovalRequests,
  getControlCapabilities,
  getControlOperations,
  getControlState,
  planControlOperation,
} from "@/api/control"
import { getModels } from "@/api/models"
import { PageHeader } from "@/app/layout/page-header"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"
import { SectionPanel } from "@/shared/ui/minimal-primitives"
import { Skeleton } from "@/shared/ui/skeleton"
import { Switch } from "@/shared/ui/switch"

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function riskVariant(risk: ControlCapability["risk"]) {
  if (risk === "read") return "outline" as const
  if (risk === "config_write") return "secondary" as const
  return "destructive" as const
}

export function ControlPage() {
  const [capabilities, setCapabilities] = useState<ControlCapability[]>([])
  const [state, setState] = useState<Record<string, unknown> | null>(null)
  const [operations, setOperations] = useState<Array<Record<string, unknown>>>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [models, setModels] = useState<Array<{ model_name: string; is_default?: boolean; available?: boolean; status?: string }>>([])
  const [pendingOperations, setPendingOperations] = useState<Record<string, { capability: string; action: string; input: Record<string, unknown>; plan: ControlPlan }>>({})
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [capabilityResponse, stateResponse, operationResponse, approvalResponse, modelResponse] =
        await Promise.all([
          getControlCapabilities(),
          getControlState(),
          getControlOperations(),
          getApprovalRequests(),
          getModels(),
        ])
      setCapabilities(capabilityResponse.capabilities)
      setState(stateResponse.state)
      setOperations(operationResponse.operations)
      setApprovals(approvalResponse.requests.filter((request) => request.status === "pending" && request.resource.startsWith("control:")))
      setModels(modelResponse.models.map((model) => ({ model_name: model.model_name, is_default: model.is_default, available: model.available, status: model.status })))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to load agent control state",
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const config = asRecord(state?.config)
  const agent = asRecord(config.agent)
  const tools = asRecord(config.tools)
  const toolState = asRecord(tools.tool_state)
  const resource = asRecord(agent.resource)
  const mode = typeof resource.mode === "string" ? resource.mode : "balanced"
  const activeModel = models.find((model) => model.is_default)?.model_name || ""
  const toolNames = useMemo(
    () => Object.keys(toolState).sort(),
    [toolState],
  )

  const approveRequest = useCallback(async (requestId: string) => {
    try {
      await approveApprovalRequest(requestId)
      const pending = pendingOperations[requestId]
      if (pending) {
        const response = await executeControlOperation({
          capability: pending.capability,
          action: pending.action,
          input: pending.input,
          approvalRequestId: requestId,
          plan: pending.plan,
        })
        if (!response.outcome.ok) {
          toast.error(response.outcome.error || "Approved operation failed")
        } else {
          toast.success("Approved control operation applied and verified.")
        }
        setPendingOperations((current) => {
          const next = { ...current }
          delete next[requestId]
          return next
        })
      } else {
        toast.success("Approval granted. The original operation can now be retried with its request ID.")
      }
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to approve request")
    }
  }, [load, pendingOperations])

  const runControl = useCallback(
    async (
      key: string,
      capability: string,
      action: string,
      input: Record<string, unknown>,
    ) => {
      setBusyAction(key)
      try {
        const prepared = await planControlOperation({ capability, action, input })
        const response = await executeControlOperation({ capability, action, input, plan: prepared.plan })
        const outcome = response.outcome
        if (outcome.status === "approval_required") {
          const approvalEvidence = outcome.evidence.find(
            (item) => item.id === "approval",
          )
          const approvalData = approvalEvidence?.data
          const requestId = approvalData && typeof approvalData === "object" && !Array.isArray(approvalData)
            ? (approvalData as Record<string, unknown>).request_id
            : undefined
          if (requestId && typeof requestId === "string") {
            setPendingOperations((current) => ({
              ...current,
              [requestId]: { capability, action, input, plan: prepared.plan },
            }))
          }
          toast.warning(
            requestId
              ? `Owner approval required. Request: ${String(requestId)}`
              : "Owner approval is required before this operation can run.",
          )
        } else if (!outcome.ok) {
          toast.error(outcome.error || "Control operation failed")
        } else {
          toast.success(
            outcome.pendingRestart
              ? "Change applied; a runtime restart is still pending."
              : "Agent control change applied and verified.",
          )
        }
        await load()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Control operation failed")
      } finally {
        setBusyAction(null)
      }
    },
    [load],
  )

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Agent Control"
        titleExtra={<Badge variant="secondary">Shared control plane</Badge>}
      >
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <IconRefresh data-icon="inline-start" />
          Refresh
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {loading && !state ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-48 rounded-lg" />
            <Skeleton className="h-48 rounded-lg" />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {approvals.length > 0 && (
              <SectionPanel
                title="Pending owner approvals"
                description="Protected operations never run automatically. Approve a request here, then retry the original operation with its request ID."
              >
                <div className="flex flex-col gap-2">
                  {approvals.map((approval) => (
                    <div key={approval.id} className="border-border/70 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <IconShieldCheck className="size-4" />
                          <span className="font-medium">{approval.resource}</span>
                          <Badge variant="destructive">{approval.risk}</Badge>
                        </div>
                        <p className="text-muted-foreground mt-1 truncate text-xs">{approval.reason}</p>
                      </div>
                      <Button size="sm" onClick={() => void approveRequest(approval.id)}>Approve</Button>
                    </div>
                  ))}
                </div>
              </SectionPanel>
            )}
            <SectionPanel
              title="Safe controls"
              description="These controls use the same validated dashboard controller as the existing Config and Tools pages."
            >
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Active model</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-muted-foreground text-sm">
                      Select a configured model. Provider readiness and runtime availability are checked by the existing Models page.
                    </p>
                    <select
                      value={activeModel}
                      disabled={busyAction === "active-model" || models.length === 0}
                      onChange={(event) => void runControl("active-model", "model_selection", "set", { model: event.target.value })}
                      className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                      aria-label="Active model"
                    >
                      <option value="" disabled>Select a model</option>
                      {models.map((model) => (
                        <option key={model.model_name} value={model.model_name} disabled={model.available === false}>
                          {model.model_name}{model.status && model.status !== "available" ? ` (${model.status})` : ""}
                        </option>
                      ))}
                    </select>
                  </CardContent>
                </Card>
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Resource profile</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-muted-foreground text-sm">
                      Choose the agent’s supported workload profile. The change is reversible and remains inside the configuration allowlist.
                    </p>
                    <select
                      value={mode}
                      disabled={busyAction === "resource-mode"}
                      onChange={(event) =>
                        void runControl("resource-mode", "config", "patch", {
                          patch: { agent: { resource: { mode: event.target.value } } },
                        })
                      }
                      className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                      aria-label="Resource profile"
                    >
                      <option value="eco">Eco</option>
                      <option value="balanced">Balanced</option>
                      <option value="performance">Performance</option>
                    </select>
                  </CardContent>
                </Card>
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Tool enablement</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {toolNames.length === 0 ? (
                      <p className="text-muted-foreground text-sm">No dashboard-registered tools are currently exposed.</p>
                    ) : (
                      <div className="divide-border/60 divide-y">
                        {toolNames.map((name) => (
                          <div key={name} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                            <span className="truncate font-mono text-sm">{name}</span>
                            <Switch
                              checked={toolState[name] === true}
                              disabled={busyAction === `tool:${name}`}
                              onCheckedChange={(enabled) =>
                                void runControl(`tool:${name}`, "tool_state", "set", { name, enabled })
                              }
                              aria-label={`Enable ${name}`}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </SectionPanel>

            <SectionPanel
              title="Autonomous capability inventory"
              description="Only typed, validated operations are listed. Secrets and unrestricted destructive controls are excluded."
            >
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {capabilities.map((capability) => (
                  <Card key={capability.id} size="sm">
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between gap-2">
                        <span className="truncate">{capability.label}</span>
                        <Badge variant={riskVariant(capability.risk)}>{capability.risk}</Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <p className="text-muted-foreground">{capability.description}</p>
                      <div className="flex flex-wrap gap-1">
                        {capability.actions.map((action) => (
                          <Badge key={action} variant="outline">{action}</Badge>
                        ))}
                      </div>
                      {capability.limitations.map((limitation) => (
                        <p key={limitation} className="text-muted-foreground text-xs">{limitation}</p>
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </SectionPanel>

            <div className="grid gap-5 xl:grid-cols-2">
              <SectionPanel
                title="Sanitized runtime state"
                description="The control service reads the same dashboard-backed configuration used by the runtime."
              >
                <pre className="bg-muted/50 max-h-96 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                  {JSON.stringify(state, null, 2)}
                </pre>
              </SectionPanel>
              <SectionPanel
                title="Recent control operations"
                description="Plans and results are journaled without raw credentials or approval tokens."
              >
                {operations.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No control operations recorded.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {operations.map((operation, index) => (
                      <div key={`${String(operation.operationId)}-${index}`} className="border-border/70 rounded-md border p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <IconShieldCheck className="size-4" />
                          <span className="font-medium">{String(operation.capability)}.{String(operation.action)}</span>
                          <Badge variant="outline">{String(operation.status)}</Badge>
                        </div>
                        <div className="text-muted-foreground mt-1 text-xs">{String(operation.at || "")}</div>
                      </div>
                    ))}
                  </div>
                )}
              </SectionPanel>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
