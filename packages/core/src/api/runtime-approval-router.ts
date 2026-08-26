import { Router, Request, Response } from "express";
import type { RuntimeFetcher } from "../runtime-fetch/index.js";

interface RuntimeApprovalRouterOptions {
  getRuntimeFetcher: () => RuntimeFetcher | null;
}

/**
 * Exposes the pending/recent runtime-install consent requests created by the
 * `runtime_ensure` tool, so the CLI TUI and the web dashboard can both show
 * "this skill wants to install X" and let the user approve or deny it.
 * Mirrors the shape of session-router.ts.
 */
export function createRuntimeApprovalRouter(
  options: RuntimeApprovalRouterOptions,
): Router {
  const router = Router();

  /**
   * GET /runtime-installer/requests
   * List pending approval requests (and recent decided ones for history).
   */
  router.get("/requests", (_req: Request, res: Response) => {
    const fetcher = options.getRuntimeFetcher();
    if (!fetcher) {
      return res
        .status(503)
        .json({ error: "Runtime fetcher is not initialized." });
    }
    const store = fetcher.getConsentStore();
    res.json({
      pending: store.listPending(),
      recent: store.listRecent(50),
    });
  });

  /**
   * GET /runtime-installer/requests/:id
   * Fetch a single request's current status.
   */
  router.get("/requests/:id", (req: Request, res: Response) => {
    const fetcher = options.getRuntimeFetcher();
    if (!fetcher) {
      return res
        .status(503)
        .json({ error: "Runtime fetcher is not initialized." });
    }
    const request = fetcher.getConsentStore().getById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: "No such request." });
    }
    res.json(request);
  });

  /**
   * POST /runtime-installer/requests/:id/approve
   * Approve a pending request. The actual install happens the next time the
   * skill calls runtime_ensure again, not synchronously here.
   */
  router.post("/requests/:id/approve", (req: Request, res: Response) => {
    const fetcher = options.getRuntimeFetcher();
    if (!fetcher) {
      return res
        .status(503)
        .json({ error: "Runtime fetcher is not initialized." });
    }
    const existing = fetcher.getConsentStore().getById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "No such request." });
    }
    if (existing.status !== "pending") {
      return res.status(409).json({
        error: `Request is not pending (status: ${existing.status}).`,
      });
    }
    const decidedBy =
      (req.body && typeof req.body.decidedBy === "string"
        ? req.body.decidedBy
        : undefined) || "dashboard-user";
    fetcher.recordDecision(req.params.id, true, decidedBy);
    res.json(fetcher.getConsentStore().getById(req.params.id));
  });

  /**
   * POST /runtime-installer/requests/:id/deny
   */
  router.post("/requests/:id/deny", (req: Request, res: Response) => {
    const fetcher = options.getRuntimeFetcher();
    if (!fetcher) {
      return res
        .status(503)
        .json({ error: "Runtime fetcher is not initialized." });
    }
    const existing = fetcher.getConsentStore().getById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "No such request." });
    }
    if (existing.status !== "pending") {
      return res.status(409).json({
        error: `Request is not pending (status: ${existing.status}).`,
      });
    }
    const decidedBy =
      (req.body && typeof req.body.decidedBy === "string"
        ? req.body.decidedBy
        : undefined) || "dashboard-user";
    fetcher.recordDecision(req.params.id, false, decidedBy);
    res.json(fetcher.getConsentStore().getById(req.params.id));
  });

  return router;
}

export default createRuntimeApprovalRouter;
