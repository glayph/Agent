import { Router, type Request, type Response } from "express";
import { AgentControlService } from "./service.js";
import type { ControlOperationRequest } from "./types.js";

function recordBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function operationRequest(
  body: Record<string, unknown>,
): ControlOperationRequest {
  const context =
    body.context &&
    typeof body.context === "object" &&
    !Array.isArray(body.context)
      ? (body.context as Record<string, unknown>)
      : {};
  return {
    capability: typeof body.capability === "string" ? body.capability : "",
    action: typeof body.action === "string" ? body.action : "",
    input:
      body.input && typeof body.input === "object" && !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : {},
    approvalToken:
      typeof body.approvalToken === "string" ? body.approvalToken : undefined,
    approvalRequestId:
      typeof body.approvalRequestId === "string"
        ? body.approvalRequestId
        : undefined,
    context: {
      origin:
        context.origin === "telegram" ||
        context.origin === "mcp" ||
        context.origin === "dashboard" ||
        context.origin === "api" ||
        context.origin === "system"
          ? context.origin
          : "api",
      actor: typeof context.actor === "string" ? context.actor : undefined,
      requestId:
        typeof context.requestId === "string" ? context.requestId : undefined,
      sessionId:
        typeof context.sessionId === "string" ? context.sessionId : undefined,
    },
  };
}

export function createControlRouter(
  getService: () => AgentControlService | undefined,
): Router {
  const router = Router();
  const serviceOr404 = (res: Response): AgentControlService | undefined => {
    const service = getService();
    if (!service) {
      res.status(503).json({ error: "Agent control service is not ready" });
      return undefined;
    }
    return service;
  };

  router.get("/capabilities", (_req, res) => {
    const service = serviceOr404(res);
    if (!service) return;
    res.json({ capabilities: service.listCapabilities() });
  });

  router.get("/state", (_req, res) => {
    const service = serviceOr404(res);
    if (!service) return;
    res.json({ state: service.getState() });
  });

  router.get("/operations", (req, res) => {
    const service = serviceOr404(res);
    if (!service) return;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(100, rawLimit))
      : 20;
    // The journal is intentionally read-only from the HTTP surface.
    const journal = service.listOperations(limit);
    res.json({ operations: journal });
  });

  router.post("/plan", async (req: Request, res: Response) => {
    const service = serviceOr404(res);
    if (!service) return;
    try {
      res.json({
        plan: await service.plan(operationRequest(recordBody(req.body))),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post("/execute", async (req: Request, res: Response) => {
    const service = serviceOr404(res);
    if (!service) return;
    try {
      const body = recordBody(req.body);
      const request = operationRequest(body);
      const plan =
        body.plan && typeof body.plan === "object" && !Array.isArray(body.plan)
          ? (body.plan as Parameters<AgentControlService["execute"]>[1])
          : undefined;
      const outcome = await service.execute(request, plan);
      res
        .status(
          outcome.status === "approval_required" ? 202 : outcome.ok ? 200 : 400,
        )
        .json({ outcome });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
