import { IconArrowLeft, IconMessageCircle2 } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"

import { PageHeader } from "@/app/layout/page-header"

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
      <PageHeader
        title={id}
        titleLevel={1}
        titleExtra={
          <Link
            to="/agents"
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-8 items-center justify-center rounded-md transition-colors"
            aria-label="Back to agents"
            title="Back to agents"
          >
            <IconArrowLeft size={18} />
          </Link>
        }
      />

      <div className="mx-auto w-full max-w-4xl flex-1 overflow-auto p-6">
        <div className="border-border/60 bg-card rounded-2xl border p-6 shadow-sm">
          <div className="text-muted-foreground mb-4 text-xs font-semibold tracking-wider uppercase">
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
