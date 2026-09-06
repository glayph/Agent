import {
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
    ).toBe("github_server__pull_request_list");
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
