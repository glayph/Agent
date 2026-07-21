import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { IconMessageCircle2, IconArrowLeft } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"

export const Route = createFileRoute("/agents/$id")({
  component: AgentDetail,
})

interface AgentMessage {
  id: string
  type?: string
  payload?: unknown
}

function AgentDetail() {
  const { id } = Route.useParams()
  const [messages, setMessages] = useState<AgentMessage[]>([])
  useEffect(() => {
    fetch(`/api/agents/${id}/messages`)
      .then(r => r.json())
      .then(data => setMessages(data.messages || []))
      .catch(console.error)
  }, [id])
  
  return (
    <div className="flex h-full flex-col bg-background text-foreground animate-fade-in">
      <div className="flex items-center gap-4 border-b border-border/40 bg-card px-6 py-4">
        <Link to="/agents" className="rounded-lg p-1.5 hover:bg-secondary transition-colors">
          <IconArrowLeft size={18} className="text-muted-foreground" />
        </Link>
        <div>
          <h2 className="text-lg font-bold tracking-tight">{id}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Real-time inter-agent message telemetry</p>
        </div>
      </div>
      
      <div className="flex-1 overflow-auto p-6 max-w-4xl w-full mx-auto">
        <div className="rounded-2xl border border-border/60 bg-card p-6 shadow-sm">
          <div className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Activity Log
          </div>
          <div className="divide-y divide-border/40">
            {messages.map((msg) => (
              <div key={msg.id} className="message-trace-item py-4">
                <div className="flex items-center gap-3 w-full">
                  <div className="message-trace-type" data-type={msg.type || "task_delegate"}>
                    {msg.type || "delegate"}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono truncate flex-1">
                    {msg.id}
                  </div>
                </div>
                <div className="mt-3 w-full rounded-xl bg-secondary/60 p-4 font-mono text-[13px] text-foreground border border-border/20 overflow-x-auto">
                  {typeof msg.payload === "object" 
                    ? JSON.stringify(msg.payload, null, 2) 
                    : String(msg.payload)
                  }
                </div>
              </div>
            ))}
            {messages.length === 0 && (
              <div className="flex h-40 flex-col items-center justify-center gap-3 text-muted-foreground">
                <IconMessageCircle2 size={28} className="opacity-20" />
                <span className="text-sm font-medium">No messages traced for this specialist yet.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
