import { IconArrowLeft, IconMessageCircle2 } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"

interface AgentMessage {
  id: string
  type?: string
  payload?: unknown
}

interface AgentDetailPageProps {
  id: string
}

export function AgentDetailPage({ id }: AgentDetailPageProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  useEffect(() => {
    fetch(`/api/agents/${id}/messages`)
      .then((r) => r.json())
      .then((data) => setMessages(data.messages || []))
      .catch(console.error)
  }, [id])

  return (
    <div className="bg-background text-foreground animate-fade-in flex h-full flex-col">
      <div className="border-border/40 bg-card flex items-center gap-4 border-b px-6 py-4">
        <Link
          to="/agents"
          className="hover:bg-secondary rounded-lg p-1.5 transition-colors"
        >
          <IconArrowLeft size={18} className="text-muted-foreground" />
        </Link>
        <div>
          <h2 className="text-lg font-bold tracking-tight">{id}</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Real-time inter-agent message telemetry
          </p>
        </div>
      </div>

      <div className="mx-auto flex-1 overflow-auto p-6 max-w-4xl w-full">
        <div className="border-border/60 bg-card rounded-2xl border p-6 shadow-sm">
          <div className="text-muted-foreground mb-4 text-xs font-semibold uppercase tracking-wider">
            Activity Log
          </div>
          <div className="divide-border/40 divide-y">
            {messages.map((msg) => (
              <div key={msg.id} className="message-trace-item py-4">
                <div className="flex w-full items-center gap-3">
                  <div
                    className="message-trace-type"
                    data-type={msg.type || "task_delegate"}
                  >
                    {msg.type || "delegate"}
                  </div>
                  <div className="text-muted-foreground flex-1 truncate font-mono text-xs">
                    {msg.id}
                  </div>
                </div>
                <div className="bg-secondary/60 text-foreground border-border/20 mt-3 w-full overflow-x-auto rounded-xl border p-4 font-mono text-[13px]">
                  {typeof msg.payload === "object"
                    ? JSON.stringify(msg.payload, null, 2)
                    : String(msg.payload)}
                </div>
              </div>
            ))}
            {messages.length === 0 && (
              <div className="text-muted-foreground flex h-40 flex-col items-center justify-center gap-3">
                <IconMessageCircle2 size={28} className="opacity-20" />
                <span className="text-sm font-medium">
                  No messages traced for this specialist yet.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
