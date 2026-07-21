import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { IconRobot } from "@tabler/icons-react"

export const Route = createFileRoute("/agents/")({
  component: AgentsIndex,
})

interface AgentSummary {
  id: string
  name?: string
  specialist?: string
  status?: string
}

function AgentsIndex() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  useEffect(() => {
    fetch("/api/agents")
      .then(r => r.json())
      .then(data => setAgents(data.agents || []))
      .catch(console.error)
  }, [])
  
  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <div className="mb-6">
        <h2 className="text-xl font-bold tracking-tight">Active Specialists</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Swarm agents currently registered and routing parallel subtasks.
        </p>
      </div>
      
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <Link
            key={agent.id}
            to="/agents/$id"
            params={{ id: agent.id }}
            className="agent-card group flex flex-col justify-between h-36 relative"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-secondary text-foreground">
                  <IconRobot size={20} />
                </div>
                <div>
                  <div className="font-semibold text-[15px]">{agent.name || agent.specialist}</div>
                  <div className="text-xs text-muted-foreground font-mono mt-0.5">{agent.id}</div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-border/40 pt-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {agent.specialist || "Specialist"}
              </span>
              <div className="flex items-center gap-2">
                <div className="agent-status-dot" data-status={agent.status || "idle"} />
                <span className="text-xs font-medium capitalize text-foreground">
                  {agent.status || "idle"}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
      
      {agents.length === 0 && (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/80 bg-card/30 text-muted-foreground">
          <IconRobot size={32} className="opacity-30" />
          <span className="text-sm">No agents found in the registry.</span>
        </div>
      )}
    </div>
  )
}
