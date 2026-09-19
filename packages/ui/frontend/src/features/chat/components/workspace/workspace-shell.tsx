import { type ReactNode } from "react"

interface WorkspaceShellProps {
  header: ReactNode
  activityStream: ReactNode
  composer: ReactNode
}

/**
 * The Chat surface intentionally stays focused on the conversation.
 * Navigation remains available through the global app rail, while the old
 * workspace session/inspector side panels are not mounted here.
 */
export function WorkspaceShell({
  header,
  activityStream,
  composer,
}: WorkspaceShellProps) {
  return (
    <div
      data-workspace-shell="true"
      className="bg-background relative flex h-full min-h-0 min-w-0 overflow-hidden"
    >
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--chat-surface)]">
        {header}
        <div className="min-h-0 flex-1">{activityStream}</div>
        {composer}
      </section>
    </div>
  )
}
