import { Navigate, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/agent/run")({
  component: AgentRunRedirect,
})

function AgentRunRedirect() {
  return (
    <Navigate
      to="/agent/runs"
      search={{ q: "", status: "all", run: "", step: "", page: 1 }}
      replace
    />
  )
}
