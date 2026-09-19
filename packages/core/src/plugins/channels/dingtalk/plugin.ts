import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { channelFieldValue, isValidUrlLike } from "../_shared/probe.js";
import { createDingTalkWebhookRouter } from "./index.js";

export const dingtalkChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "dingtalk",
    display_name: "DingTalk",
    config_key: "dingtalk",
    runtime_status: "functional",
    runtime_note:
      "Node DingTalk webhook adapter supports signed robot webhooks, inbound text events, outbound robot replies, filtering, and API error surfacing.",
    required_fields: ["webhook_url"],
    secret_fields: ["webhook_url", "client_secret"],
    env_fields: {
      webhook_url: "DINGTALK_WEBHOOK_URL",
      client_secret: "DINGTALK_CLIENT_SECRET",
    },
    webhook_path: "/webhooks/dingtalk",
    probe_config: (config, configuredSecrets) => {
      const webhookUrl = channelFieldValue(config, "webhook_url");
      const validShape =
        isValidUrlLike(webhookUrl, ["http:", "https:"]) ||
        configuredSecrets.has("webhook_url");
      const checks = [
        {
          id: "webhook_url_shape",
          status: validShape ? ("pass" as const) : ("fail" as const),
          message:
            "DingTalk webhook URL must be an HTTP(S) robot webhook endpoint.",
        },
      ];
      if (isValidUrlLike(webhookUrl, ["http:", "https:"])) {
        const parsed = new URL(String(webhookUrl).trim());
        checks.push({
          id: "webhook_url_endpoint",
          status:
            parsed.hostname === "oapi.dingtalk.com" &&
            parsed.pathname === "/robot/send" &&
            parsed.searchParams.has("access_token")
              ? ("pass" as const)
              : ("fail" as const),
          message:
            "DingTalk webhook URL must target oapi.dingtalk.com/robot/send with access_token.",
        });
      }
      return checks;
    },
  }),
  createRouter: createDingTalkWebhookRouter,
};
