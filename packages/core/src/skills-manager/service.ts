import * as path from "node:path";
import { bundledSkillsRoot } from "@miki/skills";
import { normalizeRuntimePaths, resolveDownloadedSkillsDir } from "../paths.js";
import { SkillStore } from "./skill-store.js";
import {
  SkillRegistryClient,
  parseRegistryList,
  type SkillRegistryConfig,
} from "./registry-client.js";
import { createPluginBridge } from "./plugin-bridge.js";

export interface SkillsServiceOptions {
  dataDir: string;
  workspaceDir: string;
  /** Reads the dashboard configuration; `skills.registries` adds registries. */
  getAppConfig?: () => Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  bundledRoot?: string;
}

export interface SkillsService {
  store: SkillStore;
  registry: SkillRegistryClient;
  userDir: string;
  downloadedSkillsDir: string;
  registries(): SkillRegistryConfig[];
}

/** Wire the store, registry client and plugin bridge from the runtime directories. */
export function createSkillsService(
  options: SkillsServiceOptions,
): SkillsService {
  const env = options.env ?? process.env;
  const runtimePaths = normalizeRuntimePaths({
    sourceDir: options.workspaceDir,
    dataDir: options.dataDir,
  } as never);
  const userDir = path.join(options.dataDir, "skills");
  const downloadedSkillsDir = resolveDownloadedSkillsDir(
    runtimePaths,
    options.workspaceDir,
  );
  const bridge = createPluginBridge(downloadedSkillsDir);

  const store = new SkillStore({
    bundledRoot: options.bundledRoot ?? bundledSkillsRoot(),
    userDir,
    extraSkills: bridge.extraSkills,
    removeExtra: bridge.removeExtra,
  });

  const registries = (): SkillRegistryConfig[] => {
    const config = options.getAppConfig?.().skills as
      { registries?: unknown } | undefined;
    return parseRegistryList([
      ...parseRegistryList(env.MIKI_SKILL_REGISTRIES),
      ...parseRegistryList(config?.registries),
    ]);
  };

  const registry = new SkillRegistryClient({
    registries,
    store,
    allowInsecure: () =>
      String(env.MIKI_SKILL_ALLOW_INSECURE ?? "").toLowerCase() === "true",
  });

  return { store, registry, userDir, downloadedSkillsDir, registries };
}
