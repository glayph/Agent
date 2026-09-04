import {
  IconActivity,
  IconChecklist,
  IconClock,
  IconDashboard,
  IconPlugConnected,
  IconPlus,
} from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"

import { cn } from "@/lib/utils"

const items = [
  {
    to: "/agent/automations",
    label: "Overview",
    icon: IconDashboard,
    exact: true,
  },
  { to: "/agent/automations/list", label: "Automations", icon: IconChecklist },
  { to: "/agent/automations/create", label: "Create", icon: IconPlus },
  {
    to: "/agent/automations/history",
    label: "Execution history",
    icon: IconActivity,
  },
  {
    to: "/agent/automations/connections",
    label: "Connections",
    icon: IconPlugConnected,
  },
] as const

export function AutomationCenterNav() {
  return (
    <nav
      aria-label="Automation Center"
      className="bg-muted/30 flex flex-wrap gap-1 rounded-xl border p-1"
    >
      {items.map((item) => {
        const Icon = item.icon
        return (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: "exact" in item ? item.exact : false }}
            activeProps={{
              className: "bg-background text-foreground shadow-sm",
            }}
            className={cn(
              "text-muted-foreground hover:bg-background/70 hover:text-foreground inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            )}
          >
            <Icon className="size-4" />
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export function AutomationCenterSectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-[0.16em] uppercase">
        <IconClock className="size-3.5" />
        {eyebrow}
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground max-w-2xl text-sm">{description}</p>
    </div>
  )
}
