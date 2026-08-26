import { Router, type Request, type Response } from "express";
import {
  forgetSelectiveMemory,
  getSelectiveContext,
  getSelectiveMemoryStats,
  inspectSelectiveMemory,
  listSelectiveMemory,
  reindexSelectiveMemory,
} from "../memory/memory-bridge.js";

function runtimeScope(): Record<string, string> {
  return {
    agentId: process.env.MIKI_AGENT_ID || "miki",
    ownerId: process.env.MIKI_OWNER_ID || "default-owner",
    workspaceId: process.env.MIKI_WORKSPACE_ID || "default-workspace",
  };
}

function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.floor(parsed)))
    : fallback;
}

function safeQuery(value: unknown, max = 1000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function jsonError(res: Response, status: number, error: unknown): void {
  res
    .status(status)
    .json({ error: error instanceof Error ? error.message : String(error) });
}

/**
 * Dashboard-only memory observability. Scope is deliberately derived from the
 * runtime environment; clients cannot select another owner/workspace through
 * query parameters or request bodies.
 */
export function createMemoryRouter(): Router {
  const router = Router();

  router.get("/stats", (_req: Request, res: Response) => {
    try {
      res.json({
        scope: runtimeScope(),
        stats: getSelectiveMemoryStats(runtimeScope()),
      });
    } catch (error) {
      jsonError(res, 503, error);
    }
  });

  router.get("/chunks", (req: Request, res: Response) => {
    try {
      const region = safeQuery(req.query.region, 40) || undefined;
      const limit = boundedInt(req.query.limit, 50, 1, 200);
      res.json({
        scope: runtimeScope(),
        chunks: listSelectiveMemory(runtimeScope(), { region, limit }),
        limit,
      });
    } catch (error) {
      jsonError(res, 503, error);
    }
  });

  router.get("/search", (req: Request, res: Response) => {
    const query = safeQuery(req.query.q ?? req.query.query, 1000);
    if (!query) {
      res.status(400).json({ error: "q is required" });
      return;
    }
    try {
      const maxSelected = boundedInt(req.query.maxSelected, 12, 1, 32);
      const maxDepth = boundedInt(req.query.maxDepth, 2, 0, 5);
      const maxTokens = boundedInt(req.query.maxTokens, 1200, 64, 4000);
      const result = getSelectiveContext(query, {
        scope: runtimeScope(),
        maxSelected,
        maxDepth,
        maxTokens,
      });
      res.json({ query, scope: runtimeScope(), result });
    } catch (error) {
      jsonError(res, 503, error);
    }
  });

  router.get("/chunks/:chunkId", (req: Request, res: Response) => {
    const chunkId = safeQuery(req.params.chunkId, 160);
    if (!chunkId) {
      res.status(400).json({ error: "chunkId is required" });
      return;
    }
    try {
      const chunk = inspectSelectiveMemory(runtimeScope(), chunkId);
      if (!chunk) {
        res.status(404).json({ error: "Memory chunk not found" });
        return;
      }
      res.json({ scope: runtimeScope(), chunk });
    } catch (error) {
      jsonError(res, 503, error);
    }
  });

  router.post("/reindex", (_req: Request, res: Response) => {
    try {
      res.json({
        scope: runtimeScope(),
        result: reindexSelectiveMemory(runtimeScope()),
      });
    } catch (error) {
      jsonError(res, 503, error);
    }
  });

  router.post("/chunks/:chunkId/forget", (req: Request, res: Response) => {
    const chunkId = safeQuery(req.params.chunkId, 160);
    if (!chunkId) {
      res.status(400).json({ error: "chunkId is required" });
      return;
    }
    try {
      res.json({
        scope: runtimeScope(),
        result: forgetSelectiveMemory(runtimeScope(), chunkId),
      });
    } catch (error) {
      jsonError(res, 503, error);
    }
  });

  return router;
}
