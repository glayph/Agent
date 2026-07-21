import { Router, Request, Response } from "express";
import {
  getSessionPermissionState,
  getSessionPermissions,
  setSessionPermissions,
} from "./auth-middleware.js";

interface PermissionAuditRecorder {
  record(input: {
    type: "system.event";
    actor?: string;
    subject?: string;
    requestId?: string;
    details?: Record<string, unknown>;
  }): unknown;
}

interface SessionRouterOptions {
  audit?: PermissionAuditRecorder;
}

export function createSessionRouter(
  options: SessionRouterOptions = {},
): Router {
  const router = Router();

  /**
   * GET /sessions/:sessionId/permissions
   * Retrieve tool permissions for a session
   */
  router.get("/:sessionId/permissions", (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const permissions = getSessionPermissions(sessionId);
    const state = getSessionPermissionState(sessionId);
    res.json({
      ...permissions,
      permissions,
      denials: state.denials,
      state,
    });
  });

  /**
   * PUT /sessions/:sessionId/permissions
   * Update tool permissions for a session
   */
  router.put("/:sessionId/permissions", (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const { permissions } = req.body;

    if (!permissions || typeof permissions !== "object") {
      return res.status(400).json({
        error: "Bad request",
        detail: "permissions must be an object",
      });
    }

    const before = getSessionPermissionState(sessionId);
    setSessionPermissions(sessionId, permissions);
    const state = getSessionPermissionState(sessionId);
    const changes = state.timeline.slice(before.timeline.length);
    for (const change of changes) {
      try {
        options.audit?.record({
          type: "system.event",
          actor: "session.permissions",
          subject: `permission.${change.action || (change.enabled ? "grant" : "deny")}`,
          requestId:
            typeof req.headers["x-request-id"] === "string"
              ? req.headers["x-request-id"]
              : undefined,
          details: {
            action: `permission.${change.action || (change.enabled ? "grant" : "deny")}`,
            sessionId: state.sessionId,
            toolName: change.toolName,
            enabled: change.enabled,
            reason: change.reason,
            changedAt: change.changedAt,
          },
        });
      } catch (error) {
        console.warn("[SessionRouter] permission audit failed:", error);
      }
    }
    res.json({
      success: true,
      permissions: getSessionPermissions(sessionId),
      denials: state.denials,
      state,
    });
  });

  return router;
}
