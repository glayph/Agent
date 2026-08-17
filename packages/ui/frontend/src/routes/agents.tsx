import { Outlet, createFileRoute, Link, useLocation } from "@tanstack/react-router"
import { IconUsers, IconActivity } from "@tabler/icons-react"

export const Route = createFileRoute("/agents")({
  component: AgentsLayout,
})

function AgentsLayout() {
  const location = useLocation()
  
  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <div className="flex h-14 items-center gap-6 border-b border-border/60 bg-background px-6">
        <Link
          to="/agents"
          className={`flex items-center gap-2 text-sm font-medium transition-colors ${
            location.pathname === "/agents" || (location.pathname.startsWith("/agents/") && !location.pathname.includes("swarm"))
              ? "text-foreground font-semibold"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <IconUsers size={16} />
          Agents Swarm
        </Link>
        <Link
          to="/agents/swarm"
          className={`flex items-center gap-2 text-sm font-medium transition-colors ${
            location.pathname === "/agents/swarm"
              ? "text-foreground font-semibold"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <IconActivity size={16} />
          Swarm Monitor
        </Link>
      </div>
      <div className="flex-1 overflow-auto bg-background/50">
        <Outlet />
      </div>
    </div>
  )
}

