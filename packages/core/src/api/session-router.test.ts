import express from "express";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  clearSessionPermissions,
  getToolPermissionDecision,
  recordToolPermissionDenial,
  setSessionPermissions,
} from "../mcp/permissions/session-permissions.js";
import { createSessionRouter } from "./session-router.js";

async function startSessionRouter() {
  const app = express();
  app.use(express.json());
  app.use("/sessions", createSessionRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    request: (path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${path}`, init),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe("session router permissions", () => {
  afterEach(() => clearSessionPermissions());

  it("exposes denied-call history with redacted args", async () => {
    const server = await startSessionRouter();
    try {
      setSessionPermissions("s1", { shell_execute: false });
      const decision = getToolPermissionDecision("s1", "shell_execute");
      recordToolPermissionDenial("s1", decision, {
        actor: "mcp",
        requestId: "req-denied",
        args: {
          cmd: "node -v",
          token: "sk-session-router-denial-secret",
        },
      });

      const response = await server.request("/sessions/s1/permissions");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        permissions: Record<string, boolean>;
        denials: Array<Record<string, unknown>>;
        state: { denials: Array<Record<string, unknown>> };
      };

      expect(body.permissions).toEqual({ shell_execute: false });
      expect(body.denials).toHaveLength(1);
      expect(body.denials[0]).toMatchObject({
        toolName: "shell_execute",
        actor: "mcp",
        requestId: "req-denied",
        source: "session",
      });
      expect(body.denials[0].argsPreview).toEqual({
        cmd: "node -v",
        token: "[REDACTED]",
      });
      expect(body.state.denials).toEqual(body.denials);
    } finally {
      await server.close();
    }
  });
});
