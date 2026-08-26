import type { Express, Request, Response } from "express";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpSessionStorage } from "./context.js";
import { createMcpServer } from "./server.js";
import type { McpToolExecutor } from "./types.js";
import { getErrorMessage } from "../errors.js";

export type McpSession = Awaited<ReturnType<typeof createMcpServer>>;
type McpHandleRequest = McpSession["transport"]["handleRequest"];

export function mountMcpSessionManager(
  app: Express,
  options: {
    executeTool?: McpToolExecutor;
    workspaceDir?: string;
    path?: string;
  },
): () => Promise<void> {
  const sessions = new Map<string, McpSession>();
  const mcpPath = options.path || "/mcp";

  const createSession = async () => {
    const session = await createMcpServer(options.executeTool, {
      workspaceDir: options.workspaceDir,
    });
    session.transport.onclose = () => {
      const sessionId = session.transport.sessionId;
      if (sessionId) sessions.delete(sessionId);
      void session.close().catch((err: unknown) => {
        console.warn(
          `MCP session close failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    };
    return session;
  };

  app.all(mcpPath, async (req: Request, res: Response) => {
    const sessionHeader =
      req.headers["mcp-session-id"] || req.headers["x-session-id"];
    const mcpSessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    let session: McpSession | undefined;

    if (mcpSessionId) {
      session = sessions.get(mcpSessionId);
      if (!session) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "MCP session not found" },
          id: null,
        });
        return;
      }
    } else if (req.method === "POST" && isInitializeRequest(req.body)) {
      session = await createSession();
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid MCP session ID provided",
        },
        id: null,
      });
      return;
    }

    try {
      await mcpSessionStorage.run(mcpSessionId || "initializing", async () => {
        await session!.transport.handleRequest(
          req as unknown as Parameters<McpHandleRequest>[0],
          res as unknown as Parameters<McpHandleRequest>[1],
          req.body,
        );
      });
      const initializedSessionId = session.transport.sessionId;
      if (initializedSessionId && !sessions.has(initializedSessionId)) {
        sessions.set(initializedSessionId, session);
      }
    } catch (err: unknown) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: getErrorMessage(err),
          },
          id: null,
        });
      }
    }
  });

  return async () => {
    const activeSessions = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(activeSessions.map((session) => session.close()));
  };
}
