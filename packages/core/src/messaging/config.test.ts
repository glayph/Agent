import {
  DEFAULT_MESSAGING_CONFIG,
  getMessagingConfig,
  parseMessagingConfig,
} from "./config.js";

describe("parseMessagingConfig", () => {
  it("returns all defaults for undefined/null/non-object input", () => {
    expect(parseMessagingConfig(undefined)).toEqual(DEFAULT_MESSAGING_CONFIG);
    expect(parseMessagingConfig(null)).toEqual(DEFAULT_MESSAGING_CONFIG);
    expect(parseMessagingConfig("nope")).toEqual(DEFAULT_MESSAGING_CONFIG);
    expect(parseMessagingConfig(42)).toEqual(DEFAULT_MESSAGING_CONFIG);
  });

  it("overrides individual fields while keeping others at default", () => {
    const cfg = parseMessagingConfig({
      adaptive: false,
      max_messages_per_response: 1,
    });
    expect(cfg.adaptive).toBe(false);
    expect(cfg.maxMessagesPerResponse).toBe(1);
    expect(cfg.enableChunking).toBe(DEFAULT_MESSAGING_CONFIG.enableChunking);
    expect(cfg.enableProgressMessages).toBe(
      DEFAULT_MESSAGING_CONFIG.enableProgressMessages,
    );
  });

  it("ignores wrong-typed fields and falls back to their default", () => {
    const cfg = parseMessagingConfig({
      adaptive: "yes",
      max_messages_per_response: "three",
      min_ms_between_progress: -50,
    });
    expect(cfg.adaptive).toBe(DEFAULT_MESSAGING_CONFIG.adaptive);
    expect(cfg.maxMessagesPerResponse).toBe(
      DEFAULT_MESSAGING_CONFIG.maxMessagesPerResponse,
    );
    expect(cfg.minMsBetweenProgress).toBe(
      DEFAULT_MESSAGING_CONFIG.minMsBetweenProgress,
    );
  });

  it("parses every field when fully specified", () => {
    const cfg = parseMessagingConfig({
      adaptive: false,
      max_messages_per_response: 5,
      enable_chunking: false,
      enable_streaming: false,
      enable_progress_messages: false,
      max_chunk_length: 500,
      avoid_unnecessary_messages: false,
      min_ms_before_first_progress: 1000,
      min_ms_between_progress: 200,
    });
    expect(cfg).toEqual({
      adaptive: false,
      maxMessagesPerResponse: 5,
      enableChunking: false,
      enableStreaming: false,
      enableProgressMessages: false,
      maxChunkLength: 500,
      avoidUnnecessaryMessages: false,
      minMsBeforeFirstProgress: 1000,
      minMsBetweenProgress: 200,
    });
  });
});

describe("getMessagingConfig", () => {
  it("reads agents.defaults.messaging off the orchestrator config", () => {
    const orchestrator = {
      config: {
        agents: { defaults: { messaging: { adaptive: false } } },
      },
    };
    expect(getMessagingConfig(orchestrator).adaptive).toBe(false);
  });

  it("falls back to defaults when config/agents/defaults is missing", () => {
    expect(getMessagingConfig({ config: {} })).toEqual(
      DEFAULT_MESSAGING_CONFIG,
    );
    expect(getMessagingConfig({ config: undefined as never })).toEqual(
      DEFAULT_MESSAGING_CONFIG,
    );
  });

  it("never throws on malformed config shapes", () => {
    expect(() =>
      getMessagingConfig({ config: { agents: "oops" } as never }),
    ).not.toThrow();
    expect(() =>
      getMessagingConfig(null as never),
    ).not.toThrow();
  });
});
