import type { SupportedChannel } from "@/api/channels"

export type ChannelCatalogGroupKey =
  | "live"
  | "needsSetup"
  | "partial"
  | "notConfigured"

/** Green means a real adapter that is configured and currently connected. */
export function isLiveChannel(channel: SupportedChannel): boolean {
  return (
    channel.runtime_status === "functional" &&
    channel.configured === true &&
    channel.runtime_connected === true
  )
}

export function filterChannels(
  channels: SupportedChannel[],
  search: string,
): SupportedChannel[] {
  const query = search.trim().toLocaleLowerCase()
  if (!query) return channels
  return channels.filter((channel) =>
    [
      channel.display_name,
      channel.name,
      channel.runtime_note,
      channel.runtime_error,
    ].some((value) => value?.toLocaleLowerCase().includes(query)),
  )
}

/** Live → Needs setup → Saved only / Partial → Not configured; empty groups are dropped. */
export function groupCatalogChannels(
  channels: SupportedChannel[],
): Array<{ key: ChannelCatalogGroupKey; channels: SupportedChannel[] }> {
  const functional = (channel: SupportedChannel) =>
    channel.runtime_status === "functional"
  return (
    [
      { key: "live", channels: channels.filter(isLiveChannel) },
      {
        key: "needsSetup",
        channels: channels.filter(
          (channel) => functional(channel) && !isLiveChannel(channel),
        ),
      },
      {
        key: "partial",
        channels: channels.filter(
          (channel) => !functional(channel) && channel.configured === true,
        ),
      },
      {
        key: "notConfigured",
        channels: channels.filter(
          (channel) => !functional(channel) && channel.configured !== true,
        ),
      },
    ] satisfies Array<{ key: ChannelCatalogGroupKey; channels: SupportedChannel[] }>
  ).filter((group) => group.channels.length > 0)
}
