import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  listBuiltinPluginHealth,
  listBuiltinPluginManifests,
} from "../plugins/builtin-plugin-catalog.js";
import type { PluginHealth } from "../plugins/sdk/index.js";
import { buildPluginMarketplaceReadinessReport } from "../plugins/plugin-marketplace-readiness.js";
import {
  SkillStoreError,
  type SkillDetail,
  type SkillRecord,
  type SkillStore,
} from "../skills-manager/skill-store.js";
import type { SkillRegistryClient } from "../skills-manager/registry-client.js";
import {
  multipartBoundary,
  parseMultipartForm,
  readRequestBuffer,
} from "./file-manager-router.js";

export interface SkillAuditEvent {
  action: "import" | "install" | "delete";
  subject: string;
  status: "ok" | "blocked" | "failed";
  detail?: Record<string, unknown>;
}

export interface SkillsRouterOptions {
  store: SkillStore;
  registry: SkillRegistryClient;
  /** Install root used by the plugin readiness report. */
  workspaceDir: string;
  downloadedSkillsDir?: string;
  configPath?: string;
  /** Live health probes layered over the static plugin health. */
  pluginHealth?: () =>
    Record<string, PluginHealth> | Promise<Record<string, PluginHealth>>;
  audit?: (event: SkillAuditEvent) => void;
}

const MAX_IMPORT_BYTES = 55 * 1024 * 1024;

const wrap =
  (
    handler: (req: Request, res: Response) => Promise<unknown> | unknown,
  ): RequestHandler =>
  (req, res, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };

/** Shape expected by the dashboard's SkillSupportItem. */
function publicSkill(record: SkillRecord) {
  return {
    name: record.name,
    path: record.path,
    source: record.source,
    description: record.description,
    origin_kind: record.origin_kind,
    category: record.category,
    tags: record.tags,
    version: record.version,
    author: record.author,
    deletable: record.deletable,
    scripts: record.scripts,
    ...(record.registry_name ? { registry_name: record.registry_name } : {}),
    ...(record.registry_url ? { registry_url: record.registry_url } : {}),
    ...(record.installed_version
      ? { installed_version: record.installed_version }
      : {}),
    ...(record.installed_at ? { installed_at: record.installed_at } : {}),
  };
}

const publicDetail = (detail: SkillDetail) => ({
  ...publicSkill(detail),
  content: detail.content,
  files: detail.files,
});

export function createSkillsRouter(options: SkillsRouterOptions): Router {
  const router = Router();
  const { store, registry } = options;

  // Installed skills (bundled + imported + installed).
  router.get(
    "/",
    wrap(async (_req, res) => {
      const skills = (await store.list()).map(publicSkill);
      res.json({ skills, total: skills.length });
    }),
  );

  // Marketplace search across the configured registries.
  router.get(
    "/search",
    wrap(async (req, res) => {
      const query = String(req.query.q ?? "").trim();
      res.json(
        await registry.search(
          query,
          Number(req.query.limit) || 20,
          Number(req.query.offset) || 0,
        ),
      );
    }),
  );

  // Built-in plugin catalog and its health.
  router.get(
    "/plugins",
    wrap(async (req, res) => {
      const action = String(req.query.action ?? "capabilities");
      if (action === "capability-health") {
        const live = (await options.pluginHealth?.()) ?? {};
        const health = listBuiltinPluginHealth(live);
        return res.json({ health, total: Object.keys(health).length });
      }
      if (action === "capabilities") {
        const manifests = listBuiltinPluginManifests();
        return res.json({ manifests, total: manifests.length });
      }
      return res.status(400).json({
        error: `Unknown plugins action "${action}". Use capabilities or capability-health.`,
      });
    }),
  );

  router.get(
    "/plugin-marketplace/readiness",
    wrap(async (_req, res) => {
      const result = await buildPluginMarketplaceReadinessReport(
        options.workspaceDir,
        {
          skillsDir: options.downloadedSkillsDir,
          configPath: options.configPath,
        },
      );
      res.json(result);
    }),
  );

  // Upload a .zip, .tar.gz or SKILL.md.
  router.post(
    "/import",
    wrap(async (req, res) => {
      const contentType = String(req.headers["content-type"] ?? "");
      if (!contentType.toLowerCase().startsWith("multipart/form-data"))
        throw new SkillStoreError(
          415,
          'Send the skill as multipart/form-data with a "file" field.',
          "bad_content_type",
        );
      const body = await readRequestBuffer(req, MAX_IMPORT_BYTES);
      const form = parseMultipartForm(body, multipartBoundary(req));
      const upload =
        form.files.find((file) => file.field === "file") ?? form.files[0];
      if (!upload)
        throw new SkillStoreError(
          400,
          "A skill file is required.",
          "file_required",
        );
      const force =
        String(form.fields.force ?? req.query.force ?? "").toLowerCase() ===
        "true";
      try {
        const outcome = await store.importBuffer(
          upload.data,
          upload.filename,
          { origin: "manual", source: `upload:${upload.filename}` },
          { force },
        );
        options.audit?.({
          action: "import",
          subject: outcome.skills.map((skill) => skill.name).join(","),
          status: "ok",
          detail: {
            filename: upload.filename,
            suspicious: outcome.is_suspicious,
          },
        });
        const first = outcome.skills[0];
        res.status(201).json({
          status: outcome.replaced.length ? "updated" : "imported",
          ...(first ? publicSkill(first) : {}),
          skills: outcome.skills.map(publicSkill),
          warnings: outcome.warnings,
          is_suspicious: outcome.is_suspicious,
          findings: outcome.findings,
        });
      } catch (error) {
        options.audit?.({
          action: "import",
          subject: upload.filename,
          status:
            error instanceof SkillStoreError && error.code === "suspicious"
              ? "blocked"
              : "failed",
          detail: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
    }),
  );

  // Install from a registry slug or an archive/GitHub URL.
  router.post(
    "/install",
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const str = (value: unknown) =>
        typeof value === "string" && value.trim() ? value.trim() : undefined;
      const request = {
        slug: str(body.slug),
        id: str(body.id),
        url: str(body.url),
        registry: str(body.registry),
        version: str(body.version),
        force: body.force === true,
      };
      try {
        const result = await registry.install(request);
        options.audit?.({
          action: "install",
          subject: result.slug,
          status: "ok",
          detail: {
            registry: result.registry,
            version: result.version,
            suspicious: result.is_suspicious,
          },
        });
        const first = result.outcome.skills[0];
        res.status(201).json({
          status: result.status,
          slug: result.slug,
          registry: result.registry,
          version: result.version,
          summary: result.summary,
          is_suspicious: result.is_suspicious,
          ...(first ? { skill: publicSkill(first) } : {}),
          skills: result.outcome.skills.map(publicSkill),
          warnings: result.outcome.warnings,
        });
      } catch (error) {
        options.audit?.({
          action: "install",
          subject: request.slug ?? request.url ?? "",
          status:
            error instanceof SkillStoreError && error.code === "suspicious"
              ? "blocked"
              : "failed",
          detail: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
    }),
  );

  router.get(
    "/:name",
    wrap(async (req, res) => {
      const detail = await store.get(req.params.name);
      if (!detail)
        throw new SkillStoreError(404, "Skill not found", "not_found");
      res.json(publicDetail(detail));
    }),
  );

  router.delete(
    "/:name",
    wrap(async (req, res) => {
      if (req.headers["x-miki-confirm"] !== "delete-skill")
        throw new SkillStoreError(
          400,
          "Deleting a skill requires the X-Miki-Confirm: delete-skill header.",
          "confirmation_required",
        );
      try {
        const removed = await store.remove(req.params.name);
        options.audit?.({
          action: "delete",
          subject: removed.name,
          status: "ok",
        });
        res.json({ status: "deleted", name: removed.name });
      } catch (error) {
        options.audit?.({
          action: "delete",
          subject: req.params.name,
          status: "failed",
          detail: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
    }),
  );

  // Error mapper: keep the `error` string the dashboard reads.
  router.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof SkillStoreError)
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ?? {}),
        });
      const status =
        typeof (error as { status?: unknown })?.status === "number"
          ? (error as { status: number }).status
          : 500;
      const message = error instanceof Error ? error.message : String(error);
      return res.status(status).json({
        error: status >= 500 ? `Skills request failed: ${message}` : message,
      });
    },
  );

  return router;
}
