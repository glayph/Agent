import { IconRobot } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"

interface AgentSummary {
  id: string
  name?: string
  specialist?: string
  status?: string
}

export function AgentsIndexPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => setAgents(data.agents || []))
      .catch(console.error)
  }, [])

  return (
    <div className="animate-fade-in mx-auto max-w-6xl p-6">
      <div className="mb-6">
        <h2 className="text-xl font-bold tracking-tight">Active Specialists</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Swarm agents currently registered and routing parallel subtasks.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <Link
            key={agent.id}
            to="/agents/$id"
            params={{ id: agent.id }}
            className="agent-card group relative flex h-36 flex-col justify-between"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="bg-secondary text-foreground flex size-10 items-center justify-center rounded-xl">
                  <IconRobot size={20} />
                </div>
                <div>
                  <div className="font-semibold text-[15px]">
                    {agent.name || agent.specialist}
                  </div>
                  <div className="text-muted-foreground mt-0.5 font-mono text-xs">
                    {agent.id}
                  </div>
                </div>
              </div>
            </div>

            <div className="border-border/40 flex items-center justify-between border-t pt-3">
              <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                {agent.specialist || "Specialist"}
              </span>
              <div className="flex items-center gap-2">
                <div
                  className="agent-status-dot"
                  data-status={agent.status || "idle"}
                />
                <span className="text-foreground text-xs font-medium capitalize">
                  {agent.status || "idle"}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {agents.length === 0 && (
        <div className="border-border/80 bg-card/30 text-muted-foreground flex h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed">
          <IconRobot size={32} className="opacity-30" />
          <span className="text-sm">No agents found in the registry.</span>
        </div>
      )}
    </div>
  )
}
