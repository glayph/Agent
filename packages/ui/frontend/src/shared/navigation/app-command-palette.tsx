import {
  IconActivityHeartbeat,
  IconAtom,
  IconBolt,
  IconBrain,
  IconFolder,
  IconKey,
  IconListDetails,
  IconMessageCircle,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTimeline,
  IconTools,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import * as React from "react"
import { useTranslation } from "react-i18next"

import { useGateway } from "@/hooks/use-gateway"
import { useMikiChat } from "@/hooks/use-miki-chat"
import { useSidebarChannels } from "@/hooks/use-sidebar-channels"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/ui/command"

interface CommandAction {
  id: string
  label: string
  hint?: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  run: () => void
  disabled?: boolean
}

interface AppCommandPaletteProps {
  initialOpen?: boolean
}

const staticRoutes = [
  {
    id: "chat",
    labelKey: "navigation.chat",
    url: "/",
    description: "Talk with the agent and manage the current workspace.",
    icon: IconMessageCircle,
  },
  {
    id: "drive",
    labelKey: "navigation.drive",
    url: "/drive",
    description: "Browse files, assets, and generated outputs.",
    icon: IconFolder,
  },
  {
    id: "models",
    labelKey: "navigation.models",
    url: "/models",
    description: "Configure model providers, defaults, and API access.",
    icon: IconAtom,
  },
  {
    id: "memory",
    labelKey: "navigation.memory",
    url: "/memory",
    description: "Inspect selective memory, retrieval scores, and graph links.",
    icon: IconBrain,
  },
  {
    id: "credentials",
    labelKey: "navigation.credentials",
    url: "/credentials",
    description: "Connect OAuth and token-based service accounts.",
    icon: IconKey,
  },
  {
    id: "hub",
    labelKey: "navigation.hub",
    url: "/agent/hub",
    description: "Agent command center and high-level controls.",
    icon: IconSearch,
  },
  {
    id: "skills",
    labelKey: "navigation.skills",
    url: "/agent/skills",
    description: "Install, inspect, and manage agent skills.",
    icon: IconSparkles,
  },
  {
    id: "tools",
    labelKey: "navigation.tools",
    url: "/agent/tools",
    description: "Review tool capabilities and runtime settings.",
    icon: IconTools,
  },
  {
    id: "runs",
    labelKey: "navigation.runs",
    url: "/agent/runs",
    description: "Track autonomous runs, plans, and verification steps.",
    icon: IconTimeline,
  },
  {
    id: "config",
    labelKey: "navigation.config",
    url: "/config",
    description: "Edit app, gateway, memory, and safety configuration.",
    icon: IconSettings,
  },
  {
    id: "logs",
    labelKey: "navigation.logs",
    url: "/logs",
    description: "Read gateway, proxy, and app diagnostic logs.",
    icon: IconListDetails,
  },
  {
    id: "health",
    labelKey: "navigation.health",
    url: "/health",
    description: "Check runtime status and service health signals.",
    icon: IconActivityHeartbeat,
  },
]

function PaletteGroup({
  heading,
  children,
}: {
  heading: string
  children: React.ReactNode
}) {
  return (
    <CommandGroup heading={heading} className="px-1.5 py-1">
      <div className="space-y-0.5">{children}</div>
    </CommandGroup>
  )
}

function PaletteItemIcon({
  icon: Icon,
}: {
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <span className="text-muted-foreground group-data-[selected=true]:text-primary flex size-6 shrink-0 items-center justify-center rounded-md">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  )
}

function PaletteItemText({ title }: { title: React.ReactNode }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="text-foreground block truncate text-[13.5px] leading-5 font-medium">
        {title}
      </span>
    </span>
  )
}

export function AppCommandPalette({
  initialOpen = false,
}: AppCommandPaletteProps) {
  const [open, setOpen] = React.useState(initialOpen)
  const [search, setSearch] = React.useState("")
  const navigate = useNavigate()
  const { i18n, t } = useTranslation()
  useMikiChat()
  const {
    state: gatewayState,
    canStart,
    restartRequired,
    pendingRestartFields,
    loading,
    start,
    restart,
  } = useGateway()
  const processRestartRequired =
    restartRequired &&
    pendingRestartFields.some(
      (field) => field === "gateway.port" || field === "gateway.host",
    )
  const { channelItems } = useSidebarChannels({
    enabled: open,
    language: (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase(),
    t,
  })

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("Miki:command", onOpen)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("Miki:command", onOpen)
    }
  }, [])

  React.useEffect(() => {
    if (!open) {
      setSearch("")
    }
  }, [open])

  const goTo = React.useCallback(
    (url: string) => {
      setOpen(false)
      void navigate({ to: url })
    },
    [navigate],
  )

  const runAction = React.useCallback((action: () => void) => {
    setOpen(false)
    action()
  }, [])

  const actions: CommandAction[] = [
    {
      id: "gateway-start",
      label:
        gatewayState === "running"
          ? t("header.gateway.status.running")
          : t("header.gateway.action.start"),
      hint: t("command.groups.actions"),
      description: "Start the local gateway service when it is stopped.",
      icon: IconBolt,
      run: () => {
        void start()
      },
      disabled: loading || gatewayState === "running" || !canStart,
    },
    {
      id: "gateway-restart",
      label: processRestartRequired
        ? t("header.gateway.action.restartApp")
        : t("header.gateway.action.restart"),
      hint: processRestartRequired
        ? t("header.gateway.processRestartRequired", {
            fields: pendingRestartFields.join(", "),
          })
        : t("command.groups.actions"),
      description: processRestartRequired
        ? "App restart is required before this gateway change can apply."
        : "Restart the gateway after configuration changes.",
      icon: IconBolt,
      run: () => {
        void restart()
      },
      disabled:
        loading ||
        !restartRequired ||
        !canStart ||
        gatewayState !== "running" ||
        processRestartRequired,
    },
  ]
  const isSearching = search.trim().length > 0

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t("command.open")}
      description={t("command.placeholder")}
      className="border-border/70 bg-popover/95"
    >
      <CommandInput
        placeholder={t("command.placeholder")}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="max-h-[min(23rem,calc(100svh-7rem))] px-1 py-1.5">
        {isSearching && (
          <CommandEmpty>
            <div className="mx-auto max-w-72 px-4 py-1 text-center">
              <div className="text-foreground text-sm font-medium">
                {t("command.empty")}
              </div>
            </div>
          </CommandEmpty>
        )}

        <PaletteGroup heading={t("command.groups.navigation")}>
          {staticRoutes.map((item) => {
            const Icon = item.icon
            return (
              <CommandItem
                key={item.id}
                value={`${t(item.labelKey)} ${item.description} ${item.url}`}
                onSelect={() => goTo(item.url)}
                className="group data-[selected=true]:bg-primary/10 mx-0 min-h-8 gap-2 rounded-md border border-transparent px-2 text-sm"
              >
                <PaletteItemIcon icon={Icon} />
                <PaletteItemText title={t(item.labelKey)} />
              </CommandItem>
            )
          })}
        </PaletteGroup>

        <PaletteGroup heading={t("navigation.channels_group")}>
          {channelItems.map((item) => {
            const Icon = item.icon
            return (
              <CommandItem
                key={item.url}
                value={`${item.title} channel messaging ${item.url}`}
                onSelect={() => goTo(item.url)}
                className="group data-[selected=true]:bg-primary/10 mx-0 min-h-8 gap-2 rounded-md border border-transparent px-2 text-sm"
              >
                <PaletteItemIcon icon={Icon} />
                <PaletteItemText title={item.title} />
              </CommandItem>
            )
          })}
        </PaletteGroup>

        <PaletteGroup heading={t("command.groups.actions")}>
          {actions.map((action) => {
            const Icon = action.icon
            return (
              <CommandItem
                key={action.id}
                value={`${action.label} ${action.description} ${action.hint ?? ""}`}
                onSelect={() => runAction(action.run)}
                disabled={action.disabled}
                className="group data-[selected=true]:bg-primary/10 mx-0 min-h-8 gap-2 rounded-md border border-transparent px-2 text-sm"
              >
                <PaletteItemIcon icon={Icon} />
                <PaletteItemText title={action.label} />
              </CommandItem>
            )
          })}
        </PaletteGroup>
      </CommandList>
    </CommandDialog>
  )
}
