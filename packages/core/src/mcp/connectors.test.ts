import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ExternalMcpConnectorManager,
  classifyExternalMcpToolSafety,
  executeMcpToolWithReconnect,
  isExternalMcpToolExecutionAllowed,
  namespaceExternalMcpToolName,
  resolveMcpHeaders,
} from "./connectors.js";
import type { McpServerConfig } from "./types.js";

const server = (allowSideEffects?: boolean): McpServerConfig => ({
  name: "test-server",
  enabled: true,
  type: "stdio",
  command: "test-server",
  ...(allowSideEffects === undefined ? {} : { allowSideEffects }),
});

describe("External MCP connectors", () => {
  test("namespaces external tool names safely", () => {
    expect(
      namespaceExternalMcpToolName("github server", "pull/request.list"),
    ).toMatch(/^github_server__pull_request_list_[a-f0-9]{12}$/);
  });

  test("prevents distinct MCP names from colliding after namespace sanitization", () => {
    const slash = namespaceExternalMcpToolName("server", "a/b");
    const underscore = namespaceExternalMcpToolName("server", "a_b");
    expect(slash).not.toBe(underscore);
    expect(slash).toMatch(/^server__a_b_[a-f0-9]{12}$/);
    expect(underscore).toMatch(/^server__a_b_[a-f0-9]{12}$/);
    expect(namespaceExternalMcpToolName("a b", "tool")).not.toBe(
      namespaceExternalMcpToolName("a_b", "tool"),
    );
    expect(slash.length).toBeLessThanOrEqual(64);
  });

  test("respects readOnlyHint precedence over hints meaningful only for mutable tools", () => {
    expect(classifyExternalMcpToolSafety({ readOnlyHint: true, idempotentHint: true })).toBe("read_only");
    expect(classifyExternalMcpToolSafety({ readOnlyHint: true, destructiveHint: true })).toBe("read_only");
    expect(classifyExternalMcpToolSafety({ readOnlyHint: false, idempotentHint: true })).toBe("side_effect");
    expect(classifyExternalMcpToolSafety({ readOnlyHint: false, destructiveHint: false })).toBe("side_effect");
    expect(classifyExternalMcpToolSafety({})).toBe("unknown");
  });

  test("allows explicitly read-only tools without enabling side effects", () => {
    expect(isExternalMcpToolExecutionAllowed(server(), "read_only")).toBe(true);
    expect(isExternalMcpToolExecutionAllowed(server(), "unknown")).toBe(false);
  });

  test("requires an explicit server opt-in for side-effect tools", () => {
    expect(isExternalMcpToolExecutionAllowed(server(), "side_effect")).toBe(
      false,
    );
    expect(isExternalMcpToolExecutionAllowed(server(true), "side_effect")).toBe(
      true,
    );
  });

  test("no-confirm mode never bypasses the server-side side-effect policy", () => {
    expect(isExternalMcpToolExecutionAllowed(server(), "side_effect", true)).toBe(false);
    expect(isExternalMcpToolExecutionAllowed(server(true), "side_effect", true)).toBe(true);
    expect(isExternalMcpToolExecutionAllowed(server(), "unknown", true)).toBe(false);
    expect(isExternalMcpToolExecutionAllowed(server(), "unknown", false)).toBe(false);
  });

  test("reports a missing MCP executable distinctly from a network outage", async () => {
    const root = mkdtempSync(path.join(process.cwd(), ".mcp-missing-command-test-"));
    const manager = new ExternalMcpConnectorManager(root, {
      enabled: true,
      discovery: { enabled: false, ttl: 60, maxSearchResults: 10, useBM25: false, useRegex: false },
      servers: {
        missing: { name: "missing", enabled: true, type: "stdio", command: "miki-command-that-does-not-exist" },
      },
    });
    try {
      const snapshot = await manager.listCatalogEntriesDetailed(true);
      expect(snapshot.failures).toEqual([
        expect.objectContaining({ serverName: "missing", message: expect.stringContaining("command was not found") }),
      ]);
    } finally {
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reconnects and retries a read-only call once", async () => {
    let attempts = 0;
    let reconnects = 0;
    await expect(
      executeMcpToolWithReconnect(
        "read_only",
        async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("ECONNRESET");
          return "ok";
        },
        async () => {
          reconnects += 1;
        },
      ),
    ).resolves.toBe("ok");
    expect(attempts).toBe(2);
    expect(reconnects).toBe(1);
  });

  test("does not retry a side-effect call after an uncertain failure", async () => {
    let attempts = 0;
    let reconnects = 0;
    await expect(
      executeMcpToolWithReconnect(
        "side_effect",
        async () => {
          attempts += 1;
          throw new Error("ECONNRESET");
        },
        async () => {
          reconnects += 1;
        },
      ),
    ).rejects.toThrow("automatic retry is blocked");
    expect(attempts).toBe(1);
    expect(reconnects).toBe(1);
  });

  test("retains the last-known-good catalog during a transient MCP server outage", async () => {
    const root = mkdtempSync(path.join(process.cwd(), ".mcp-catalog-test-"));
    const script = path.join(root, "server.mjs");
    writeFileSync(script, `
      import { Server } from "@modelcontextprotocol/sdk/server/index.js";
      import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
      import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
      const server = new Server({ name: "catalog-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "read_status", description: "Read fixture status", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
      await server.connect(new StdioServerTransport());
    `);
    const config = (command: string): import("./types.js").McpRuntimeConfig => ({
      enabled: true,
      discovery: { enabled: false, ttl: 60, maxSearchResults: 10, useBM25: false, useRegex: false },
      servers: { fixture: { name: "fixture", enabled: true, type: "stdio", command, args: command === process.execPath ? [script] : [] } },
    });
    const manager = new ExternalMcpConnectorManager(root, config(process.execPath));
    try {
      const first = await manager.listCatalogEntriesDetailed(true);
      const fixtureToolName = namespaceExternalMcpToolName("fixture", "read_status");
      expect(first.entries.map((entry) => entry.name)).toContain(fixtureToolName);
      expect(first.failures).toHaveLength(0);

      manager.updateConfig(config("miki-missing-mcp-server-binary"));
      const outage = await manager.listCatalogEntriesDetailed(true);
      expect(outage.failures).toEqual([expect.objectContaining({ serverName: "fixture" })]);
      expect(outage.entries.map((entry) => entry.name)).toContain(fixtureToolName);
      await expect(manager.callTool(fixtureToolName, {})).rejects.not.toThrow(/Unknown external MCP tool/i);
      manager.updateConfig({
        ...config("miki-missing-mcp-server-binary"),
        servers: { fixture: { name: "fixture", enabled: false, type: "stdio", command: "miki-missing-mcp-server-binary" } },
      });
      await expect(manager.callTool(fixtureToolName, {})).rejects.toThrow(/server .* is disabled/i);
      manager.updateConfig({
        ...config(process.execPath),
        enabled: false,
      });
      await expect(manager.callTool(fixtureToolName, {})).rejects.toThrow(/global MCP configuration/i);
    } finally {
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves authentication headers from environment references", () => {
    const headers = resolveMcpHeaders(
      {
        ...server(),
        headers: { "X-Static": "value" },
        headerEnv: { Authorization: "MCP_TEST_AUTH" },
      },
      { MCP_TEST_AUTH: "Bearer test-only" },
    );
    expect(headers).toEqual({
      "X-Static": "value",
      Authorization: "Bearer test-only",
    });
  });
});
