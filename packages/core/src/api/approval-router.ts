import { Router, type Request, type Response } from "express";
import {
  ApprovalInbox,
  type ApprovalAction,
  type ApprovalRisk,
} from "../security/approval-inbox.js";

const ACTIONS = new Set<ApprovalAction>([
  "login",
  "mfa_takeover",
  "payment",
  "publish",
  "delete",
  "external_write",
  "browser_navigation",
]);
const RISKS = new Set<ApprovalRisk>(["low", "medium", "high", "critical"]);

export function createApprovalRouter(inbox: ApprovalInbox): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ requests: inbox.list() });
  });

  router.get("/:id", (req, res) => {
    const request = inbox.get(getRequestId(req));
    if (!request)
      return res.status(404).json({ error: "Approval request not found" });
    return res.json({ request });
  });

  router.post("/", (req, res) => {
    const body =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : {};
    if (
      typeof body.runId !== "string" ||
      typeof body.actor !== "string" ||
      typeof body.resource !== "string" ||
      typeof body.reason !== "string"
    ) {
      return res
        .status(400)
        .json({ error: "runId, actor, resource and reason are required" });
    }
    if (
      typeof body.action !== "string" ||
      !ACTIONS.has(body.action as ApprovalAction)
    ) {
      return res.status(400).json({ error: "Unsupported approval action" });
    }
    if (
      typeof body.risk !== "string" ||
      !RISKS.has(body.risk as ApprovalRisk)
    ) {
      return res.status(400).json({ error: "Unsupported approval risk" });
    }
    const challenge = inbox.request({
      runId: body.runId,
      actor: body.actor,
      action: body.action as ApprovalAction,
      resource: body.resource,
      risk: body.risk as ApprovalRisk,
      reason: body.reason,
      context:
        body.context &&
        typeof body.context === "object" &&
        !Array.isArray(body.context)
          ? (body.context as Record<string, unknown>)
          : undefined,
      ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined,
    });
    // The raw token is intentionally not returned by this dashboard-facing endpoint.
    // A worker or trusted orchestrator must receive it through an in-process handoff.
    return res
      .status(201)
      .json({ request: challenge.request, tokenIssued: true });
  });

  router.post("/:id/approve", (req, res) => decide(req, res, inbox, "approve"));
  router.post("/:id/deny", (req, res) => decide(req, res, inbox, "deny"));
  router.post("/:id/revoke", (req, res) => {
    try {
      const body =
        req.body && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      const decidedBy =
        typeof body.decidedBy === "string"
          ? body.decidedBy
          : "dashboard-operator";
      const reason =
        typeof body.reason === "string" ? body.reason : "revoked by operator";
      return res.json({
        request: inbox.revoke(getRequestId(req), decidedBy, reason),
      });
    } catch (error) {
      return sendApprovalError(res, error);
    }
  });

  return router;
}

function getRequestId(req: Request): string {
  const value = req.params.id;
  return Array.isArray(value) ? value[0] : String(value ?? "");
}

function decide(
  req: Request,
  res: Response,
  inbox: ApprovalInbox,
  decision: "approve" | "deny",
) {
  try {
    const body =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : {};
    const decidedBy =
      typeof body.decidedBy === "string"
        ? body.decidedBy
        : "dashboard-operator";
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const request =
      decision === "approve"
        ? inbox.approveByOperator(
            getRequestId(req),
            decidedBy,
            reason ?? "approved by operator",
          )
        : inbox.denyByOperator(
            getRequestId(req),
            decidedBy,
            reason ?? "denied by operator",
          );
    return res.json({ request });
  } catch (error) {
    return sendApprovalError(res, error);
  }
}

function sendApprovalError(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message)
    ? 404
    : /already|expired|invalid|required/i.test(message)
      ? 409
      : 400;
  return res.status(status).json({ error: message });
}
