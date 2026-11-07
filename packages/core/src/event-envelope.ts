export const CHANNELS = [
  "web",
  "webhook",
  "api",
  "timer",
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "email",
] as const;

export type ChannelName = (typeof CHANNELS)[number];
