import {
  IconActivity,
  IconBrain,
  IconBroadcast,
  IconChartDots3,
  IconFolder,
  IconMessageCircle,
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
