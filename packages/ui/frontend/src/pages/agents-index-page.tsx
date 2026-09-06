import { IconRobot } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"

import { PageHeader } from "@/app/layout/page-header"

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
    <div className="bg-background flex h-full min-h-0 flex-col">
      <PageHeader title="Active Specialists" titleLevel={1} />
      <div className="animate-fade-in mx-auto w-full max-w-6xl flex-1 overflow-y-auto p-6">
        <p className="text-muted-foreground mb-6 text-sm">
          Swarm agents currently registered and routing parallel subtasks.
        </p>

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
                    <div className="text-[15px] font-semibold">
                      {agent.name || agent.specialist}
                    </div>
                    <div className="text-muted-foreground mt-0.5 font-mono text-xs">
                      {agent.id}
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-border/40 flex items-center justify-between border-t pt-3">
                <span className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
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
    </div>
  )
}
