import { IconActivityHeartbeat } from "@tabler/icons-react"
import { useEffect, useState } from "react"

import { PageHeader } from "@/app/layout/page-header"

interface SwarmStatus {
  status?: string
  active_agents?: number
  pending_tasks?: number
}

export function AgentSwarmPage() {
  const [status, setStatus] = useState<SwarmStatus | null>(null)

  useEffect(() => {
    fetch("/api/swarm/status")
      .then((r) => r.json())
      .then((data) => setStatus(data))
      .catch(console.error)

    const interval = setInterval(() => {
      fetch("/api/swarm/status")
        .then((r) => r.json())
        .then((data) => setStatus(data))
        .catch(console.error)
    }, 5000)

    return () => clearInterval(interval)
  }, [])

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <PageHeader
        title="Swarm Telemetry"
        titleLevel={1}
        titleExtra={
          status?.status === "healthy" ? (
            <span className="text-success inline-flex items-center gap-2 text-xs font-semibold tracking-[0.14em] uppercase">
              <IconActivityHeartbeat size={14} />
              Online
            </span>
          ) : undefined
        }
      />
      <div className="animate-fade-in mx-auto w-full max-w-6xl flex-1 overflow-y-auto p-6">
        <p className="text-muted-foreground mb-8 text-sm">
          Real-time status and telemetry from the active specialist swarm.
        </p>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="swarm-metric">
            <span className="swarm-metric__label">Active Specialists</span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="swarm-metric__value">
                {status?.active_agents ?? 0}
              </span>
              <span className="text-muted-foreground text-xs font-medium">
                Nodes online
              </span>
            </div>
          </div>

          <div className="swarm-metric">
            <span className="swarm-metric__label">Pending Tasks</span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="swarm-metric__value">
                {status?.pending_tasks ?? 0}
              </span>
              <span className="text-muted-foreground text-xs font-medium">
                In queue
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
