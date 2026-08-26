import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as yaml from "js-yaml";
import * as path from "path";
import express from "express";
import { SkillRegistry, type PluginContracts } from "@miki/installer";
import {
  canRunDashboardSetup,
  dashboardAccessDecision,
  validateOneTimeBootstrapToken,
  type StoredAuth,
} from "./launcher-auth-guards.js";
import {
  createLauncherCompatRouter,
  runtimeModelName,
  SUPPORTED_CHANNELS,
  type RuntimeReloadRequest,
} from "./launcher-compat.js";
import { routeAgentTask } from "../agent-router.js";
import type { AgentOrchestrator } from "../agent.js";
import type { SkillLoader } from "../skill-loader.js";
import { openAICompatibleAdapter } from "../llm/provider/openai-compatible-adapter.js";
import { normalizeRuntimePaths, resolveDownloadedSkillsDir } from "../paths.js";
import { buildChannelRuntimeProbe } from "./channel-runtime-probe.js";
import {
  normalizeDiscordPrompt,
  resolveDiscordRuntimeConfig,
  shouldHandleDiscordMessage,
} from "../channels/discord.js";
import {
  normalizeSlackPrompt,
  resolveSlackRuntimeConfig,
  shouldHandleSlackEvent,
} from "../channels/slack.js";
import {
  resolveLineRuntimeConfig,
  shouldHandleLineEvent,
  verifyLineSignature,
} from "../channels/line.js";
import {
  normalizeIrcPrompt,
  parseIrcLine,
  resolveIrcRuntimeConfig,
  shouldHandleIrcMessage,
} from "../channels/irc.js";
import {
  normalizeOneBotPrompt,
  resolveOneBotRuntimeConfig,
  shouldHandleOneBotEvent,
} from "../channels/onebot.js";
import {
  buildMqttPublishPacket,
  mqttRequestInfo,
  parseMqttPackets,
  parseMqttPublishPacket,
  parseMqttRequestPayload,
  resolveMqttRuntimeConfig,
} from "../channels/mqtt.js";
import {
  parseWhatsAppBridgeEvent,
  resolveWhatsAppBridgeRuntimeConfig,
  shouldHandleWhatsAppBridgeEvent,
  whatsappSessionId,
} from "../channels/whatsapp.js";
import {
  dingTalkSessionId,
  parseDingTalkWebhookEvent,
  resolveDingTalkRuntimeConfig,
  shouldHandleDingTalkEvent,
  signDingTalkWebhookUrl,
  verifyDingTalkSignature,
} from "../channels/dingtalk.js";
import {
  feishuChallengeResponse,
  feishuSessionId,
  normalizeFeishuPrompt,
  parseFeishuWebhookEvent,
  resolveFeishuRuntimeConfig,
  shouldHandleFeishuEvent,
  verifyFeishuToken,
} from "../channels/feishu.js";
import {
  normalizeQqPrompt,
  parseQqWebhookEvent,
  qqSessionId,
  resolveQqRuntimeConfig,
  shouldHandleQqEvent,
} from "../channels/qq.js";
import {
  clearSessionPermissions,
  getToolPermissionDecision,
  recordToolPermissionDenial,
  setSessionPermissions,
} from "../mcp/permissions/session-permissions.js";

type TestRequest = (apiPath: string, init?: RequestInit) => Promise<Response>;

const TEST_ENV_KEYS = [
  "DEFAULT_MODEL",
  "SUPPORTED_MODELS",
  "GATEWAY_PORT",
  "GATEWAY_HOST",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "DEEPSEEK_API_KEY",
  "WEIXIN_ACCOUNT_ID",
  "WEIXIN_TOKEN",
  "WEIXIN_ENCODING_AES_KEY",
  "WECOM_BOT_ID",
  "WECOM_SECRET",
  "WECOM_CORP_SECRET",
  "WECOM_WEBHOOK_URL",
];

function createTestOrchestrator() {
  return {
    config: {},
    tools: {
      getToolDefinitions: () => [],
    },
    memory: {
      relational: {
        goals: {},
        models: {},
        getAllSessions: () => [],
        getMessages: () => [],
        getSession: () => undefined,
        deleteSession: () => undefined,
      },
    },
    routeAgentTask: (message: string) => routeAgentTask(message),
    concurrencyConfig: {
      maxParallelToolCalls: 8,
      maxConcurrentTasks: 3,
    },
  };
}

async function withLauncherCompatServer(
  run: (request: TestRequest, workspaceDir: string) => Promise<void>,
  options: {
    reloadRuntime?: (request?: RuntimeReloadRequest) => Promise<void> | void;
  } = {},
): Promise<void> {
  const workspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "Miki-config-api-"),
  );
  const envSnapshot = new Map(
    TEST_ENV_KEYS.map((key) => [key, process.env[key]] as const),
  );
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
  fs.mkdirSync(path.join(workspaceDir, "config"), { recursive: true });

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(
    "/api",
    createLauncherCompatRouter({
      orchestrator: createTestOrchestrator() as unknown as AgentOrchestrator,
      skillLoader: {
        getAllSkillsMetadata: async () => [],
        refreshCache: () => {},
      } as unknown as SkillLoader,
      workspaceDir,
      runtimePaths: normalizeRuntimePaths(workspaceDir),
      reloadRuntime: options.reloadRuntime,
    }),
  );

  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  let cookie = "";
  const request: TestRequest = async (apiPath, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(`${baseUrl}${apiPath}`, {
      ...init,
      headers,
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      cookie = setCookie.split(";")[0];
    }
    return response;
  };

  try {
    const password = "password123";
    await request("/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password, confirm: password }),
    });
    await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    await run(request, workspaceDir);
  } finally {
    for (const [key, value] of envSnapshot) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

async function registerLauncherPluginContracts(
  workspaceDir: string,
  contracts: PluginContracts,
): Promise<void> {
  const skillsDir = resolveDownloadedSkillsDir(
    normalizeRuntimePaths(workspaceDir),
    workspaceDir,
  );
  const assetsPath = path.join(skillsDir, "launcher_channel_plugin_assets");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(assetsPath, { recursive: true });
  const registry = new SkillRegistry(skillsDir);
  await registry.init();
  await registry.register({
    success: true,
    name: "launcher_channel_plugin",
    version: "1.0.0",
    path: path.join(skillsDir, "launcher_channel_plugin.ts"),
    action: "installed",
    entrypoint: "index.ts",
    assetsPath,
    contracts,
  });
}

describe("launcher compatibility auth guards", () => {
  const initializedAuth: StoredAuth = {
    salt: "salt",
    password_hash: "hash",
  };

  it("allows dashboard setup only when uninitialized or already authenticated", () => {
    expect(canRunDashboardSetup(undefined, false)).toBe(true);
    expect(canRunDashboardSetup(initializedAuth, false)).toBe(false);
    expect(canRunDashboardSetup(initializedAuth, true)).toBe(true);
  });

  it("allows protected dashboard APIs after launcher bootstrap before password setup", () => {
    expect(dashboardAccessDecision(undefined, false)).toBe("uninitialized");
    expect(dashboardAccessDecision(initializedAuth, false)).toBe(
      "unauthorized",
    );
    expect(dashboardAccessDecision(undefined, true)).toBe("allow");
    expect(dashboardAccessDecision(initializedAuth, true)).toBe("allow");
  });

  it("requires an explicit one-time bootstrap token", () => {
    const consumed = new Set<string>();

    expect(validateOneTimeBootstrapToken("token", undefined, consumed)).toBe(
      false,
    );
    expect(validateOneTimeBootstrapToken("wrong", "expected", consumed)).toBe(
      false,
    );
    expect(
      validateOneTimeBootstrapToken("expected", "expected", consumed),
    ).toBe(true);
    expect(
      validateOneTimeBootstrapToken("expected", "expected", consumed),
    ).toBe(false);
  });
});

describe("dashboard login throttling behind the gateway proxy", () => {
  // Mirrors production: core is only ever reached through the gateway over
  // 127.0.0.1 (packages/config/src/config.ts coreHost default), and the
  // gateway forwards the real client address via X-Forwarded-For (xfwd,
  // packages/gateway/src/index.ts apiProxy). `trust proxy: "loopback"` on
  // core's own app (packages/core/src/api/index.ts) is what makes
  // loginFailureKey() see the real client instead of the shared gateway
  // connection. Without it, every client behind the gateway collapses into
  // one failed-login bucket and one bad client can lock everyone out.
  async function withTrustProxyServer(
    run: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-login-throttle-"),
    );
    fs.mkdirSync(path.join(workspaceDir, "config"), { recursive: true });

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.set("trust proxy", "loopback");
    app.use(
      "/api",
      createLauncherCompatRouter({
        orchestrator: createTestOrchestrator() as unknown as AgentOrchestrator,
        skillLoader: {
          getAllSkillsMetadata: async () => [],
          refreshCache: () => {},
        } as unknown as SkillLoader,
        workspaceDir,
        runtimePaths: normalizeRuntimePaths(workspaceDir),
      }),
    );

    const server = await new Promise<http.Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${address.port}/api`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  it("keys failed-login lockout by the forwarded client IP, not the shared loopback connection", async () => {
    await withTrustProxyServer(async (baseUrl) => {
      const password = "password123";
      const loginAs = (forwardedFor: string, attemptPassword: string) =>
        fetch(`${baseUrl}/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": forwardedFor,
          },
          body: JSON.stringify({ password: attemptPassword }),
        });

      await fetch(`${baseUrl}/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirm: password }),
      });

      // Client A exhausts the failure budget (8 attempts) and gets locked out.
      for (let i = 0; i < 8; i++) {
        const res = await loginAs("10.0.0.5", "wrong-password");
        expect(res.status).toBe(401);
      }
      const lockedOut = await loginAs("10.0.0.5", "wrong-password");
      expect(lockedOut.status).toBe(429);

      // Client B, forwarded through the same trusted loopback gateway hop
      // but with a different client address, must not inherit A's lockout.
      const otherClientAttempt = await loginAs("10.0.0.9", "wrong-password");
      expect(otherClientAttempt.status).toBe(401);
      const otherClientSuccess = await loginAs("10.0.0.9", password);
      expect(otherClientSuccess.status).toBe(200);

      // Client A is still locked out.
      const stillLocked = await loginAs("10.0.0.5", password);
      expect(stillLocked.status).toBe(429);
    });
  });
});

describe("launcher compatibility config validation", () => {
  afterEach(() => clearSessionPermissions());

  it("exposes single-agent route preview through launcher API", async () => {
    await withLauncherCompatServer(async (request) => {
      const engineer = await request("/agent/route-preview", {
        method: "POST",
        body: JSON.stringify({
          message:
            "Superfast implement production integration tests for the plugin marketplace runtime and verify the API.",
        }),
      }).then((res) => res.json());
      const planner = await request("/agent/route-preview", {
        method: "POST",
        body: JSON.stringify({
          message:
            "Plan the production ecosystem roadmap and workflow architecture for marketplace onboarding.",
        }),
      }).then((res) => res.json());

      expect(engineer).toEqual(
        expect.objectContaining({
          success: true,
          summary: expect.objectContaining({
            agentId: "miki",
            complexity: "complex",
            speedClass: "medium",
            verificationDepth: "integration",
          }),
          acceleration: expect.objectContaining({
            mode: "turbo",
            speedClass: "medium",
            verificationDepth: "integration",
          }),
          decisionPattern: expect.objectContaining({
            id: "turbo_implementation",
            speedClass: "medium",
          }),
        }),
      );
      expect(engineer.data.candidates.length).toBeGreaterThan(0);
      expect(planner).toEqual(
        expect.objectContaining({
          success: true,
          summary: expect.objectContaining({
            agentId: "miki",
            complexity: "complex",
          }),
        }),
      );
      expect(planner.summary.reasons.length).toBeGreaterThan(0);
    });
  });

  it("exposes session permission state and denied-call history", async () => {
    await withLauncherCompatServer(async (request) => {
      setSessionPermissions("mcp-session-1", { shell_execute: false });
      const decision = getToolPermissionDecision(
        "mcp-session-1",
        "shell_execute",
      );
      recordToolPermissionDenial("mcp-session-1", decision, {
        actor: "mcp",
        requestId: "launcher-denial",
        args: {
          cmd: "node -v",
          token: ["sk", "launcher-denial-secret"].join("-"),
        },
      });

      const response = await request("/sessions/mcp-session-1/permissions");
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissions).toEqual({ shell_execute: false });
      expect(body.denials).toEqual([
        expect.objectContaining({
          toolName: "shell_execute",
          actor: "mcp",
          requestId: "launcher-denial",
          source: "session",
          argsPreview: {
            cmd: "node -v",
            token: "[REDACTED]",
          },
        }),
      ]);

      const update = await request("/sessions/mcp-session-1/permissions", {
        method: "PUT",
        body: JSON.stringify({ permissions: { file_delete: false } }),
      });
      const updated = await update.json();

      expect(update.status).toBe(200);
      expect(updated.permissions).toEqual({ file_delete: false });
      expect(updated.state.timeline.at(-1)).toEqual(
        expect.objectContaining({
          toolName: "file_delete",
          action: "deny",
        }),
      );
    });
  });

  it("defaults every supported channel to disabled opt-in configuration", async () => {
    await withLauncherCompatServer(async (request) => {
      const config = await request("/config").then((res) => res.json());

      for (const channel of SUPPORTED_CHANNELS) {
        const savedChannel = config.channels[channel.config_key];
        expect(savedChannel).toMatchObject({
          enabled: false,
          type: channel.config_key,
        });
      }
      expect(config.channel_list).toEqual(config.channels);
    });
  });

  it("rejects invalid config patches without mutating runtime config", async () => {
    await withLauncherCompatServer(async (request) => {
      const response = await request("/config", {
        method: "PATCH",
        body: JSON.stringify({
          channels: { madeup: { enabled: true } },
        }),
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("channels.madeup")]),
      );

      const saved = await request("/config").then((res) => res.json());
      expect(saved.channels.madeup).toBeUndefined();
      expect(saved.channel_list.madeup).toBeUndefined();
    });
  });

  it("blocks unsafe MCP server config saves", async () => {
    await withLauncherCompatServer(async (request) => {
      const response = await request("/config", {
        method: "PATCH",
        body: JSON.stringify({
          tools: {
            mcp: {
              servers: {
                unsafe: {
                  enabled: true,
                  type: "stdio",
                  command: "node",
                  env: { NODE_OPTIONS: "--require ./hook.js" },
                },
              },
            },
          },
        }),
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("tools.mcp.servers.unsafe.env.NODE_OPTIONS"),
        ]),
      );
    });
  });

  it("validates config payloads and saves migrated valid config", async () => {
    await withLauncherCompatServer(async (request) => {
      const validation = await request("/config/validate", {
        method: "POST",
        body: JSON.stringify({
          heartbeat: { enabled: true, interval: 45 },
          channels: { telegram: { enabled: false } },
        }),
      }).then((res) => res.json());

      expect(validation.valid).toBe(true);

      const response = await request("/config", {
        method: "PATCH",
        body: JSON.stringify({
          heartbeat: { enabled: true, interval: 45 },
          channels: { telegram: { enabled: false } },
        }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.validation.valid).toBe(true);

      const saved = await request("/config").then((res) => res.json());
      expect(saved.heartbeat.interval_seconds).toBe(45);
      expect(saved.channels.telegram.enabled).toBe(false);
    });
  });

  it("mirrors the cron allow_command switch into agent.yaml, not just tools.yaml (#92)", async () => {
    // The scheduler/cron gate the agent runtime enforces
    // (asAgentConfig(this.config).tools?.cron?.allow_command) is read
    // from agent.yaml on every config load - agent.ts never reads
    // tools.yaml directly (that file is only passed to ToolRegistry
    // separately). The dashboard's Cron "Allow Shell Execution" switch is
    // saved through syncToolsYaml() into tools.yaml's runtime.cron block.
    // Without syncAgentYaml() also mirroring that block into agent.yaml,
    // turning the switch on in the UI would never actually reach the
    // gate the scheduler checks.
    await withLauncherCompatServer(async (request, workspaceDir) => {
      const response = await request("/config", {
        method: "PATCH",
        body: JSON.stringify({
          tools: {
            cron: { allow_command: true, exec_timeout_minutes: 7 },
          },
        }),
      });
      expect(response.status).toBe(200);

      const agentYamlPath = path.join(workspaceDir, "config", "agent.yaml");
      const agentYaml = yaml.load(fs.readFileSync(agentYamlPath, "utf-8")) as {
        tools?: { cron?: Record<string, unknown> };
      };

      expect(agentYaml.tools?.cron?.allow_command).toBe(true);
      expect(agentYaml.tools?.cron?.exec_timeout_minutes).toBe(7);

      const toolsYamlPath = path.join(workspaceDir, "config", "tools.yaml");
      const toolsYaml = yaml.load(fs.readFileSync(toolsYamlPath, "utf-8")) as {
        runtime?: { cron?: Record<string, unknown> };
      };
      expect(toolsYaml.runtime?.cron?.allow_command).toBe(true);
    });
  });

  it("strips embedded CR/LF from config values before writing them into .env (#18)", async () => {
    await withLauncherCompatServer(async (request, workspaceDir) => {
      const injected =
        "https://bridge.example.com/send\r\nMIKI_TRUSTED_FULL_ACCESS=true\r\nEVIL=1";

      const response = await request("/config", {
        method: "PATCH",
        body: JSON.stringify({
          channels: {
            whatsapp: { settings: { bridge_url: injected } },
          },
        }),
      });

      expect(response.status).toBe(200);

      // .env lives under <workspace>/config/.env (normalizeRuntimePaths).
      const envPath = path.join(workspaceDir, "config", ".env");
      const envContent = fs.existsSync(envPath)
        ? fs.readFileSync(envPath, "utf-8")
        : "";

      // The whole malicious payload must collapse onto a single
      // WHATSAPP_BRIDGE_URL= line; none of the injected lines may appear
      // as their own standalone .env entries.
      expect(envContent).not.toMatch(/^MIKI_TRUSTED_FULL_ACCESS=true$/m);
      expect(envContent).not.toMatch(/^EVIL=1$/m);
      const bridgeLine = envContent
        .split("\n")
        .find((line) => line.startsWith("WHATSAPP_BRIDGE_URL="));
      expect(bridgeLine).toBeDefined();
      expect(bridgeLine).not.toContain("\r");
    });
  });

  it("rejects unsupported web-search provider config", async () => {
    await withLauncherCompatServer(async (request) => {
      const response = await request("/tools/web-search-config", {
        method: "PUT",
        body: JSON.stringify({
          provider: "madeup",
          current_service: "madeup",
          providers: [{ id: "madeup", configured: true }],
          settings: { madeup: { enabled: true } },
        }),
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("web_search.provider"),
          expect.stringContaining("web_search.current_service"),
        ]),
      );
    });
  });

  it("defaults web-search execution to local and normalizes unsafe mode values", async () => {
    await withLauncherCompatServer(async (request) => {
      const defaultResponse = await request("/tools/web-search-config");
      expect(defaultResponse.status).toBe(200);
      expect((await defaultResponse.json()).execution_mode).toBe("local");

      const invalidResponse = await request("/tools/web-search-config", {
        method: "PUT",
        body: JSON.stringify({ execution_mode: "remote" }),
      });
      expect(invalidResponse.status).toBe(200);
      expect((await invalidResponse.json()).execution_mode).toBe("local");

      const cloudResponse = await request("/tools/web-search-config", {
        method: "PUT",
        body: JSON.stringify({ execution_mode: "cloud" }),
      });
      expect(cloudResponse.status).toBe(200);
      expect((await cloudResponse.json()).execution_mode).toBe("cloud");
    });
  });

  it("stores model API keys in the vault and returns only masked state", async () => {
    await withLauncherCompatServer(async (request, workspaceDir) => {
      const secret = ["sk", "model-secret-value-1234567890"].join("-");
      const response = await request("/models", {
        method: "POST",
        body: JSON.stringify({
          model_name: "openai/gpt-4o",
          provider: "openai",
          api_key: secret,
        }),
      });

      expect(response.status).toBe(200);
      const envPath = path.join(workspaceDir, ".env");
      const envContent = fs.existsSync(envPath)
        ? fs.readFileSync(envPath, "utf-8")
        : "";
      const stateContent = fs.readFileSync(
        path.join(workspaceDir, "data", "launcher-state.json"),
        "utf-8",
      );
      const vaultContent = fs.readFileSync(
        path.join(workspaceDir, "config", "data", "secret-vault.json"),
        "utf-8",
      );

      expect(envContent).not.toContain(secret);
      expect(stateContent).not.toContain(secret);
      expect(vaultContent).not.toContain(secret);

      const models = await request("/models").then((res) => res.json());
      const saved = models.models.find(
        (model: { model_name: string }) => model.model_name === "openai/gpt-4o",
      );
      expect(saved.api_key).toBe("sk-m...7890");
      expect(saved.api_key_set).toBe(true);
    });
  });

  it("rejects invalid model identifiers at the API boundary", async () => {
    await withLauncherCompatServer(async (request) => {
      for (const modelName of [
        "openai gpt-4o",
        "/openai/gpt-4o",
        "openai//gpt-4o",
        "openai/",
      ]) {
        const response = await request("/models", {
          method: "POST",
          body: JSON.stringify({ model_name: modelName }),
        });
        expect(response.status).toBe(400);
      }

      const defaultResponse = await request("/models/default", {
        method: "POST",
        body: JSON.stringify({ model_name: "openai//gpt-4o" }),
      });
      expect(defaultResponse.status).toBe(400);
      const saved = await request("/models").then((res) => res.json());
      expect(
        saved.models.some((model: { model_name: string }) =>
          model.model_name.includes("//"),
        ),
      ).toBe(false);
    });
  });

  it("validates inline model test inputs before provider calls", async () => {
    await withLauncherCompatServer(async (request) => {
      const invalidModel = await request("/models/test-inline", {
        method: "POST",
        body: JSON.stringify({
          provider: "openai",
          model: "openai//gpt-4o",
          api_key: "sk-test-key",
        }),
      });
      expect(invalidModel.status).toBe(400);

      const unsafeBase = await request("/models/test-inline", {
        method: "POST",
        body: JSON.stringify({
          provider: "openai",
          model: "gpt-4o",
          api_base: "https://user:pass@example.com/v1",
          api_key: "sk-test-key",
        }),
      });
      const body = await unsafeBase.json();

      expect(unsafeBase.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toContain("api_base must not include credentials");
    });
  });

  it("reports saved provider tests as unconfigured when required API key is absent", async () => {
    await withLauncherCompatServer(async (request) => {
      const create = await request("/models", {
        method: "POST",
        body: JSON.stringify({
          model_name: "openai/gpt-4o-keyless",
          provider: "openai",
        }),
      });
      expect(create.status).toBe(400);
      const body = await create.json();
      expect(body.error).toContain("credential is required");
    });
  });

  it("preflights OpenCode Zen when its models endpoint returns a top-level array", async () => {
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.OPENCODE_API_KEY;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://127.0.0.1")) return previousFetch(input, init);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify([{ id: "mimo-v2.5-free" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "READY" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await withLauncherCompatServer(async (request) => {
        process.env.OPENCODE_API_KEY = "test-opencode-key";
        const response = await request("/models/test-inline", {
          method: "POST",
          body: JSON.stringify({
            provider: "opencode",
            model: "opencode/mimo-v2.5-free",
          }),
        });
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body).toEqual(
          expect.objectContaining({
            success: true,
            status: "ready",
            readiness_status: "ready",
            verification_level: "completion",
            completion_tested: true,
            provider: "opencode",
          }),
        );
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previousKey;
    }
  });

  it("preflights Gemini with native model discovery and OpenAI-compatible completion auth", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://127.0.0.1")) return previousFetch(input, init);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/models")) {
        expect(headers.get("x-goog-api-key")).toBe("test-gemini-key");
        expect(headers.get("authorization")).toBeNull();
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-3.6-flash",
                baseModelId: "gemini-3.6-flash",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/chat/completions")) {
        expect(headers.get("authorization")).toBe("Bearer test-gemini-key");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "READY" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await withLauncherCompatServer(async (request) => {
        const response = await request("/models/test-inline", {
          method: "POST",
          body: JSON.stringify({
            provider: "google",
            model: "gemini-3.6-flash",
            api_base:
              "https://generativelanguage.googleapis.com/v1beta/openai/",
            api_key: "test-gemini-key",
          }),
        });
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body).toEqual(
          expect.objectContaining({
            success: true,
            status: "ready",
            readiness_status: "ready",
            verification_level: "completion",
            completion_tested: true,
            provider: "gemini",
            model: "gemini-3.6-flash",
          }),
        );

        const stale = await request("/models/test-inline", {
          method: "POST",
          body: JSON.stringify({
            provider: "google",
            model: "gemini-1.5-flash",
            api_base:
              "https://generativelanguage.googleapis.com/v1beta/openai/",
            api_key: "test-gemini-key",
          }),
        });
        const staleBody = await stale.json();
        expect(staleBody).toEqual(
          expect.objectContaining({
            success: false,
            status: "model_not_found",
            completion_tested: false,
          }),
        );
        expect(staleBody.available_models).toContain("gemini-3.6-flash");
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("stores channel, web-search, and MCP header secrets outside public config", async () => {
    await withLauncherCompatServer(async (request, workspaceDir) => {
      const slackBotToken = "xoxb-release-hardening-token-1234567890";
      const slackAppToken = "xapp-release-hardening-token-1234567890";
      const dingTalkWebhook =
        "https://oapi.dingtalk.com/robot/send?access_token=release-hardening-token-1234567890";
      const tavilyKey = "tvly-release-hardening-api-key-1234567890";
      const mcpToken = "Bearer mcp-release-hardening-token-1234567890";

      const response = await request("/config", {
        method: "PATCH",
        body: JSON.stringify({
          channel_list: {
            slack: {
              enabled: true,
              type: "slack",
              settings: {
                bot_token: slackBotToken,
                app_token: slackAppToken,
              },
            },
            dingtalk: {
              enabled: true,
              type: "dingtalk",
              settings: {
                webhook_url: dingTalkWebhook,
              },
            },
          },
          web_search: {
            provider: "tavily",
            current_service: "tavily",
            providers: [
              {
                id: "tavily",
                configured: true,
                current: true,
                requires_auth: true,
              },
            ],
            settings: {
              tavily: { enabled: true, max_results: 5, api_key: tavilyKey },
            },
          },
          tools: {
            mcp: {
              servers: {
                remote: {
                  enabled: true,
                  type: "http",
                  url: "https://example.com/mcp",
                  headers: { Authorization: mcpToken },
                },
              },
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      const config = await request("/config").then((res) => res.json());
      const channelConfig = await request("/channels/slack/config").then(
        (res) => res.json(),
      );
      const probe = await request("/channels/slack/probe").then((res) =>
        res.json(),
      );
      const webSearch = await request("/tools/web-search-config").then((res) =>
        res.json(),
      );
      const stateContent = fs.readFileSync(
        path.join(workspaceDir, "data", "launcher-state.json"),
        "utf-8",
      );

      for (const secret of [
        slackBotToken,
        slackAppToken,
        dingTalkWebhook,
        tavilyKey,
        mcpToken,
      ]) {
        expect(JSON.stringify(config)).not.toContain(secret);
        expect(JSON.stringify(channelConfig)).not.toContain(secret);
        expect(JSON.stringify(webSearch)).not.toContain(secret);
        expect(stateContent).not.toContain(secret);
      }
      expect(channelConfig.config.settings?.bot_token).toBeUndefined();
      expect(channelConfig.configured_secrets).toEqual(
        expect.arrayContaining(["bot_token", "app_token"]),
      );
      expect(probe.missing_fields).toEqual([]);
      const dingTalkConfig = await request("/channels/dingtalk/config").then(
        (res) => res.json(),
      );
      const dingTalkProbe = await request("/channels/dingtalk/probe").then(
        (res) => res.json(),
      );
      expect(dingTalkConfig.config.webhook_url).toBeUndefined();
      expect(dingTalkConfig.configured_secrets).toEqual(
        expect.arrayContaining(["webhook_url"]),
      );
      expect(dingTalkProbe.missing_fields).toEqual([]);
      expect(webSearch.settings.tavily.api_key).toBeUndefined();
      expect(webSearch.settings.tavily.api_key_set).toBe(true);
      expect(
        config.tools.mcp.servers.remote.headers.Authorization.secret_ref,
      ).toBe("mcp/remote/headers/Authorization");
    });
  });

  it("exposes installed plugin channels through launcher catalog, config, and probe", async () => {
    await withLauncherCompatServer(async (request, workspaceDir) => {
      const token = "plugin-channel-secret";
      await registerLauncherPluginContracts(workspaceDir, {
        channels: [
          {
            name: "ms-teams",
            description: "Microsoft Teams",
            metadata: {
              display_name: "Microsoft Teams",
              config_key: "ms_teams",
              required_fields: ["webhook_url", "token"],
              secret_fields: ["token"],
            },
          },
        ],
      });

      const save = await request("/config", {
        method: "PATCH",
        body: JSON.stringify({
          channel_list: {
            ms_teams: {
              enabled: true,
              type: "ms_teams",
              settings: {
                webhook_url: "https://example.test/hook",
                token,
              },
            },
          },
        }),
      });
      expect(save.status).toBe(200);

      const catalog = await request("/channels/catalog").then((res) =>
        res.json(),
      );
      expect(catalog.channels).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "ms_teams",
            display_name: "Microsoft Teams",
            config_key: "ms_teams",
            runtime_status: "config_only",
          }),
        ]),
      );

      const channelConfig = await request("/channels/ms_teams/config").then(
        (res) => res.json(),
      );
      expect(channelConfig.source).toBe("plugin");
      expect(channelConfig.config.settings?.token).toBeUndefined();
      expect(channelConfig.configured_secrets).toEqual(
        expect.arrayContaining(["token"]),
      );

      const probe = await request("/channels/ms_teams/probe").then((res) =>
        res.json(),
      );
      expect(probe.probe_status).toBe("not_implemented");
      expect(probe.missing_fields).toEqual([]);
      expect(
        probe.checks.find(
          (check: { id: string }) => check.id === "plugin_contract_readiness",
        )?.status,
      ).toBe("pass");

      const stateContent = fs.readFileSync(
        path.join(workspaceDir, "data", "launcher-state.json"),
        "utf-8",
      );
      expect(JSON.stringify(channelConfig)).not.toContain(token);
      expect(stateContent).not.toContain(token);
    });
  });

  it("exposes installed plugin marketplace readiness through launcher skills routes", async () => {
    await withLauncherCompatServer(async (request, workspaceDir) => {
      await registerLauncherPluginContracts(workspaceDir, {
        channels: [
          {
            name: "ms-teams",
            description: "Microsoft Teams channel metadata",
            metadata: {
              display_name: "Microsoft Teams",
              config_key: "ms_teams",
            },
          },
        ],
      });

      const response = await request("/skills/plugin-marketplace/readiness");
      const readiness = await response.json();

      expect(response.status).toBe(200);
      expect(readiness.total).toBe(1);
      expect(readiness.summary.contracts).toBe(1);
      expect(readiness.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "incomplete",
            marketplaceReady: false,
            plugin: expect.objectContaining({
              name: "launcher_channel_plugin",
            }),
            summary: expect.objectContaining({
              metadataOnly: 1,
              byKind: expect.objectContaining({
                channels: 1,
              }),
            }),
          }),
        ]),
      );
      expect(readiness.data[0].issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "missing_author" }),
          expect.objectContaining({ code: "missing_license" }),
        ]),
      );
    });
  });

  it("exposes installed plugin providers in launcher model provider options", async () => {
    await withLauncherCompatServer(async (request, workspaceDir) => {
      await registerLauncherPluginContracts(workspaceDir, {
        providers: [
          {
            name: "local-openai-compatible",
            description: "Local OpenAI-compatible provider",
            metadata: {
              id: "local-ai",
              display_name: "Local AI",
              base_url: "http://127.0.0.1:9000/v1",
              auth_method: "none",
              local: true,
              supports_fetch: true,
              models: ["local-chat", "local-reasoner"],
            },
          },
        ],
      });

      const models = await request("/models").then((res) => res.json());

      expect(models.provider_options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "local-ai",
            display_name: "Local AI",
            default_api_base: "http://127.0.0.1:9000/v1",
            default_auth_method: "none",
            empty_api_key_allowed: true,
            supports_fetch: true,
            local: true,
            common_models: ["local-chat", "local-reasoner"],
            source: "plugin",
          }),
        ]),
      );
    });
  });

  it("keeps unconfigured disabled channels safe and exposes explicit Telegram live probe mode", async () => {
    const previousSlackBotToken = process.env["SLACK_BOT_TOKEN"];
    const previousSlackAppToken = process.env["SLACK_APP_TOKEN"];
    const previousTelegramToken = process.env["TELEGRAM_BOT_TOKEN"];
    try {
      delete process.env["SLACK_BOT_TOKEN"];
      delete process.env["SLACK_APP_TOKEN"];
      delete process.env["TELEGRAM_BOT_TOKEN"];
      await withLauncherCompatServer(async (request) => {
        const save = await request("/config", {
          method: "PATCH",
          body: JSON.stringify({
            channel_list: {
              telegram: {
                enabled: false,
                type: "telegram",
              },
              slack: {
                enabled: false,
                type: "slack",
              },
            },
          }),
        });
        expect(save.status).toBe(200);

        const slackProbe = await request("/channels/slack/probe").then((res) =>
          res.json(),
        );
        expect(slackProbe.probe_status).toBe("disabled");
        expect(slackProbe.missing_fields).toEqual(["bot_token", "app_token"]);
        expect(slackProbe.send_check.status).toBe("skipped");

        const telegramLiveProbe = await request(
          "/channels/telegram/probe?mode=live",
        ).then((res) => res.json());
        expect(telegramLiveProbe.check_mode).toBe("live");
        expect(telegramLiveProbe.probe_status).toBe("disabled");
        expect(telegramLiveProbe.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "telegram_live_skipped",
              status: "warn",
            }),
          ]),
        );
      });
    } finally {
      if (previousSlackBotToken === undefined) {
        delete process.env["SLACK_BOT_TOKEN"];
      } else {
        process.env["SLACK_BOT_TOKEN"] = previousSlackBotToken;
      }
      if (previousSlackAppToken === undefined) {
        delete process.env["SLACK_APP_TOKEN"];
      } else {
        process.env["SLACK_APP_TOKEN"] = previousSlackAppToken;
      }
      if (previousTelegramToken === undefined) {
        delete process.env["TELEGRAM_BOT_TOKEN"];
      } else {
        process.env["TELEGRAM_BOT_TOKEN"] = previousTelegramToken;
      }
    }
  });
});

describe("launcher compatibility runtime apply", () => {
  it("returns an explicit unsupported response for gateway stop", async () => {
    await withLauncherCompatServer(async (request) => {
      const response = await request("/gateway/stop", { method: "POST" });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe("unsupported");
      expect(body.supported).toBe(false);
      expect(body.error).toMatch(/not supported/);
      expect(body.pid).toBe(process.pid);
    });
  });

  it("hot-applies default model saves without leaving restart-required set", async () => {
    const previousDefaultModel = process.env["DEFAULT_MODEL"];
    const reloadRequests: RuntimeReloadRequest[] = [];
    try {
      await withLauncherCompatServer(
        async (request) => {
          const response = await request("/models/default", {
            method: "POST",
            body: JSON.stringify({ model_name: "openai/gpt-4o" }),
          });
          const body = await response.json();

          expect(response.status).toBe(200);
          expect(body.gateway_restart_required).toBe(false);
          expect(body.runtime_apply_status).toBe("applied");
          expect(reloadRequests).toEqual([
            { channelsChanged: [], reason: "models.default" },
          ]);

          const status = await request("/gateway/status").then((res) =>
            res.json(),
          );
          expect(status.gateway_restart_required).toBe(false);
          expect(status.runtime_apply_status).toBe("applied");
        },
        {
          reloadRuntime: (request) => {
            reloadRequests.push(request || {});
          },
        },
      );
    } finally {
      if (previousDefaultModel == null) {
        delete process.env["DEFAULT_MODEL"];
      } else {
        process.env["DEFAULT_MODEL"] = previousDefaultModel;
      }
    }
  });

  it("activates the provider model behind a friendly saved-model alias", async () => {
    const reloadRequests: RuntimeReloadRequest[] = [];
    await withLauncherCompatServer(
      async (request) => {
        const addResponse = await request("/models", {
          method: "POST",
          body: JSON.stringify({
            model_name: "gemini-live-test",
            provider: "google",
            model: "gemini-2.5-flash",
            api_key: ["test", "gemini", "key"].join("-"),
          }),
        });
        expect(addResponse.status).toBe(200);

        const defaultResponse = await request("/models/default", {
          method: "POST",
          body: JSON.stringify({ model_name: "gemini-live-test" }),
        });
        const defaultBody = await defaultResponse.json();
        expect(defaultResponse.status).toBe(200);
        expect(defaultBody.default_model).toBe("gemini-live-test");

        const modelsResponse = await request("/models");
        const modelsBody = await modelsResponse.json();
        expect(modelsBody.default_model).toBe("gemini-live-test");
        expect(
          modelsBody.models.find(
            (model: { model_name: string }) =>
              model.model_name === "gemini-live-test",
          ),
        ).toEqual(expect.objectContaining({ is_default: true }));
        expect(reloadRequests).toEqual(
          expect.arrayContaining([
            { channelsChanged: [], reason: "models.add" },
            { channelsChanged: [], reason: "models.default" },
          ]),
        );
      },
      {
        reloadRuntime: (request) => {
          reloadRequests.push(request || {});
        },
      },
    );
  });

  it("preserves provider prefixes for runtime model identities", () => {
    expect(
      runtimeModelName({
        model_name: "openai/gpt-4o-mini",
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    ).toBe("openai/gpt-4o-mini");
    expect(
      runtimeModelName({
        model_name: "opencode/mimo-v2.5-free",
        provider: "opencode",
        model: "mimo-v2.5-free",
      }),
    ).toBe("opencode/mimo-v2.5-free");
    expect(
      runtimeModelName({
        model_name: "claude/claude-3-5-sonnet",
        provider: "claude",
        model: "claude-3-5-sonnet",
      }),
    ).toBe("claude/claude-3-5-sonnet");
    expect(
      runtimeModelName({
        model_name: "llama.cpp/local-test",
        provider: "llama.cpp",
        model: "local-test",
      }),
    ).toBe("llama.cpp/local-test");
  });

  it("passes changed channel names to the runtime reloader", async () => {
    const reloadRequests: RuntimeReloadRequest[] = [];
    await withLauncherCompatServer(
      async (request) => {
        const response = await request("/config", {
          method: "PATCH",
          body: JSON.stringify({
            channel_list: {
              telegram: {
                enabled: true,
                type: "telegram",
                settings: { token: "telegram-runtime-token-1234567890" },
              },
            },
          }),
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.gateway_restart_required).toBe(false);
        expect(reloadRequests.at(-1)?.channelsChanged).toEqual(["telegram"]);
      },
      {
        reloadRuntime: (request) => {
          reloadRequests.push(request || {});
        },
      },
    );
  });

  it("exposes Flow.md runtime contract status", async () => {
    await withLauncherCompatServer(async (request) => {
      const response = await request("/system/flow");
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.flow_version).toBe(1);
      expect(["ready", "partial", "disabled", "error"]).toContain(body.status);
      expect(
        body.components.map((component: { id: string }) => component.id),
      ).toEqual(
        expect.arrayContaining([
          "ui",
          "gateway",
          "auth",
          "agent_core",
          "memory_context",
          "model",
          "mcp",
          "plugins_skills",
          "system_access",
        ]),
      );
      expect(body.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "ui", to: "gateway" }),
          expect.objectContaining({ from: "agent_core", to: "mcp" }),
          expect.objectContaining({ from: "gateway", to: "ui" }),
        ]),
      );
      expect(body.gaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "skills-not-loaded",
            owner: "plugins_skills",
          }),
        ]),
      );
    });
  });

  it("keeps process-bound gateway changes pending after gateway reload", async () => {
    await withLauncherCompatServer(async (request) => {
      const update = await request("/system/launcher-config", {
        method: "PUT",
        body: JSON.stringify({
          port: 19999,
          public: false,
          allowed_cidrs: [],
        }),
      }).then((res) => res.json());

      expect(update.gateway_restart_required).toBe(true);
      expect(update.runtime_apply_status).toBe("pending_restart");
      expect(update.pending_restart_fields).toContain("gateway.port");

      const reload = await request("/gateway/restart", {
        method: "POST",
      }).then((res) => res.json());

      expect(reload.status).toBe("pending_restart");
      expect(reload.gateway_restart_required).toBe(true);
      expect(reload.runtime_apply_status).toBe("pending_restart");
      expect(reload.pending_restart_fields).toContain("gateway.port");
      expect(reload.message).toContain("gateway.port");

      const flow = await request("/system/flow").then((res) => res.json());
      expect(flow.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "gateway", status: "partial" }),
        ]),
      );
      expect(flow.gaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "process-bound-gateway-settings",
            owner: "gateway",
          }),
        ]),
      );
    });
  });
});

describe("channel QR binding flows", () => {
  it("starts and confirms Weixin QR binding through launcher routes", async () => {
    // QR flow involves multiple async steps (external fetch mocks + QR data URI generation)
    // which can exceed the default 5s timeout on slower CI machines.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const targetURL =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (targetURL.startsWith("http://127.0.0.1:")) {
        return originalFetch(input, init);
      }
      if (targetURL.includes("/ilink/bot/get_bot_qrcode")) {
        return new Response(
          JSON.stringify({
            qrcode: "wx-qr-token",
            qrcode_img_content: "https://open.weixin.qq.com/qr/wx-qr-token",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (targetURL.includes("/ilink/bot/get_qrcode_status")) {
        return new Response(
          JSON.stringify({
            status: "confirmed",
            bot_token: "wx-bound-token",
            ilink_bot_id: "wx-bound-account",
            baseurl: "https://ilinkai.weixin.qq.com",
            ilink_user_id: "wx-user-id",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    try {
      await withLauncherCompatServer(async (request) => {
        const start = await request("/weixin/flows", { method: "POST" });
        const startBody = await start.json();
        expect(start.status).toBe(200);
        expect(startBody.flow_id).toMatch(/^wx_/);
        expect(startBody.status).toBe("wait");
        expect(startBody.qr_data_uri).toMatch(/^data:image\/png;base64,/);

        const poll = await request(`/weixin/flows/${startBody.flow_id}`);
        const pollBody = await poll.json();
        expect(poll.status).toBe(200);
        expect(pollBody.status).toBe("confirmed");
        expect(pollBody.account_id).toBe("wx-bound-account");

        const config = await request("/channels/weixin/config").then((res) =>
          res.json(),
        );
        expect(config.config.account_id).toBe("wx-bound-account");
        expect(config.config.token).toBeUndefined();
        expect(config.configured_secrets).toContain("token");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30000);

  it("starts and confirms WeCom QR binding through launcher routes", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const targetURL =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (targetURL.startsWith("http://127.0.0.1:")) {
        return originalFetch(input, init);
      }
      if (targetURL.startsWith("https://work.weixin.qq.com/ai/qc/generate")) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            data: {
              scode: "wecom-scode",
              auth_url: "https://work.weixin.qq.com/qr/wecom-scode",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (
        targetURL.startsWith("https://work.weixin.qq.com/ai/qc/query_result")
      ) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            data: {
              status: "success",
              bot_info: {
                botid: "ww-bound-bot",
                secret: "wecom-bound-secret",
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    try {
      await withLauncherCompatServer(async (request) => {
        const start = await request("/wecom/flows", { method: "POST" });
        const startBody = await start.json();
        expect(start.status).toBe(200);
        expect(startBody.flow_id).toMatch(/^wc_/);
        expect(startBody.status).toBe("wait");
        expect(startBody.qr_data_uri).toMatch(/^data:image\/png;base64,/);

        const poll = await request(`/wecom/flows/${startBody.flow_id}`);
        const pollBody = await poll.json();
        expect(poll.status).toBe(200);
        expect(pollBody.status).toBe("confirmed");
        expect(pollBody.bot_id).toBe("ww-bound-bot");

        const config = await request("/channels/wecom/config").then((res) =>
          res.json(),
        );
        expect(config.config.bot_id).toBe("ww-bound-bot");
        expect(config.config.secret).toBeUndefined();
        expect(config.configured_secrets).toContain("secret");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30000);
});

describe("channel runtime probe", () => {
  it("includes all configurable dashboard channels in the public catalog", () => {
    const channelNames = SUPPORTED_CHANNELS.map((channel) => channel.name);

    expect(channelNames).toEqual(
      expect.arrayContaining(["feishu", "dingtalk", "qq"]),
    );
    expect(
      SUPPORTED_CHANNELS.filter((channel) =>
        ["weixin", "wecom"].includes(channel.name),
      ).map((channel) => channel.runtime_status),
    ).toEqual(["partial", "partial"]);
    expect(channelNames).not.toEqual(
      expect.arrayContaining(["whatsapp_native", "maixcam"]),
    );
  });

  it("reports Telegram ready only when enabled and runtime token is available", () => {
    const probe = buildChannelRuntimeProbe({
      channel: {
        name: "telegram",
        display_name: "Telegram",
        config_key: "telegram",
        runtime_status: "functional",
      },
      config: { enabled: true, settings: { token: "saved-token" } },
      configuredSecrets: ["token"],
      env: { TELEGRAM_BOT_TOKEN: "runtime-token" },
    });

    expect(probe.probe_status).toBe("ready");
    expect(probe.agent_connected).toBe(true);
    expect(probe.missing_fields).toEqual([]);
    expect(probe.check_mode).toBe("mock");
    expect(probe.send_check?.status).toBe("passed");
  });

  it("keeps live channel send checks opt-in", () => {
    const probe = buildChannelRuntimeProbe({
      channel: {
        name: "telegram",
        display_name: "Telegram",
        config_key: "telegram",
        runtime_status: "functional",
      },
      config: { enabled: true, settings: { token: "saved-token" } },
      configuredSecrets: ["token"],
      env: {
        TELEGRAM_BOT_TOKEN: "runtime-token",
        Miki_CHANNEL_LIVE_PROBES: "true",
      },
    });

    expect(probe.check_mode).toBe("live");
    expect(probe.send_check?.status).toBe("skipped");
    expect(probe.send_check?.message).toContain("Miki_CHANNEL_ALLOW_LIVE_SEND");
  });

  it("reports Telegram disabled when startup is explicitly disabled", () => {
    const probe = buildChannelRuntimeProbe({
      channel: {
        name: "telegram",
        display_name: "Telegram",
        config_key: "telegram",
        runtime_status: "functional",
      },
      config: { enabled: true, settings: { token: "saved-token" } },
      configuredSecrets: ["token"],
      env: {
        TELEGRAM_BOT_TOKEN: "runtime-token",
        ENABLE_TELEGRAM: "false",
      },
    });

    expect(probe.probe_status).toBe("disabled");
    expect(probe.agent_connected).toBe(false);
  });

  it("reports miki ready without depending on a prior token-generation endpoint", () => {
    const probe = buildChannelRuntimeProbe({
      channel: {
        name: "miki",
        display_name: "miki",
        config_key: "miki",
        runtime_status: "functional",
      },
      config: {},
      env: {},
    });

    expect(probe.probe_status).toBe("ready");
    expect(probe.agent_connected).toBe(true);
    expect(probe.missing_fields).toEqual([]);
  });

  it("reports Feishu, DingTalk, and QQ ready after required config exists", () => {
    const feishu = buildChannelRuntimeProbe({
      channel: {
        name: "feishu",
        display_name: "Feishu / Lark",
        config_key: "feishu",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { app_id: "cli_a123", app_secret: "saved-secret" },
      },
      configuredSecrets: ["app_secret"],
      env: {},
    });
    const dingTalk = buildChannelRuntimeProbe({
      channel: {
        name: "dingtalk",
        display_name: "DingTalk",
        config_key: "dingtalk",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: {
          webhook_url:
            "https://oapi.dingtalk.com/robot/send?access_token=secret",
        },
      },
      env: {},
    });
    const qq = buildChannelRuntimeProbe({
      channel: {
        name: "qq",
        display_name: "QQ",
        config_key: "qq",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { bot_id: "1234567890", token: "saved-token" },
      },
      configuredSecrets: ["token"],
      env: {},
    });

    expect(feishu.probe_status).toBe("ready");
    expect(dingTalk.probe_status).toBe("ready");
    expect(qq.probe_status).toBe("ready");
  });

  it("reports Feishu, DingTalk, and QQ as needing config before required fields exist", () => {
    const probe = buildChannelRuntimeProbe({
      channel: {
        name: "feishu",
        display_name: "Feishu / Lark",
        config_key: "feishu",
        runtime_status: "functional",
      },
      config: {},
      env: {},
    });

    expect(probe.probe_status).toBe("needs_config");
    expect(probe.agent_connected).toBe(false);
    expect(probe.missing_fields).toEqual(["app_id", "app_secret"]);
    expect(
      probe.checks.find((check) => check.id === "runtime_adapter")?.status,
    ).toBe("pass");
  });

  it("validates newly functional channel field shapes before handoff", () => {
    const invalidFeishu = buildChannelRuntimeProbe({
      channel: {
        name: "feishu",
        display_name: "Feishu / Lark",
        config_key: "feishu",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { app_id: "bad app id", app_secret: "saved-secret" },
      },
      configuredSecrets: ["app_secret"],
      env: {},
    });
    const invalidDingTalk = buildChannelRuntimeProbe({
      channel: {
        name: "dingtalk",
        display_name: "DingTalk",
        config_key: "dingtalk",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: {
          webhook_url: "https://example.com/robot/send?access_token=secret",
        },
      },
      env: {},
    });
    const invalidQq = buildChannelRuntimeProbe({
      channel: {
        name: "qq",
        display_name: "QQ",
        config_key: "qq",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { bot_id: "abc", token: "saved-token" },
      },
      configuredSecrets: ["token"],
      env: {},
    });

    expect(invalidFeishu.probe_status).toBe("needs_config");
    expect(
      invalidFeishu.checks.find((check) => check.id === "app_id_shape")?.status,
    ).toBe("fail");
    expect(
      invalidDingTalk.checks.find(
        (check) => check.id === "webhook_url_endpoint",
      )?.status,
    ).toBe("fail");
    expect(
      invalidQq.checks.find((check) => check.id === "bot_id_shape")?.status,
    ).toBe("fail");
  });

  it("reports Discord ready only after required config exists", () => {
    const missing = buildChannelRuntimeProbe({
      channel: {
        name: "discord",
        display_name: "Discord",
        config_key: "discord",
        runtime_status: "functional",
      },
      config: {},
      env: {},
    });
    const configured = buildChannelRuntimeProbe({
      channel: {
        name: "discord",
        display_name: "Discord",
        config_key: "discord",
        runtime_status: "functional",
      },
      config: { enabled: true, settings: { token: "saved-token" } },
      configuredSecrets: ["token"],
      env: {},
    });

    expect(missing.probe_status).toBe("needs_config");
    expect(missing.missing_fields).toEqual(["token"]);
    expect(configured.probe_status).toBe("ready");
    expect(
      configured.checks.find((check) => check.id === "runtime_adapter")?.status,
    ).toBe("pass");
  });

  it("reports Slack ready only after bot and app tokens exist", () => {
    const missing = buildChannelRuntimeProbe({
      channel: {
        name: "slack",
        display_name: "Slack",
        config_key: "slack",
        runtime_status: "functional",
      },
      config: {},
      env: {},
    });
    const configured = buildChannelRuntimeProbe({
      channel: {
        name: "slack",
        display_name: "Slack",
        config_key: "slack",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: {
          bot_token: "saved-bot-token",
          app_token: "saved-app-token",
        },
      },
      configuredSecrets: ["bot_token", "app_token"],
      env: {},
    });

    expect(missing.probe_status).toBe("needs_config");
    expect(missing.missing_fields).toEqual(["bot_token", "app_token"]);
    expect(configured.probe_status).toBe("ready");
    expect(configured.missing_fields).toEqual([]);
    expect(
      configured.checks.find((check) => check.id === "runtime_adapter")?.status,
    ).toBe("pass");
  });

  it("reports LINE ready only after token and channel secret exist", () => {
    const missing = buildChannelRuntimeProbe({
      channel: {
        name: "line",
        display_name: "LINE",
        config_key: "line",
        runtime_status: "functional",
      },
      config: {},
      env: {},
    });
    const configured = buildChannelRuntimeProbe({
      channel: {
        name: "line",
        display_name: "LINE",
        config_key: "line",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: {
          token: "saved-token",
          channel_secret: "saved-channel-secret",
        },
      },
      configuredSecrets: ["token", "channel_secret"],
      env: {},
    });

    expect(missing.probe_status).toBe("needs_config");
    expect(missing.missing_fields).toEqual(["token", "channel_secret"]);
    expect(configured.probe_status).toBe("ready");
    expect(configured.missing_fields).toEqual([]);
  });

  it("filters Discord messages before handing them to the agent", () => {
    const runtimeConfig = resolveDiscordRuntimeConfig(
      {
        channels: {
          discord: {
            enabled: true,
            settings: {
              token: "saved-token",
              allow_from: ["channel-1"],
              group_trigger: { prefixes: ["!owl"] },
            },
          },
        },
      },
      {},
    );

    expect(runtimeConfig.enabled).toBe(true);
    expect(
      shouldHandleDiscordMessage(
        {
          id: "message-1",
          content: "<@bot-id> build this",
          channel_id: "channel-1",
          guild_id: "guild-1",
          author: { id: "user-1" },
          mentions: [{ id: "bot-id" }],
        },
        "bot-id",
        runtimeConfig,
      ),
    ).toBe(true);
    expect(
      shouldHandleDiscordMessage(
        {
          id: "message-2",
          content: "ignore this",
          channel_id: "channel-2",
          guild_id: "guild-1",
          author: { id: "user-1" },
          mentions: [],
        },
        "bot-id",
        runtimeConfig,
      ),
    ).toBe(false);
    expect(
      normalizeDiscordPrompt("<@bot-id> !owl build this", "bot-id", ["!owl"]),
    ).toBe("build this");
  });

  it("filters Slack events before handing them to the agent", () => {
    const runtimeConfig = resolveSlackRuntimeConfig(
      {
        channels: {
          slack: {
            enabled: true,
            settings: {
              bot_token: "saved-bot-token",
              app_token: "saved-app-token",
              allow_from: ["channel-1"],
            },
          },
        },
      },
      {},
    );

    expect(runtimeConfig.enabled).toBe(true);
    expect(
      shouldHandleSlackEvent(
        {
          type: "app_mention",
          text: "<@bot-id> build &lt;task&gt;",
          user: "user-1",
          channel: "channel-1",
          channel_type: "channel",
        },
        "bot-id",
        runtimeConfig,
      ),
    ).toBe(true);
    expect(
      shouldHandleSlackEvent(
        {
          type: "message",
          text: "<@bot-id> ignore this",
          user: "user-1",
          channel: "channel-2",
          channel_type: "channel",
        },
        "bot-id",
        runtimeConfig,
      ),
    ).toBe(false);
    expect(normalizeSlackPrompt("<@bot-id> build &lt;task&gt;", "bot-id")).toBe(
      "build <task>",
    );
  });

  it("verifies and filters LINE webhook events before handing them to the agent", () => {
    const runtimeConfig = resolveLineRuntimeConfig(
      {
        channels: {
          line: {
            enabled: true,
            settings: {
              token: "saved-token",
              channel_secret: "secret",
              allow_from: ["user-1"],
            },
          },
        },
      },
      {},
    );
    const body = Buffer.from(
      JSON.stringify({ events: [{ type: "message" }] }),
      "utf-8",
    );
    const signature = crypto
      .createHmac("sha256", "secret")
      .update(body)
      .digest("base64");

    expect(runtimeConfig.enabled).toBe(true);
    expect(verifyLineSignature(body, "secret", signature)).toBe(true);
    expect(
      shouldHandleLineEvent(
        {
          type: "message",
          replyToken: "reply-token",
          message: { type: "text", text: "build this" },
          source: { type: "user", userId: "user-1" },
        },
        runtimeConfig,
      ),
    ).toBe(true);
    expect(
      shouldHandleLineEvent(
        {
          type: "message",
          replyToken: "reply-token",
          message: { type: "text", text: "ignore this" },
          source: { type: "user", userId: "user-2" },
        },
        runtimeConfig,
      ),
    ).toBe(false);
  });

  it("verifies and filters DingTalk webhook events before handing them to the agent", () => {
    const runtimeConfig = resolveDingTalkRuntimeConfig(
      {
        channels: {
          dingtalk: {
            enabled: true,
            settings: {
              webhook_url:
                "https://oapi.dingtalk.com/robot/send?access_token=token",
              client_secret: "SEC-secret",
              allow_from: ["conversation:cid-1", "staff:staff-1"],
            },
          },
        },
      },
      {},
    );
    const timestamp = "1710000000000";
    const signature = crypto
      .createHmac("sha256", "SEC-secret")
      .update(`${timestamp}\nSEC-secret`)
      .digest("base64");
    const event = parseDingTalkWebhookEvent({
      conversationId: "cid-1",
      senderId: "sender-1",
      senderStaffId: "staff-1",
      text: { content: "inspect this" },
      msgId: "msg-1",
    });
    const ignored = parseDingTalkWebhookEvent({
      conversationId: "cid-2",
      senderId: "sender-2",
      text: { content: "ignore this" },
    });

    expect(runtimeConfig.enabled).toBe(true);
    expect(verifyDingTalkSignature(timestamp, signature, "SEC-secret")).toBe(
      true,
    );
    expect(
      signDingTalkWebhookUrl(runtimeConfig.webhookUrl, "SEC-secret", 1),
    ).toContain("timestamp=1");
    expect(event && shouldHandleDingTalkEvent(event, runtimeConfig)).toBe(true);
    expect(ignored && shouldHandleDingTalkEvent(ignored, runtimeConfig)).toBe(
      false,
    );
    expect(event && dingTalkSessionId(event)).toBe("dingtalk_cid-1_sender-1");
  });

  it("verifies and filters Feishu webhook events before handing them to the agent", () => {
    const runtimeConfig = resolveFeishuRuntimeConfig(
      {
        channels: {
          feishu: {
            enabled: true,
            settings: {
              app_id: "cli_a123",
              app_secret: "saved-secret",
              verification_token: "verify-token",
              allow_from: ["chat:oc_chat"],
              group_trigger: { mention_only: true, prefixes: ["/owl"] },
            },
          },
        },
      },
      {},
    );
    const body = {
      token: "verify-token",
      schema: "2.0",
      header: { event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_user" } },
        message: {
          message_id: "om_msg",
          chat_id: "oc_chat",
          content: JSON.stringify({ text: '<at id="bot"></at> /owl inspect' }),
          mentions: [{ id: { open_id: "ou_bot" } }],
        },
      },
    };
    const event = parseFeishuWebhookEvent(body);
    const ignored = parseFeishuWebhookEvent({
      ...body,
      event: {
        ...body.event,
        message: {
          ...body.event.message,
          chat_id: "oc_other",
          content: JSON.stringify({ text: "inspect" }),
          mentions: [],
        },
      },
    });

    expect(runtimeConfig.enabled).toBe(true);
    expect(verifyFeishuToken(body, runtimeConfig.verificationToken)).toBe(true);
    expect(
      feishuChallengeResponse({
        token: "verify-token",
        type: "url_verification",
        challenge: "challenge-token",
      }),
    ).toEqual({ challenge: "challenge-token" });
    expect(event && shouldHandleFeishuEvent(event, runtimeConfig)).toBe(true);
    expect(ignored && shouldHandleFeishuEvent(ignored, runtimeConfig)).toBe(
      false,
    );
    expect(
      normalizeFeishuPrompt('<at id="bot"></at> /owl inspect', ["/owl"]),
    ).toBe("inspect");
    expect(event && feishuSessionId(event)).toBe("feishu_oc_chat_ou_user");
  });

  it("filters and normalizes QQ webhook events before handing them to the agent", () => {
    const runtimeConfig = resolveQqRuntimeConfig(
      {
        channels: {
          qq: {
            enabled: true,
            settings: {
              bot_id: "1234567890",
              token: "saved-token",
              allow_from: ["group:9001", "user:42"],
              group_trigger: { mention_only: true, prefixes: ["/owl"] },
            },
          },
        },
      },
      {},
    );
    const event = parseQqWebhookEvent({
      group_id: "9001",
      user_id: "42",
      id: "msg-1",
      content: "<@1234567890> /owl inspect this",
    });
    const ignored = parseQqWebhookEvent({
      group_id: "9002",
      user_id: "42",
      content: "inspect this",
    });

    expect(runtimeConfig.enabled).toBe(true);
    expect(event && shouldHandleQqEvent(event, runtimeConfig)).toBe(true);
    expect(ignored && shouldHandleQqEvent(ignored, runtimeConfig)).toBe(false);
    expect(
      normalizeQqPrompt("<@1234567890> /owl inspect this", "1234567890", [
        "/owl",
      ]),
    ).toBe("inspect this");
    expect(event && qqSessionId(event)).toBe("qq_9001_9001_42");
  });

  it("uses the saved form field names for channel validation", () => {
    const onebotProbe = buildChannelRuntimeProbe({
      channel: {
        name: "onebot",
        display_name: "OneBot",
        config_key: "onebot",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { server_url: "http://localhost:5700" },
      },
      env: {},
    });
    const matrixProbe = buildChannelRuntimeProbe({
      channel: {
        name: "matrix",
        display_name: "Matrix",
        config_key: "matrix",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: {
          homeserver_url: "https://matrix.org",
          user_id: "@bot:matrix.org",
          access_token: "token",
        },
      },
      configuredSecrets: ["access_token"],
      env: {},
    });

    expect(onebotProbe.missing_fields).toEqual([]);
    expect(matrixProbe.missing_fields).toEqual([]);
  });

  it("rejects invalid channel endpoint shapes before reporting ready", () => {
    const whatsappProbe = buildChannelRuntimeProbe({
      channel: {
        name: "whatsapp",
        display_name: "WhatsApp",
        config_key: "whatsapp",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { bridge_url: "ftp://bridge.example.com/send" },
      },
      env: {},
    });
    const matrixProbe = buildChannelRuntimeProbe({
      channel: {
        name: "matrix",
        display_name: "Matrix",
        config_key: "matrix",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: {
          homeserver_url: "matrix.org",
          user_id: "bot:matrix.org",
          access_token: "token",
        },
      },
      configuredSecrets: ["access_token"],
      env: {},
    });
    const onebotProbe = buildChannelRuntimeProbe({
      channel: {
        name: "onebot",
        display_name: "OneBot",
        config_key: "onebot",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { server_url: "localhost:5700" },
      },
      env: {},
    });

    expect(whatsappProbe.probe_status).toBe("needs_config");
    expect(
      whatsappProbe.checks.find((check) => check.id === "bridge_url_shape")
        ?.status,
    ).toBe("fail");
    expect(matrixProbe.probe_status).toBe("needs_config");
    expect(
      matrixProbe.checks.find((check) => check.id === "homeserver_url_shape")
        ?.status,
    ).toBe("fail");
    expect(
      matrixProbe.checks.find((check) => check.id === "user_id_shape")?.status,
    ).toBe("fail");
    expect(onebotProbe.probe_status).toBe("needs_config");
    expect(
      onebotProbe.checks.find((check) => check.id === "server_url_shape")
        ?.status,
    ).toBe("fail");
  });

  it("reports OneBot ready after server URL exists", () => {
    const missing = buildChannelRuntimeProbe({
      channel: {
        name: "onebot",
        display_name: "OneBot",
        config_key: "onebot",
        runtime_status: "functional",
      },
      config: {},
      env: {},
    });
    const configured = buildChannelRuntimeProbe({
      channel: {
        name: "onebot",
        display_name: "OneBot",
        config_key: "onebot",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { server_url: "ws://127.0.0.1:5700", bot_id: "10001" },
      },
      env: {},
    });

    expect(missing.probe_status).toBe("needs_config");
    expect(missing.missing_fields).toEqual(["server_url"]);
    expect(configured.probe_status).toBe("ready");
    expect(configured.missing_fields).toEqual([]);
  });

  it("filters and normalizes OneBot messages before handing them to the agent", () => {
    const runtimeConfig = resolveOneBotRuntimeConfig(
      {
        channels: {
          onebot: {
            enabled: true,
            settings: {
              server_url: "ws://127.0.0.1:5700",
              bot_id: "10001",
              allow_from: ["group:9001", "user:42"],
              group_trigger: { prefixes: ["!owl"] },
            },
          },
        },
      },
      {},
    );

    expect(runtimeConfig.enabled).toBe(true);
    const groupMention = {
      post_type: "message",
      message_type: "group",
      self_id: 10001,
      group_id: 9001,
      user_id: 42,
      raw_message: "[CQ:at,qq=10001] inspect this",
    } as const;
    const groupIgnored = {
      post_type: "message",
      message_type: "group",
      self_id: 10001,
      group_id: 9001,
      user_id: 42,
      raw_message: "inspect this",
    } as const;
    const privateMessage = {
      post_type: "message",
      message_type: "private",
      self_id: 10001,
      user_id: 42,
      raw_message: "!owl inspect this",
    } as const;

    expect(shouldHandleOneBotEvent(groupMention, runtimeConfig)).toBe(true);
    expect(shouldHandleOneBotEvent(groupIgnored, runtimeConfig)).toBe(false);
    expect(shouldHandleOneBotEvent(privateMessage, runtimeConfig)).toBe(true);
    expect(normalizeOneBotPrompt(groupMention, runtimeConfig)).toBe(
      "inspect this",
    );
    expect(normalizeOneBotPrompt(privateMessage, runtimeConfig)).toBe(
      "inspect this",
    );
  });

  it("reports MQTT ready after broker and agent id exist", () => {
    const missing = buildChannelRuntimeProbe({
      channel: {
        name: "mqtt",
        display_name: "MQTT",
        config_key: "mqtt",
        runtime_status: "functional",
      },
      config: {},
      env: {},
    });
    const configured = buildChannelRuntimeProbe({
      channel: {
        name: "mqtt",
        display_name: "MQTT",
        config_key: "mqtt",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { broker: "mqtt://127.0.0.1:1883", agent_id: "miki" },
      },
      env: {},
    });

    expect(missing.probe_status).toBe("needs_config");
    expect(missing.missing_fields).toEqual(["broker", "agent_id"]);
    expect(configured.probe_status).toBe("ready");
    expect(configured.missing_fields).toEqual([]);
  });

  it("maps MQTT request topics and payloads before handing them to the agent", () => {
    const runtimeConfig = resolveMqttRuntimeConfig(
      {
        channels: {
          mqtt: {
            enabled: true,
            settings: {
              broker: "mqtt://127.0.0.1:1883",
              agent_id: "miki",
              topic_prefix: "/Miki",
              qos: 1,
            },
          },
        },
      },
      {},
    );
    const packet = buildMqttPublishPacket(
      "/Miki/miki/device-1/request",
      Buffer.from(JSON.stringify({ text: "inspect sensors" }), "utf-8"),
    );
    const parsed = parseMqttPackets(packet);
    const publish = parseMqttPublishPacket(parsed.packets[0]);

    expect(runtimeConfig.enabled).toBe(true);
    expect(runtimeConfig.qos).toBe(1);
    expect(mqttRequestInfo(publish.topic, runtimeConfig)).toEqual({
      clientId: "device-1",
      responseTopic: "/Miki/miki/device-1/response",
    });
    expect(parseMqttRequestPayload(publish.payload)).toBe("inspect sensors");
    expect(parseMqttPackets(parsed.remaining).packets).toEqual([]);
  });

  it("reports WhatsApp ready after bridge URL exists", () => {
    const missing = buildChannelRuntimeProbe({
      channel: {
        name: "whatsapp",
        display_name: "WhatsApp",
        config_key: "whatsapp",
        runtime_status: "functional",
      },
      config: {},
      env: {},
    });
    const configured = buildChannelRuntimeProbe({
      channel: {
        name: "whatsapp",
        display_name: "WhatsApp",
        config_key: "whatsapp",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { bridge_url: "https://bridge.example.com/send" },
      },
      env: {},
    });

    expect(missing.probe_status).toBe("needs_config");
    expect(missing.missing_fields).toEqual(["bridge_url"]);
    expect(configured.probe_status).toBe("ready");
    expect(configured.missing_fields).toEqual([]);
  });

  it("filters WhatsApp bridge events before handing them to the agent", () => {
    const runtimeConfig = resolveWhatsAppBridgeRuntimeConfig(
      {
        channels: {
          whatsapp: {
            enabled: true,
            settings: {
              bridge_url: "https://bridge.example.com/send",
              webhook_token: "secret",
              allow_from: ["chat:120363000000000000@g.us", "sender:8801"],
            },
          },
        },
      },
      {},
    );
    const event = parseWhatsAppBridgeEvent({
      message: {
        key: { remoteJid: "120363000000000000@g.us", id: "msg-1" },
        message: { conversation: "inspect this" },
      },
      sender_id: "8801",
    });
    const ignored = parseWhatsAppBridgeEvent({
      from: "120363999999999999@g.us",
      sender_id: "9999",
      text: "ignore this",
    });
    const ownMessage = parseWhatsAppBridgeEvent({
      from: "120363000000000000@g.us",
      text: "ignore own message",
      fromMe: true,
    });

    expect(runtimeConfig.enabled).toBe(true);
    expect(runtimeConfig.webhookToken).toBe("secret");
    expect(event?.text).toBe("inspect this");
    expect(event && shouldHandleWhatsAppBridgeEvent(event, runtimeConfig)).toBe(
      true,
    );
    expect(
      ignored && shouldHandleWhatsAppBridgeEvent(ignored, runtimeConfig),
    ).toBe(false);
    expect(
      ownMessage && shouldHandleWhatsAppBridgeEvent(ownMessage, runtimeConfig),
    ).toBe(false);
    expect(event && whatsappSessionId(event)).toBe(
      "whatsapp_120363000000000000@g.us_8801",
    );
  });

  it("reports IRC ready after server and nick exist", () => {
    const missing = buildChannelRuntimeProbe({
      channel: {
        name: "irc",
        display_name: "IRC",
        config_key: "irc",
        runtime_status: "functional",
      },
      config: {},
      env: {},
    });
    const configured = buildChannelRuntimeProbe({
      channel: {
        name: "irc",
        display_name: "IRC",
        config_key: "irc",
        runtime_status: "functional",
      },
      config: {
        enabled: true,
        settings: { server: "irc.libera.chat", nick: "Miki" },
      },
      env: {},
    });

    expect(missing.probe_status).toBe("needs_config");
    expect(missing.missing_fields).toEqual(["server", "nick"]);
    expect(configured.probe_status).toBe("ready");
    expect(configured.missing_fields).toEqual([]);
  });

  it("filters and normalizes IRC messages before handing them to the agent", () => {
    const runtimeConfig = resolveIrcRuntimeConfig(
      {
        channels: {
          irc: {
            enabled: true,
            settings: {
              server: "irc.libera.chat",
              nick: "Miki",
              channels: "#ops",
              allow_from: ["#ops", "alice"],
              group_trigger: { prefixes: ["!owl"] },
            },
          },
        },
      },
      {},
    );

    expect(runtimeConfig.enabled).toBe(true);
    const channelMention = parseIrcLine(
      ":alice!u@host PRIVMSG #ops :Miki: inspect this",
    );
    const channelIgnored = parseIrcLine(
      ":mallory!u@host PRIVMSG #ops :inspect this",
    );
    const dm = parseIrcLine(":alice!u@host PRIVMSG Miki :inspect this");

    expect(shouldHandleIrcMessage(channelMention, runtimeConfig)).toBe(true);
    expect(shouldHandleIrcMessage(channelIgnored, runtimeConfig)).toBe(false);
    expect(shouldHandleIrcMessage(dm, runtimeConfig)).toBe(true);
    expect(
      normalizeIrcPrompt("Miki: !owl inspect this", "Miki", ["!owl"]),
    ).toBe("inspect this");
  });
});

describe("gateway log clear (#123)", () => {
  it("reports cleared and truncates the log file when it exists", async () => {
    await withLauncherCompatServer(async (request, workspaceDir) => {
      const dataDir = normalizeRuntimePaths(workspaceDir).dataDir;
      fs.mkdirSync(dataDir, { recursive: true });
      const logPath = path.join(dataDir, "core_backend.log");
      fs.writeFileSync(logPath, "old log line 1\nold log line 2\n", "utf-8");

      const response = await request("/gateway/logs/clear", {
        method: "POST",
      });
      const body = (await response.json()) as {
        status: string;
        files: Record<string, { ok: boolean }>;
      };

      expect(response.status).toBe(200);
      expect(body.status).toBe("cleared");
      expect(body.files["core_backend.log"]).toEqual({ ok: true });
      expect(fs.readFileSync(logPath, "utf-8")).toBe("");
    });
  });

  it("reports skipped (not cleared) with 200 when the log file does not exist", async () => {
    await withLauncherCompatServer(async (request, workspaceDir) => {
      const dataDir = normalizeRuntimePaths(workspaceDir).dataDir;
      const logPath = path.join(dataDir, "core_backend.log");
      expect(fs.existsSync(logPath)).toBe(false);

      const response = await request("/gateway/logs/clear", {
        method: "POST",
      });
      const body = (await response.json()) as {
        status: string;
        missing_files: string[];
      };

      expect(response.status).toBe(200);
      expect(body.status).toBe("skipped");
      expect(body.missing_files).toContain("core_backend.log");
    });
  });

  it("reports partial_failure with a non-2xx status when the log file cannot be truncated", async () => {
    await withLauncherCompatServer(async (request, workspaceDir) => {
      const dataDir = normalizeRuntimePaths(workspaceDir).dataDir;
      fs.mkdirSync(dataDir, { recursive: true });
      const logPath = path.join(dataDir, "core_backend.log");
      // Replace the log path with a directory so fs.writeFileSync(logPath, "")
      // fails (EISDIR), simulating a locked/permission-denied/failing write
      // without relying on platform-specific permission semantics.
      fs.mkdirSync(logPath);

      const response = await request("/gateway/logs/clear", {
        method: "POST",
      });
      const body = (await response.json()) as {
        status: string;
        files: Record<string, { ok: boolean; error?: string }>;
      };

      expect(response.ok).toBe(false);
      expect(body.status).toBe("partial_failure");
      expect(body.files["core_backend.log"].ok).toBe(false);
    });
  });
});

describe("Google provider model discovery", () => {
  it("uses the native models endpoint for the OpenAI-compatible Gemini base", async () => {
    const originalFetch = global.fetch;
    const calls: Array<{ url: string; headers: Headers }> = [];
    global.fetch = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith("http://127.0.0.1:")) {
        return originalFetch(input, init);
      }
      calls.push({ url: request.url, headers: request.headers });
      if (request.url.endsWith("/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "READY" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          models: [{ name: "models/gemini-2.5-flash" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      await withLauncherCompatServer(async (request) => {
        const response = await request("/models/test-inline", {
          method: "POST",
          body: JSON.stringify({
            provider: "google",
            model: "gemini-2.5-flash",
            api_key: "google-test-key",
          }),
        });
        const body = (await response.json()) as {
          success: boolean;
          status: string;
        };

        expect(response.status).toBe(200);
        expect(body).toEqual(
          expect.objectContaining({
            success: true,
            status: "ready",
            readiness_status: "ready",
            verification_level: "completion",
            completion_tested: true,
            provider: "gemini",
          }),
        );
        expect(calls).toHaveLength(2);
        expect(calls[0]?.url).toBe(
          "https://generativelanguage.googleapis.com/v1beta/models",
        );
        expect(calls[0]?.headers.get("x-goog-api-key")).toBe("google-test-key");
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("provider tool readiness", () => {
  it("reports agent_ready only after the tool dry run and final continuation succeed", async () => {
    const complete = jest.spyOn(openAICompatibleAdapter, "complete");
    complete
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "probe-call-1",
                  type: "function",
                  function: {
                    name: "miki_agent_readiness_probe",
                    arguments: '{"marker":"agent-ready"}',
                  },
                },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: "Dry run complete." } }],
      } as never);
    try {
      await withLauncherCompatServer(async (request) => {
        const response = await request("/models/test-tools-inline", {
          method: "POST",
          body: JSON.stringify({
            provider: "opencode",
            model: "opencode/mimo-v2.5-free",
            api_key: "test-opencode-key",
          }),
        });
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body).toEqual(
          expect.objectContaining({
            success: true,
            status: "agent_ready",
            readiness_status: "agent_ready",
            verification_level: "tools",
            tools_tested: true,
            dry_run_executed: true,
            final_response_received: true,
            provider: "opencode",
          }),
        );
        expect(complete).toHaveBeenCalledTimes(2);
      });
    } finally {
      complete.mockRestore();
    }
  });
});
