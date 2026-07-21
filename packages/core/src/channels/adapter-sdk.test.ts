import {
  createChannelAdapterHarness,
  REDACTED_CHANNEL_SECRET,
  redactChannelAdapterConfig,
  requiredFieldChecks,
  type ChannelAdapter,
} from "./adapter-sdk.js";

describe("channel adapter sdk", () => {
  const adapter: ChannelAdapter = {
    metadata: {
      name: "example",
      config_key: "example",
      runtime_status: "partial",
    },
    requiredFields: ["token", "room"],
    secretFields: ["token"],
    validateConfig({ config }) {
      return requiredFieldChecks(this, config);
    },
  };

  it("builds consistent probes and setup checks for adapters", async () => {
    const harness = createChannelAdapterHarness(adapter);
    const probe = await harness.probe({ settings: { token: "secret" } });

    expect(probe.probe_status).toBe("needs_config");
    expect(probe.missing_fields).toEqual(["room"]);
    harness.expectCheck(probe.checks, "required:token", "pass");
    harness.expectCheck(probe.checks, "required:room", "fail");
  });

  it("redacts direct and nested secret fields before adapter handoff", () => {
    const redacted = redactChannelAdapterConfig(
      {
        token: "direct-secret",
        room: "ops",
        settings: {
          token: "nested-secret",
          webhook_url: "https://example.test/hook",
        },
      },
      ["token"],
      ["webhook_url"],
    );

    expect(redacted.token).toBe(REDACTED_CHANNEL_SECRET);
    expect((redacted.settings as Record<string, unknown>).token).toBe(
      REDACTED_CHANNEL_SECRET,
    );
    expect((redacted.settings as Record<string, unknown>).webhook_url).toBe(
      REDACTED_CHANNEL_SECRET,
    );
    expect(redacted.room).toBe("ops");
  });
});
