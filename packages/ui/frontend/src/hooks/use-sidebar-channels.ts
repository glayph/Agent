import {
  IconBrandChrome,
  IconBrandDiscord,
  IconBrandLine,
  IconBrandMatrix,
  IconBrandSlack,
  IconBrandTelegram,
  IconBrandWechat,
  IconBrandWhatsapp,
  IconMessages,
  IconPlug,
  IconRobot,
} from "@tabler/icons-react"
import type { TFunction } from "i18next"
import { useAtomValue } from "jotai"
import * as React from "react"

import {
  type AppConfig,
  type SupportedChannel,
  getAppConfig,
  getChannelsCatalog,
} from "@/api/channels"
import { getChannelDisplayName } from "@/features/channels/components/channel-display-name"
import { gatewayAtom } from "@/store/gateway"

const CHANNEL_IMPORTANCE_TAIL = [
  "slack",
  "feishu",
  "dingtalk",
  "line",
  "qq",
  "wecom",
  "onebot",
  "matrix",
  "hiro",
  "irc",
  "whatsapp",
]

function getChannelImportanceOrder(language: string): string[] {
  const priority = language.startsWith("zh")
    ? ["weixin", "discord", "telegram"]
    : ["discord", "telegram", "weixin"]
  return [...priority, ...CHANNEL_IMPORTANCE_TAIL]
}

const CHANNEL_ICON_MAP: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  telegram: IconBrandTelegram,
  discord: IconBrandDiscord,
  slack: IconBrandSlack,
  feishu: IconMessages,
  dingtalk: IconMessages,
  line: IconBrandLine,
  qq: IconMessages,
  weixin: IconBrandWechat,
  wecom: IconBrandWechat,
  whatsapp: IconBrandWhatsapp,
  matrix: IconBrandMatrix,
  onebot: IconRobot,
  hiro: IconBrandChrome,
  irc: IconMessages,
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function isChannelEnabled(
  channel: SupportedChannel,
  channelsConfig: Record<string, unknown>,
): boolean {
  const channelConfig = asRecord(channelsConfig[channel.config_key])
  if (channelConfig.enabled !== true) {
    return false
  }

  if (channel.name === "whatsapp") {
    return channelConfig.use_native !== true
  }

  return true
}

function buildChannelEnabledMap(
  channels: SupportedChannel[],
  appConfig: AppConfig,
): Record<string, boolean> {
  const channelsConfig = asRecord(asRecord(appConfig).channels)
  const result: Record<string, boolean> = {}
  for (const channel of channels) {
    result[channel.name] = isChannelEnabled(channel, channelsConfig)
  }
  return result
}

export interface SidebarChannelNavItem {
  key: string
  title: string
  url: string
  icon: React.ComponentType<{ className?: string }>
}

interface UseSidebarChannelsOptions {
  enabled?: boolean
  language: string
  t: TFunction
}

export function useSidebarChannels({
  enabled = true,
  language,
  t,
}: UseSidebarChannelsOptions) {
  const gateway = useAtomValue(gatewayAtom)
  const [channels, setChannels] = React.useState<SupportedChannel[]>([])
  const [enabledMap, setEnabledMap] = React.useState<Record<string, boolean>>(
    {},
  )

  const reloadChannels = React.useCallback((shouldApply?: () => boolean) => {
    Promise.all([
      getChannelsCatalog(),
      getAppConfig().catch(() => ({}) as AppConfig),
    ])
      .then(([catalog, appConfig]) => {
        if (shouldApply && !shouldApply()) {
          return
        }
        setChannels(catalog.channels)
        setEnabledMap(buildChannelEnabledMap(catalog.channels, appConfig))
      })
      .catch(() => {
        if (shouldApply && !shouldApply()) {
          return
        }
        setChannels([])
        setEnabledMap({})
      })
  }, [])

  React.useEffect(() => {
    if (!enabled) return
    let active = true
    reloadChannels(() => active)
    return () => {
      active = false
    }
  }, [enabled, reloadChannels])

  const previousGatewayStatusRef = React.useRef(gateway.status)
  React.useEffect(() => {
    if (!enabled) {
      previousGatewayStatusRef.current = gateway.status
      return
    }
    const previousStatus = previousGatewayStatusRef.current
    if (previousStatus !== "running" && gateway.status === "running") {
      reloadChannels()
    }
    previousGatewayStatusRef.current = gateway.status
  }, [enabled, gateway.status, reloadChannels])

  const channelImportanceIndex = React.useMemo(() => {
    return new Map(
      getChannelImportanceOrder(language).map((name, index) => [name, index]),
    )
  }, [language])

  const sortedChannels = React.useMemo(() => {
    const list = [...channels]
    list.sort((a, b) => {
      const aEnabled = enabledMap[a.name] === true
      const bEnabled = enabledMap[b.name] === true
      if (aEnabled !== bEnabled) {
        return aEnabled ? -1 : 1
      }

      const aImportance =
        channelImportanceIndex.get(a.name) ?? Number.MAX_SAFE_INTEGER
      const bImportance =
        channelImportanceIndex.get(b.name) ?? Number.MAX_SAFE_INTEGER
      if (aImportance !== bImportance) {
        return aImportance - bImportance
      }

      return getChannelDisplayName(a, t).localeCompare(
        getChannelDisplayName(b, t),
      )
    })
    return list
  }, [channelImportanceIndex, channels, enabledMap, t])

  const visibleChannels = sortedChannels

  const channelItems = React.useMemo<SidebarChannelNavItem[]>(
    () =>
      visibleChannels.map((channel) => ({
        key: channel.name,
        title: getChannelDisplayName(channel, t),
        url: `/channels/${channel.name}`,
        icon: CHANNEL_ICON_MAP[channel.name] ?? IconPlug,
      })),
    [t, visibleChannels],
  )

  return {
    channelItems,
  }
}
