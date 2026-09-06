import { Router, type Request, type Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { type RuntimePaths } from "../paths.js";
import {
  addWorkspaceFolder,
  loadWorkspaceFolders,
  removeWorkspaceFolder,
  setIndexOnlyConfigured,
  updateWorkspaceFolder,
  listIndexRoots,
  loadFolderRules,
} from "../workspace-folders/index.js";
import { ensureSystemIndexStarted } from "../system-index/singleton.js";

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asBool(v: unknown, fallback?: boolean): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

/**
 * Settings API: manage folders the agent indexes / prefers for work.
 * Full system access remains; these entries control default index + rules.
 */
export function createWorkspaceFoldersRouter(
  runtimePaths: RuntimePaths,
): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const cfg = loadWorkspaceFolders(runtimePaths);
    res.json({
      ...cfg,
      indexRoots: listIndexRoots(runtimePaths),
    });
  });

  router.put("/settings", (req: Request, res: Response) => {
    const indexOnly = asBool(req.body?.indexOnlyConfigured);
    if (indexOnly === undefined) {
      res.status(400).json({ error: "indexOnlyConfigured boolean required" });
      return;
    }
    const cfg = setIndexOnlyConfigured(runtimePaths, indexOnly);
    resyncIndex(runtimePaths);
    res.json(cfg);
  });

  router.post("/", (req: Request, res: Response) => {
    const folderPath = asString(req.body?.path);
    if (!folderPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const resolved = path.resolve(folderPath);
    if (!fs.existsSync(resolved)) {
      res.status(400).json({
        error: `Path does not exist: ${resolved}`,
      });
      return;
    }
    try {
      const folder = addWorkspaceFolder(runtimePaths, {
        path: resolved,
        label: asString(req.body?.label),
        index: asBool(req.body?.index, true),
        restrictDefault: asBool(req.body?.restrictDefault, false),
        rulesFiles: Array.isArray(req.body?.rulesFiles)
          ? (req.body.rulesFiles as string[])
          : undefined,
        notes: asString(req.body?.notes),
      });
      resyncIndex(runtimePaths);
      res.status(201).json(folder);
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  router.patch("/:id", (req: Request, res: Response) => {
    const id = req.params.id;
    const patch: Record<string, unknown> = {};
    if (asString(req.body?.path)) patch.path = asString(req.body.path);
    if (asString(req.body?.label)) patch.label = asString(req.body.label);
    if (asBool(req.body?.enabled) !== undefined)
      patch.enabled = asBool(req.body.enabled);
    if (asBool(req.body?.index) !== undefined)
      patch.index = asBool(req.body.index);
    if (asBool(req.body?.restrictDefault) !== undefined)
      patch.restrictDefault = asBool(req.body.restrictDefault);
    if (Array.isArray(req.body?.rulesFiles))
      patch.rulesFiles = req.body.rulesFiles;
    if (asString(req.body?.notes) !== undefined)
      patch.notes = asString(req.body.notes) || "";

    const updated = updateWorkspaceFolder(
      runtimePaths,
      id,
      patch as Parameters<typeof updateWorkspaceFolder>[2],
    );
    if (!updated) {
      res.status(404).json({ error: "folder not found" });
      return;
    }
    resyncIndex(runtimePaths);
    res.json(updated);
  });

  router.delete("/:id", (req: Request, res: Response) => {
    const ok = removeWorkspaceFolder(runtimePaths, req.params.id);
    if (!ok) {
      res.status(404).json({ error: "folder not found" });
      return;
    }
    resyncIndex(runtimePaths);
    res.json({ ok: true });
  });

  /** Preview rules the agent would load for a path */
  router.get("/rules", (req: Request, res: Response) => {
    const target = asString(req.query.path as string);
    if (!target) {
      res.status(400).json({ error: "path query required" });
      return;
    }
    const payload = loadFolderRules(runtimePaths, target);
    res.json(payload || { rules: [], skippedDueToMemory: false });
  });

  return router;
}

function resyncIndex(runtimePaths: RuntimePaths): void {
  try {
    const indexer = ensureSystemIndexStarted(runtimePaths);
    const roots = listIndexRoots(runtimePaths);
    // Always include private space
    const privateRoot =
      process.env.MIKI_PRIVATE_DIR ||
      path.join(
        process.env.HOME || process.env.USERPROFILE || "",
        ".local",
        "share",
        "Miki",
        "private",
      );
    const allRoots = [...new Set([...roots, privateRoot].filter(Boolean))];
    indexer.configure({
      roots: allRoots,
      includeSystemRoots: false,
      realtime: true,
    });
  } catch {
    // index optional
  }
}
