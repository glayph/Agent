import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  migrateRuntimeConfig,
  validateRuntimeConfig,
} from "./schema.js";

describe("runtime config schema", () => {
  it("migrates legacy nested sections into the canonical runtime shape", () => {
    const migrated = migrateRuntimeConfig({
      agent: {
        name: "Owl",
        heartbeat: { enabled: true, interval: 30 },
      },
      agents: { defaults: { max_tokens: 4096 } },
    });

    expect(migrated.schema_version).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(migrated.heartbeat).toEqual({
      enabled: true,
      interval: 30,
      interval_seconds: 30,
    });
    expect(migrated.agent?.max_tokens_per_cycle).toBe(4096);
  });

  it("returns field-level errors for invalid values", () => {
    const result = validateRuntimeConfig({
      concurrency: {
        maxConcurrentTasks: 0,
        maxParallelToolCalls: 0,
        toolLockTimeoutMs: 999,
      },
      channels: { telegram: "bad" },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        "concurrency.maxConcurrentTasks",
        "concurrency.maxParallelToolCalls",
        "concurrency.toolLockTimeoutMs",
        "channels.telegram",
      ]),
    );
  });

  it("keeps unknown top-level keys as warnings for backward compatibility", () => {
    const result = validateRuntimeConfig({
      agent: { name: "Owl" },
      plugin_runtime: { enabled: true },
    });

    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ path: "plugin_runtime", code: "unknown_key" }),
    );
  });

  it("accepts resource-aware agent runtime settings", () => {
    const result = validateRuntimeConfig({
      agent: {
        name: "Owl",
        resource: {
          mode: "balanced",
          message_history_limit: 12,
          max_context_chars: 60000,
          system_index_limit: 6,
          system_index_cache_ttl_ms: 15000,
          tool_warmup_enabled: true,
          quality_retry_limit: 1,
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts behavior learning self-improvement config with defaults", () => {
    const result = validateRuntimeConfig({
      self_improvement: {
        enabled: true,
        behavior_learning: {
          enabled: true,
          mode: "observe",
          exploration_rate: 0.2,
          min_samples: 5,
          max_draft_notes: 2,
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.config.self_improvement?.behavior_learning).toEqual({
      enabled: true,
      mode: "observe",
      exploration_rate: 0.2,
      min_samples: 5,
      max_draft_notes: 2,
    });

    const defaulted = validateRuntimeConfig({
      self_improvement: { enabled: true },
    });

    expect(defaulted.valid).toBe(true);
    expect(defaulted.config.self_improvement?.behavior_learning).toEqual({
      enabled: true,
      mode: "draft",
      exploration_rate: 0.1,
      min_samples: 3,
      max_draft_notes: 3,
    });
  });

  it("rejects invalid behavior learning mode, rate, and sample values", () => {
    const result = validateRuntimeConfig({
      self_improvement: {
        behavior_learning: {
          mode: "train",
          exploration_rate: 1.2,
          min_samples: 0,
          max_draft_notes: -1,
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "self_improvement.behavior_learning.mode",
        }),
        expect.objectContaining({
          path: "self_improvement.behavior_learning.exploration_rate",
        }),
        expect.objectContaining({
          path: "self_improvement.behavior_learning.min_samples",
        }),
        expect.objectContaining({
          path: "self_improvement.behavior_learning.max_draft_notes",
        }),
      ]),
    );
  });

  it("accepts supported channel, MCP, and web-search settings", () => {
    const result = validateRuntimeConfig({
      channels: {
        telegram: { enabled: false },
        feishu: { enabled: true, settings: { app_id: "cli_test" } },
        dingtalk: { enabled: true, settings: { webhook_url: "secret-ref" } },
        qq: { enabled: false, settings: { bot_id: "123456" } },
        mqtt: { enabled: true, settings: { broker: "mqtt://127.0.0.1" } },
      },
      tools: {
        mcp: {
          enabled: true,
          discovery: { enabled: true, use_bm25: true, use_regex: false },
          servers: {
            local: {
              enabled: true,
              type: "stdio",
              command: "node",
              args: ["server.js"],
              env: { API_MODE: "local" },
            },
            remote: {
              enabled: true,
              type: "sse",
              url: "https://mcp.example.com/sse",
              headers: { Authorization: { secret_ref: "mcp.remote.token" } },
            },
          },
        },
      },
      web_search: {
        provider: "brave",
        providers: [{ id: "brave", configured: true }],
        settings: { brave: { enabled: true, api_key_set: true } },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects unsupported channel names", () => {
    const result = validateRuntimeConfig({
      channels: { madeup: { enabled: true } },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "channels.madeup",
        code: "unsupported_channel",
      }),
    );
  });

  it("rejects unsafe MCP server definitions", () => {
    const result = validateRuntimeConfig({
      tools: {
        mcp: {
          enabled: true,
          discovery: { enabled: true, use_bm25: false, use_regex: false },
          servers: {
            missingCommand: { enabled: true, type: "stdio" },
            unsafeEnv: {
              enabled: true,
              type: "stdio",
              command: "node",
              env: { NODE_OPTIONS: "--require ./hook.js" },
            },
            remoteCredentials: {
              enabled: true,
              type: "http",
              url: "https://token@example.com/mcp",
            },
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "tools.mcp.discovery",
          code: "mcp_discovery_without_search_method",
        }),
        expect.objectContaining({
          path: "tools.mcp.servers.missingCommand.command",
          code: "missing_mcp_command",
        }),
        expect.objectContaining({
          path: "tools.mcp.servers.unsafeEnv.env.NODE_OPTIONS",
          code: "unsafe_mcp_env_key",
        }),
        expect.objectContaining({
          path: "tools.mcp.servers.remoteCredentials.url",
          code: "mcp_server_url_userinfo",
        }),
      ]),
    );
  });

  it("rejects unsupported web-search providers", () => {
    const result = validateRuntimeConfig({
      web_search: {
        provider: "madeup",
        providers: [{ id: "unknown" }],
        settings: { custom: { enabled: true } },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "web_search.provider",
          code: "unsupported_web_search_provider",
        }),
        expect.objectContaining({
          path: "web_search.providers.0.id",
          code: "unsupported_web_search_provider",
        }),
        expect.objectContaining({
          path: "web_search.settings.custom",
          code: "unsupported_web_search_provider",
        }),
      ]),
    );
  });
});
