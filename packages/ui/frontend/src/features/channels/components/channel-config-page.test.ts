import { describe, expect, it } from "vitest"

import type { SupportedChannel } from "@/api/channels"

import {
  buildSavePayload,
  getChannelFieldValidationError,
  getMissingRequiredFieldKeys,
  getRequiredFieldKeys,
  isMissingRequiredValue,
  normalizeConfig,
} from "./channel-config-model"

const slackChannel: SupportedChannel = {
  name: "slack",
  display_name: "Slack",
  config_key: "slack",
}

const dingTalkChannel: SupportedChannel = {
  name: "dingtalk",
  display_name: "DingTalk",
  config_key: "dingtalk",
}

describe("channel config form behavior", () => {
  it("serializes common fields, settings, arrays, and edited secrets for submit", () => {
    const payload = buildSavePayload(
      slackChannel,
      {
        enabled: false,
        bot_token: "existing-bot-token",
        _bot_token: "new-bot-token",
        app_token: "existing-app-token",
        _app_token: "",
        allow_from: [" U1 ", "U2"],
        group_trigger: { prefixes: [" !owl ", " /ask "] },
        signing_secret: "plain-setting",
        workspace_id: [" T1 ", "T2"],
      },
      true,
    )

    expect(payload).toEqual({
      enabled: true,
      type: "slack",
      allow_from: "U1\nU2",
      group_trigger: { prefixes: "!owl\n/ask" },
      settings: {
        bot_token: "new-bot-token",
        app_token: "existing-app-token",
        signing_secret: "plain-setting",
        workspace_id: "T1\nT2",
      },
    })
  })

  it("normalizes WhatsApp variants and validates required channel fields", () => {
    expect(
      normalizeConfig({ name: "whatsapp_native", config_key: "whatsapp" }, {}),
    ).toMatchObject({ use_native: true })
    expect(
      normalizeConfig({ name: "whatsapp", config_key: "whatsapp" }, {}),
    ).toMatchObject({ use_native: false })

    expect(getRequiredFieldKeys("slack")).toEqual(["bot_token", "app_token"])
    expect(getRequiredFieldKeys("feishu")).toEqual(["app_id", "app_secret"])
    expect(getRequiredFieldKeys("dingtalk")).toEqual(["webhook_url"])
    expect(getRequiredFieldKeys("qq")).toEqual(["bot_id", "token"])
    expect(getRequiredFieldKeys("wecom")).toEqual(["bot_id", "secret"])
    expect(getRequiredFieldKeys("whatsapp_native")).toEqual(["config"])
    expect(getRequiredFieldKeys("matrix")).toEqual([
      "homeserver_url",
      "user_id",
      "access_token",
    ])
    expect(isMissingRequiredValue("   ")).toBe(true)
    expect(isMissingRequiredValue([])).toBe(true)
    expect(isMissingRequiredValue("configured")).toBe(false)
    expect(getMissingRequiredFieldKeys("slack", {}, [], false)).toEqual([])
    expect(getMissingRequiredFieldKeys("slack", {}, [], true)).toEqual([
      "bot_token",
      "app_token",
    ])
    expect(
      getMissingRequiredFieldKeys(
        "slack",
        {},
        ["bot_token", "app_token"],
        true,
      ),
    ).toEqual([])
    expect(
      getMissingRequiredFieldKeys(
        "wecom",
        { bot_id: "bot-id", _secret: "" },
        [],
        true,
      ),
    ).toEqual(["secret"])
    expect(
      getMissingRequiredFieldKeys(
        "wecom",
        { bot_id: "bot-id", _secret: "" },
        ["secret"],
        true,
      ),
    ).toEqual([])
  })

  it("serializes DingTalk webhook URLs as secrets", () => {
    const payload = buildSavePayload(
      dingTalkChannel,
      {
        _webhook_url:
          "https://oapi.dingtalk.com/robot/send?access_token=secret",
      },
      true,
    )

    expect(payload).toEqual({
      enabled: true,
      type: "dingtalk",
      settings: {
        webhook_url: "https://oapi.dingtalk.com/robot/send?access_token=secret",
      },
    })
  })

  it("validates config-only channel field shapes before save", () => {
    expect(
      getChannelFieldValidationError("feishu", "app_id", "cli_a123"),
    ).toBeNull()
    expect(
      getChannelFieldValidationError("feishu", "app_id", "bad app id"),
    ).toContain("Feishu app_id")

    expect(
      getChannelFieldValidationError(
        "dingtalk",
        "webhook_url",
        "https://oapi.dingtalk.com/robot/send?access_token=secret",
      ),
    ).toBeNull()
    expect(
      getChannelFieldValidationError(
        "dingtalk",
        "webhook_url",
        "https://example.com/robot/send?access_token=secret",
      ),
    ).toContain("DingTalk webhook URL")

    expect(getChannelFieldValidationError("qq", "bot_id", "123456")).toBeNull()
    expect(getChannelFieldValidationError("qq", "bot_id", "abc")).toContain(
      "QQ bot_id",
    )
  })
})
