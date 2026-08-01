import { Router, Request, Response } from "express";
import * as path from "path";
import { SkillLoader } from "./skill-loader.js";
import { type RuntimePaths } from "./paths.js";
import { SkillInstaller, type PluginContractKind } from "@hiro/installer";
import { createSuccessResponse, createErrorResponse } from "./skill-utils.js";
import {
  executeRuntimePluginTool,
  loadRuntimePluginContracts,
} from "./plugins/plugin-contract-runtime.js";
import {
  listRuntimePluginChannelMetadata,
  probeRuntimePluginChannel,
} from "./plugins/plugin-channel-adapter.js";
import {
  listRuntimePluginProviderMetadata,
  probeRuntimePluginProvider,
} from "./plugins/plugin-provider-adapter.js";
import { buildPluginMarketplaceReadinessReport } from "./plugins/plugin-marketplace-readiness.js";
import {
  registerRuntimePluginTools,
  type PluginToolRegistrationResult,
} from "./plugins/plugin-tool-registration.js";
import type { ChannelProbeMode } from "./api/channel-runtime-probe.js";
import type { ToolRegistry } from "./tools/registry/executor.js";

const PLUGIN_CONTRACT_KINDS = new Set<PluginContractKind>([
  "tools",
  "channels",
  "skills",
  "providers",
  "hooks",
]);
const CHANNEL_PROBE_MODES = new Set<ChannelProbeMode>([
  "mock",
  "sandbox",
  "live",
]);

interface AutoSkillInstallResult {
  installed: number;
  source: string;
  skillFilter?: string;
  refreshed: boolean;
  installedSkills?: string[];
  pluginTools?: PluginToolRegistrationResult;
}

interface SkillInstallResult {
  success: boolean;
  name?: string;
  version?: string;
  action?: string;
  path?: string;
  error?: string;
  [key: string]: unknown;
}

interface RegistrySearchResponse {
  skills?: unknown[];
  data?: unknown[];
}

interface CreateSkillsRouterOptions {
  toolRegistry?: ToolRegistry;
}

async function discoverInstalledSkillIds(
  skillLoader: SkillLoader,
): Promise<string[]> {
  try {
    const skills = await skillLoader.getAllSkillsMetadata();
    return skills.map((s) => s.id || s.name || "").filter(Boolean);
  } catch {
    return [];
  }
}

async function installSkillDirect(
  skillSpec: string,
  workspaceDir: string,
  skillLoader: SkillLoader,
): Promise<{ result: SkillInstallResult }> {
  const skillsDir = path.join(workspaceDir, "src", "skills");
  const skillInstaller = new SkillInstaller(skillsDir);
  await skillInstaller.init();
  const result = (await skillInstaller.install(
    skillSpec,
  )) as SkillInstallResult;
  skillLoader.refreshCache();
  return { result };
}

function shouldRefreshPluginTools(result: SkillInstallResult): boolean {
  return result.success || result.action === "skipped";
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseChannelProbeMode(value: unknown): ChannelProbeMode | undefined {
  if (typeof value !== "string") return undefined;
  return CHANNEL_PROBE_MODES.has(value as ChannelProbeMode)
    ? (value as ChannelProbeMode)
    : undefined;
}

export function createSkillsRouter(
  skillLoader: SkillLoader,
  paths?: RuntimePaths,
  options: CreateSkillsRouterOptions = {},
): Router {
  const router = Router();
  const effectivePaths = paths || skillLoader.runtimePaths;
  const wd = effectivePaths.sourceDir ?? process.cwd();

  const refreshRuntimePluginTools = async () => {
    if (!options.toolRegistry) return undefined;
    return registerRuntimePluginTools(options.toolRegistry, effectivePaths, {
      replaceExisting: true,
    });
  };

  router.get("/", async (req: Request, res: Response) => {
    try {
      const action = req.query.action as string | undefined;
      if (!action || action === "list") {
        const skills = await skillLoader.getAllSkillsMetadata();
        return res.json(
          createSuccessResponse({ skills, total: skills.length }),
        );
      }
      if (action === "search") {
        const { q, category, tags, limit } = req.query;
        const keywords = q ? (typeof q === "string" ? q.split(",") : [q]) : [];
        const tagArray = tags
          ? typeof tags === "string"
            ? tags.split(",")
            : Array.isArray(tags)
              ? tags
              : []
          : [];
        const searchEngine = skillLoader.getSearchEngine();
        const result = await searchEngine.search({
          keywords: keywords.map((k) => (k as string).trim()),
          category: category as string | undefined,
          tags: tagArray.map((t) => (t as string).trim()),
          enabled: true,
          limit: limit ? parseInt(limit as string, 10) : 20,
        });
        return res.json(
          createSuccessResponse({
            results: result.results,
            total: result.total,
            executionTimeMs: result.executionTimeMs,
          }),
        );
      }
      if (action === "categories") {
        const searchEngine = skillLoader.getSearchEngine();
        const categories = await searchEngine.getCategories();
        return res.json(
          createSuccessResponse({ categories, total: categories.length }),
        );
      }
      if (action === "tags") {
        const searchEngine = skillLoader.getSearchEngine();
        const tags = await searchEngine.getTags();
        return res.json(createSuccessResponse({ tags, total: tags.length }));
      }
      if (action === "stats") {
        const stats = await skillLoader.getStats();
        return res.json(createSuccessResponse(stats));
      }
      if (action === "loaded") {
        const loaded = skillLoader.getLoadedSkills();
        return res.json(
          createSuccessResponse({ loaded, total: loaded.length }),
        );
      }
      if (action === "discover") {
        const ids = await discoverInstalledSkillIds(skillLoader);
        return res.json(createSuccessResponse({ total: ids.length, ids }));
      }
      if (action === "get" || action === "category") {
        const skillId = req.query.id as string | undefined;
        const category = req.query.category as string | undefined;
        const searchEngine = skillLoader.getSearchEngine();
        if (action === "get" && skillId) {
          const skill = await searchEngine.getSkill(skillId);
          if (!skill)
            return res.status(404).json(createErrorResponse("Skill not found"));
          return res.json(createSuccessResponse(skill));
        }
        if (action === "category" && category) {
          const skills = await searchEngine.getCategory(category);
          return res.json(
            createSuccessResponse({ skills, total: skills.length }),
          );
        }
      }
      return res
        .status(400)
        .json(
          createErrorResponse(
            `Unknown action: ${action || "missing action parameter"}`,
          ),
        );
    } catch (err: unknown) {
      res
        .status(500)
        .json(createErrorResponse("Failed to process skill request", err));
    }
  });

  router.get("/plugins", async (req: Request, res: Response) => {
    try {
      const action = req.query.action as string | undefined;
      if (action === "contracts" || !action) {
        const rawKind =
          typeof req.query.kind === "string" ? req.query.kind : "";
        const kind = rawKind || undefined;
        if (kind && !PLUGIN_CONTRACT_KINDS.has(kind as PluginContractKind)) {
          return res
            .status(400)
            .json(createErrorResponse("Invalid contract kind"));
        }
        const skillInstaller = new SkillInstaller(
          path.join(wd, "src", "skills"),
        );
        await skillInstaller.init();
        const contracts = await skillInstaller
          .getRegistry()
          .listPluginContracts(kind as PluginContractKind | undefined);
        return res.json(
          createSuccessResponse({ contracts, total: contracts.length }),
        );
      }
      if (action === "runtime-contracts") {
        const rawKind =
          typeof req.query.kind === "string" ? req.query.kind : "";
        const kind = rawKind || undefined;
        if (kind && !PLUGIN_CONTRACT_KINDS.has(kind as PluginContractKind)) {
          return res
            .status(400)
            .json(createErrorResponse("Invalid contract kind"));
        }
        const contracts = await loadRuntimePluginContracts(wd, {
          kind: kind as PluginContractKind | undefined,
        });
        return res.json(
          createSuccessResponse({ contracts, total: contracts.length }),
        );
      }
      if (action === "channels") {
        const channels = await listRuntimePluginChannelMetadata(wd);
        return res.json(
          createSuccessResponse({ channels, total: channels.length }),
        );
      }
      if (action === "providers") {
        const providers = await listRuntimePluginProviderMetadata(wd);
        return res.json(
          createSuccessResponse({ providers, total: providers.length }),
        );
      }
      if (action === "marketplace") {
        const pluginName =
          typeof req.query.plugin === "string" && req.query.plugin.trim()
            ? req.query.plugin.trim()
            : undefined;
        const includeNonPluginSkills =
          typeof req.query.includeNonPluginSkills === "string" &&
          req.query.includeNonPluginSkills.toLowerCase() === "true";
        const report = await buildPluginMarketplaceReadinessReport(wd, {
          pluginName,
          includeNonPluginSkills,
        });
        return res.json({
          success: true,
          data: report.data,
          total: report.total,
          summary: report.summary,
          generatedAt: report.generatedAt,
          skillsDir: report.skillsDir,
          configPath: report.configPath,
        });
      }
      return res
        .status(400)
        .json(
          createErrorResponse(
            `Unknown action: ${action || "missing action parameter"}`,
          ),
        );
    } catch (err: unknown) {
      res
        .status(500)
        .json(createErrorResponse("Failed to process plugin request", err));
    }
  });

  router.post("/manage", async (req: Request, res: Response) => {
    try {
      const action = req.body.action as string | undefined;

      if (action === "call-tool") {
        const args =
          req.body.args && typeof req.body.args === "object"
            ? (req.body.args as Record<string, unknown>)
            : {};
        const result = await executeRuntimePluginTool(
          wd,
          req.body.toolName || "",
          args,
          {
            actor: "api.skills",
            requestId: (req as Request & { requestId?: string }).requestId,
          },
        );
        return res
          .status(result.success ? 200 : 400)
          .json(
            result.success
              ? createSuccessResponse(result)
              : createErrorResponse(result.error || "Tool execution failed"),
          );
      }

      if (action === "probe-channel") {
        const body = recordOrEmpty(req.body);
        const rawConfiguredSecrets = Array.isArray(body.configuredSecrets)
          ? body.configuredSecrets
          : Array.isArray(body.configured_secrets)
            ? body.configured_secrets
            : [];
        const configuredSecrets = rawConfiguredSecrets.filter(
          (item): item is string => typeof item === "string",
        );
        const probe = await probeRuntimePluginChannel(
          wd,
          req.body.channelName || "",
          recordOrEmpty(body.config),
          {
            configuredSecrets,
            mode: parseChannelProbeMode(req.query.mode),
          },
        );
        if (!probe)
          return res
            .status(404)
            .json(createErrorResponse("Plugin channel not found"));
        return res.json(createSuccessResponse(probe));
      }

      if (action === "probe-provider") {
        const result = await probeRuntimePluginProvider(
          wd,
          req.body.providerId || "",
          recordOrEmpty(req.body),
        );
        if (!result)
          return res
            .status(404)
            .json(createErrorResponse("Plugin provider not found"));
        return res
          .status(result.success ? 200 : 400)
          .json(
            result.success
              ? createSuccessResponse(result)
              : createErrorResponse(result.error || "Provider probe failed"),
          );
      }

      if (action === "load") {
        const skillDef = await skillLoader.loadSkill(req.body.skillId || "");
        if (!skillDef)
          return res
            .status(404)
            .json(createErrorResponse("Failed to load skill"));
        return res.json(
          createSuccessResponse({
            id: skillDef.metadata.id,
            name: skillDef.metadata.name,
            loaded: true,
            indexPath: skillDef.index,
            tools: skillDef.tools?.length || 0,
          }),
        );
      }

      if (
        action === "install" ||
        action === "auto-install" ||
        action === "install-direct"
      ) {
        const source = req.body.source;
        if (!source)
          return res
            .status(400)
            .json(createErrorResponse("Missing required field: source"));
        const installResult = await installSkillDirect(source, wd, skillLoader);
        const pluginTools = shouldRefreshPluginTools(installResult.result)
          ? await refreshRuntimePluginTools()
          : undefined;

        if (action === "auto-install") {
          const requireInstalled = req.body.requireInstalled ?? false;
          if (requireInstalled && !installResult.result.success)
            return res
              .status(404)
              .json(
                createErrorResponse(
                  "No skills were installed from the given source",
                ),
              );
          const autoResult: AutoSkillInstallResult = {
            installed: installResult.result.success ? 1 : 0,
            source,
            skillFilter: req.body.skillName,
            refreshed: true,
            installedSkills: [],
            pluginTools,
          };
          return res.json(createSuccessResponse(autoResult));
        }

        if (
          action === "install-direct" &&
          !installResult.result.success &&
          installResult.result.action === "skipped"
        ) {
          return res.json(
            createSuccessResponse({
              ...installResult.result,
              pluginTools,
              message: `Skill already installed: ${installResult.result.name}@${installResult.result.version}`,
            }),
          );
        }

        return res.json(
          createSuccessResponse({ ...installResult.result, pluginTools }),
        );
      }

      if (action === "search-registry") {
        const query = req.body.query;
        if (!query)
          return res
            .status(400)
            .json(createErrorResponse("Missing required field: query"));
        const apiRes = await fetch(
          `https://www.skills.sh/api/skills?q=${encodeURIComponent(query)}&limit=20`,
        );
        if (!apiRes.ok)
          return res
            .status(502)
            .json(
              createErrorResponse(`skills.sh API returned ${apiRes.status}`),
            );
        const data = (await apiRes.json()) as RegistrySearchResponse;
        const skills = data.skills || data.data || [];
        return res.json(
          createSuccessResponse({ skills, total: skills.length }),
        );
      }

      if (action === "reload-cache") {
        skillLoader.refreshCache();
        const pluginTools = await refreshRuntimePluginTools();
        const stats = await skillLoader.getStats();
        return res.json(createSuccessResponse({ ...stats, pluginTools }));
      }

      return res
        .status(400)
        .json(
          createErrorResponse(
            `Unknown action: ${action || "missing action parameter"}`,
          ),
        );
    } catch (err: unknown) {
      res
        .status(500)
        .json(createErrorResponse("Failed to process manage request", err));
    }
  });

  return router;
}

export default createSkillsRouter;
