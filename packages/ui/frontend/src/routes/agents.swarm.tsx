import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { IconActivityHeartbeat } from "@tabler/icons-react"

export const Route = createFileRoute("/agents/swarm")({
  component: SwarmMonitor,
})

interface SwarmStatus {
  status?: string
  active_agents?: number
  pending_tasks?: number
}

function SwarmMonitor() {
  const [status, setStatus] = useState<SwarmStatus | null>(null)
  
  useEffect(() => {
    fetch("/api/swarm/status")
      .then(r => r.json())
      .then(data => setStatus(data))
      .catch(console.error)
      
    const interval = setInterval(() => {
      fetch("/api/swarm/status")
        .then(r => r.json())
        .then(data => setStatus(data))
        .catch(console.error)
    }, 5000)
    
    return () => clearInterval(interval)
  }, [])
  
  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Swarm Telemetry</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Real-time status and telemetry from the active specialist swarm.
          </p>
        </div>
        {status?.status === "healthy" && (
          <div className="flex items-center gap-2 rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-green-500">
            <IconActivityHeartbeat size={14} />
            Swarm Online
          </div>
        )}
      </div>
      
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <div className="swarm-metric">
          <span className="swarm-metric__label">Active Specialists</span>
          <div className="flex items-baseline gap-2 mt-2">
            <span className="swarm-metric__value">{status?.active_agents ?? 0}</span>
            <span className="text-xs text-muted-foreground font-medium">Nodes online</span>
          </div>
        </div>
        
        <div className="swarm-metric">
          <span className="swarm-metric__label">Pending Tasks</span>
          <div className="flex items-baseline gap-2 mt-2">
            <span className="swarm-metric__value">{status?.pending_tasks ?? 0}</span>
            <span className="text-xs text-muted-foreground font-medium">In queue</span>
          </div>
        </div>
      </div>
    </div>
  )
}
