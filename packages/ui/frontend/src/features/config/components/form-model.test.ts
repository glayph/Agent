import { describe, expect, it } from "vitest"

import {
  buildFormFromConfig,
  parseCIDRText,
  parseFloatField,
  parseIntField,
  parseJSONObjectField,
  parseMultilineList,
  parseOptionalPositiveIntField,
} from "./form-model"

describe("config page form model", () => {
  it("builds form state from runtime config without losing nested settings", () => {
    const form = buildFormFromConfig({
      agents: {
        defaults: {
          workspace: "D:/work",
          restrict_to_workspace: false,
          max_tokens: 64000,
          turn_profile: {
            enabled: true,
            history: { mode: "off" },
            skills: { mode: "custom", allow: ["browser", "openai-docs"] },
            tools: { mode: "custom", allow: ["shell_execute"] },
          },
        },
      },
      agent: {
        security: {
          bypass_restrictions: true,
        },
      },
      tools: {
        exec: {
          enabled: false,
          allow_remote: true,
          timeout_seconds: 45,
        },
        cron: {
          allow_command: true,
          exec_timeout_minutes: 12,
        },
        mcp: {
          enabled: true,
          discovery: {
            enabled: true,
            ttl_minutes: 15,
            max_search_results: 12,
            use_bm25: false,
            use_regex: true,
          },
          servers: {
            docs: {
              type: "http",
              url: "http://127.0.0.1:3000/mcp",
              headers: { Authorization: "Bearer token" },
            },
          },
        },
      },
      heartbeat: { enabled: false, interval_seconds: 90 },
      devices: { enabled: true, monitor_usb: false },
    })

    expect(form.workspace).toBe("D:/work")
    expect(form.restrictToWorkspace).toBe(false)
    expect(form.bypassRestrictions).toBe(true)
    expect(form.maxTokens).toBe("64000")
    expect(form.contextWindow).toBe("")
    expect(form.allowCommand).toBe(true)
    expect(form.cronExecTimeoutMinutes).toBe("12")
    expect(form.heartbeatEnabled).toBe(false)
    expect(form.heartbeatInterval).toBe("2")
    expect(form.devicesEnabled).toBe(true)
    expect(form.monitorUSB).toBe(false)
    expect(form.turnProfile).toMatchObject({
      enabled: true,
      historyMode: "off",
      skillsMode: "custom",
      skillsAllowText: "browser\nopenai-docs",
      toolsMode: "custom",
      toolsAllowText: "shell_execute",
    })
    expect(form.mcpServers).toHaveLength(1)
    expect(form.mcpServers[0]).toMatchObject({
      name: "docs",
      enabled: true,
      type: "http",
      url: "http://127.0.0.1:3000/mcp",
      headersText: JSON.stringify({ Authorization: "Bearer token" }, null, 2),
    })
  })

  it("treats a zero context window as the default unset value", () => {
    const defaultForm = buildFormFromConfig({
      agents: { defaults: { context_window: 0 } },
    })
    const customForm = buildFormFromConfig({
      agents: { defaults: { context_window: 131072 } },
    })

    expect(defaultForm.contextWindow).toBe("")
    expect(customForm.contextWindow).toBe("131072")
  })

  it("parses and rejects config field inputs with actionable errors", () => {
    expect(parseIntField("12", "Port", { min: 1, max: 65535 })).toBe(12)
    expect(() => parseIntField("12.5", "Port")).toThrow(
      "Port must be an integer.",
    )
    expect(parseFloatField("0.75", "Ratio", { min: 0, max: 1 })).toBe(0.75)
    expect(() => parseFloatField("two", "Ratio")).toThrow(
      "Ratio must be a number.",
    )
    expect(parseCIDRText("127.0.0.1/32, 10.0.0.0/8\n")).toEqual([
      "127.0.0.1/32",
      "10.0.0.0/8",
    ])
    expect(parseMultilineList("alpha\n\n beta ")).toEqual(["alpha", "beta"])
    expect(parseJSONObjectField('{"A":"B"}', "Headers")).toEqual({ A: "B" })
    expect(() => parseJSONObjectField('{"A":1}', "Headers")).toThrow(
      "Headers.A must be a string.",
    )
  })

  it("parses optional positive integer fields without rejecting default zero", () => {
    expect(parseOptionalPositiveIntField("", "Context window")).toBeUndefined()
    expect(parseOptionalPositiveIntField("0", "Context window")).toBeUndefined()
    expect(parseOptionalPositiveIntField(" 4096 ", "Context window")).toBe(
      4096,
    )
    expect(() =>
      parseOptionalPositiveIntField("-1", "Context window"),
    ).toThrow("Context window must be >= 1.")
  })
})
