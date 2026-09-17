import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  cachedCoreApi,
  fetchCachedResource,
  MCP_RESOURCE_TTL,
} from "./core-client.js";

export function registerMcpResources(server: McpServer): void {
  server.resource(
    "Sessions",
    "session://list",
    {
      description: "List all agent sessions and message history",
      mimeType: "application/json",
    },
    (uri) =>
      fetchCachedResource(
        "session://list",
        "/history",
        MCP_RESOURCE_TTL.SESSIONS,
        uri,
      ),
  );

  server.resource(
    "Agent Configuration",
    "config://agent",
    {
      description: "Current agent configuration and persona settings",
      mimeType: "application/json",
    },
    (uri) =>
      fetchCachedResource(
        "config://agent",
        "/config",
        MCP_RESOURCE_TTL.CONFIG,
        uri,
      ),
  );

  server.resource(
    "System Health",
    "status://health",
    {
      description: "Agent and system health status (near real-time)",
      mimeType: "application/json",
    },
    (uri) =>
      fetchCachedResource(
        "status://health",
        "/health",
        MCP_RESOURCE_TTL.HEALTH,
        uri,
      ),
  );

  server.resource(
    "Task Queue",
    "memory://tasks",
    {
      description: "Scheduled and pending agent tasks",
      mimeType: "application/json",
    },
    (uri) =>
      fetchCachedResource(
        "memory://tasks",
        "/tasks",
        MCP_RESOURCE_TTL.TASKS,
        uri,
      ),
  );

  server.resource(
    "Heartbeat Logs",
    "heartbeat://logs",
    {
      description: "Live agent heartbeat telemetry and background pulse data",
      mimeType: "application/json",
    },
    (uri) =>
      fetchCachedResource(
        "heartbeat://logs",
        "/heartbeat/log",
        MCP_RESOURCE_TTL.HEARTBEAT,
        uri,
      ),
  );

  server.resource(
    "Self-Improvement Status",
    "improvement://status",
    {
      description:
        "Agent self-improvement engine status - reflections, optimizations, tunings",
      mimeType: "application/json",
    },
    (uri) =>
      fetchCachedResource(
        "improvement://status",
        "/improvement/status",
        MCP_RESOURCE_TTL.IMPROVEMENT,
        uri,
      ),
  );

  server.resource(
    "System Metrics",
    "metrics://system",
    {
      description: "Real-time CPU, memory, and process resource usage",
      mimeType: "application/json",
    },
    (uri) =>
      fetchCachedResource(
        "metrics://system",
        "/metrics",
        MCP_RESOURCE_TTL.METRICS,
        uri,
      ),
  );

  server.registerResource(
    "Models",
    new ResourceTemplate("models://{provider}", {
      list: async () => {
        const data = await cachedCoreApi<{ models: { available: string[] } }>(
          "models://list",
          "/models",
          MCP_RESOURCE_TTL.MODELS,
        );
        return {
          resources: data.models.available.map((model) => ({
            uri: `models://${model}`,
            name: model,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        provider: async (value: string) => {
          const data = await cachedCoreApi<{ models: { available: string[] } }>(
            "models://list",
            "/models",
            MCP_RESOURCE_TTL.MODELS,
          );
          return data.models.available.filter((model) => model.includes(value));
        },
      },
    }),
    {
      description: "Available LLM models by provider",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const data = await cachedCoreApi<{
        models: { available: string[]; active_model: string };
      }>("models://list", "/models", MCP_RESOURCE_TTL.MODELS);
      const provider = Array.isArray(variables.provider)
        ? variables.provider[0]
        : variables.provider;
      const filtered = data.models.available.filter((model) =>
        model.includes(provider),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { models: filtered, active: data.models.active_model },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
