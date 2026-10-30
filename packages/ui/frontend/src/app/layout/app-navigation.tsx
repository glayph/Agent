import {
  IconActivity,
  IconBrain,
  IconBroadcast,
  IconChartDots3,
  IconFolder,
  IconMessageCircle,
  IconEye,
  IconPuzzle,
  IconSettings,
  IconSparkles,
  IconTool,
} from "@tabler/icons-react"
import type { ComponentType } from "react"

export interface AppNavigationItem {
  id: string
  titleKey: string
  url: string
  description: string
  icon: ComponentType<{ className?: string }>
}

export const primaryNavigation: AppNavigationItem[] = [
  {
    id: "chat",
    titleKey: "navigation.chat",
    url: "/",
    description: "Talk with the agent and manage the current workspace.",
    icon: IconMessageCircle,
  },
  {
    id: "drive",
    titleKey: "navigation.drive",
    url: "/drive",
    description: "Browse files, assets, and generated outputs.",
    icon: IconFolder,
  },
  {
    id: "models",
    titleKey: "navigation.models",
    url: "/models",
    description: "Configure providers, models, and defaults.",
    icon: IconChartDots3,
  },
  {
    id: "config",
    titleKey: "navigation.config",
    url: "/config",
    description: "Edit runtime, gateway, memory, and safety settings.",
    icon: IconSettings,
  },
  {
    id: "health",
    titleKey: "navigation.health",
    url: "/health",
    description: "Check runtime status and service health.",
    icon: IconActivity,
  },
]

export const utilityNavigation: AppNavigationItem[] = []

export const secondaryNavigation: AppNavigationItem[] = [
  ...primaryNavigation,
  {
    id: "plugins",
    titleKey: "navigation.plugins",
    url: "/plugins",
    description: "Browse built-in capabilities; manage installed skill plugins in Skills.",
    icon: IconPuzzle,
  },
  {
    id: "monitor",
    titleKey: "navigation.monitor",
    url: "/agent/monitor",
    description: "View the agent monitor and live computer state.",
    icon: IconEye,
  },
  {
    id: "channels",
    titleKey: "navigation.channels",
    url: "/channels",
    description: "Configure connected messaging channels.",
    icon: IconBroadcast,
  },
  {
    id: "memory",
    titleKey: "navigation.memory",
    url: "/memory",
    description: "Inspect selective memory and retrieval state.",
    icon: IconBrain,
  },
  {
    id: "activity",
    titleKey: "navigation.activity",
    url: "/agent/activity",
    description: "See running goals, live tool calls, the screen, and learned rules.",
    icon: IconActivity,
  },
  {
    id: "skills",
    titleKey: "navigation.skills",
    url: "/agent/skills",
    description: "Install, inspect, and manage agent skills.",
    icon: IconSparkles,
  },
  {
    id: "tools",
    titleKey: "navigation.tools",
    url: "/agent/tools",
    description: "Review tool capabilities and runtime settings.",
    icon: IconTool,
  },
  ...utilityNavigation,
]


export interface AppNavigationGroup {
  id: string
  titleKey: string
  itemIds: string[]
}

export const sidebarNavigationGroups: AppNavigationGroup[] = [
  {
    id: "workspace",
    titleKey: "navigation.workspace_group",
    itemIds: ["chat", "drive", "memory"],
  },
  {
    id: "agent",
    titleKey: "navigation.agent_group",
    itemIds: ["monitor", "activity", "skills", "tools"],
  },
  {
    id: "manage",
    titleKey: "navigation.manage_group",
    itemIds: ["models", "channels", "plugins", "config"],
  },
  {
    id: "system",
    titleKey: "navigation.system_group",
    itemIds: ["health"],
  },
]
