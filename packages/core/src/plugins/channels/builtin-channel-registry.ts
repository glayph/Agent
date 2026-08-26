import { ChannelPluginRegistry } from "./sdk/index.js";
import { dingtalkChannelPlugin } from "./dingtalk/plugin.js";
import { discordChannelPlugin } from "./discord/plugin.js";
import { feishuChannelPlugin } from "./feishu/plugin.js";
import { ircChannelPlugin } from "./irc/plugin.js";
import { lineChannelPlugin } from "./line/plugin.js";
import { matrixChannelPlugin } from "./matrix/plugin.js";
import { mikiChannelPlugin } from "./miki/plugin.js";
import { mqttChannelPlugin } from "./mqtt/plugin.js";
import { onebotChannelPlugin } from "./onebot/plugin.js";
import { qqChannelPlugin } from "./qq/plugin.js";
import { slackChannelPlugin } from "./slack/plugin.js";
import { telegramChannelPlugin } from "./telegram/plugin.js";
import { wecomChannelPlugin } from "./wecom/plugin.js";
import { weixinChannelPlugin } from "./weixin/plugin.js";
import { whatsappChannelPlugin } from "./whatsapp/plugin.js";

export const builtinChannelPlugins = [
  telegramChannelPlugin,
  discordChannelPlugin,
  slackChannelPlugin,
  feishuChannelPlugin,
  dingtalkChannelPlugin,
  qqChannelPlugin,
  weixinChannelPlugin,
  wecomChannelPlugin,
  lineChannelPlugin,
  onebotChannelPlugin,
  whatsappChannelPlugin,
  mikiChannelPlugin,
  matrixChannelPlugin,
  ircChannelPlugin,
  mqttChannelPlugin,
] as const;

export const builtinChannelRegistry = new ChannelPluginRegistry(
  builtinChannelPlugins,
);

export const SUPPORTED_BUILTIN_CHANNELS = builtinChannelRegistry.manifests();
