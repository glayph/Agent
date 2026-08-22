import { IconActivity, IconUsers } from "@tabler/icons-react"
import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
} from "@tanstack/react-router"

export const Route = createFileRoute("/agents")({
  component: AgentsLayout,
})

function AgentsLayout() {
  const location = useLocation()

  return (
    <div className="bg-background text-foreground flex h-full w-full flex-col">
      <div className="border-border/60 bg-background flex h-14 items-center gap-6 border-b px-6">
        <Link
          to="/agents"
          className={`flex items-center gap-2 text-sm font-medium transition-colors ${
            location.pathname === "/agents" ||
            (location.pathname.startsWith("/agents/") &&
              !location.pathname.includes("swarm"))
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
      <div className="bg-background/50 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  )
}
