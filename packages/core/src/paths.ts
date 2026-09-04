import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { isSandboxModeEnabled, readMikiEnv } from "@miki/config";

export interface RuntimePaths {
  configDir: string;
  dataDir: string;
  skillsDir: string;
  cacheDir: string;
  binDir: string;
  docsDir: string;
  outputDir: string;
  sourceDir?: string;
}

export type RuntimePathsInput = RuntimePaths | string;

const Miki_NS = "Miki";

function osConfigRoot(): string {
  if (process.env["XDG_CONFIG_HOME"])
    return path.resolve(process.env["XDG_CONFIG_HOME"]);
  if (process.platform === "win32" && process.env["APPDATA"])
    return path.resolve(process.env["APPDATA"]);
  return path.join(os.homedir(), ".config");
}

function osDataRoot(): string {
  if (process.env["XDG_DATA_HOME"])
    return path.resolve(process.env["XDG_DATA_HOME"]);
  if (process.platform === "win32" && process.env["LOCALAPPDATA"])
    return path.resolve(process.env["LOCALAPPDATA"]);
  return path.join(os.homedir(), ".local", "share");
}

function osCacheRoot(): string {
  if (process.env["XDG_CACHE_HOME"])
    return path.resolve(process.env["XDG_CACHE_HOME"]);
  if (process.platform === "win32" && process.env["LOCALAPPDATA"])
    return path.resolve(process.env["LOCALAPPDATA"], "cache");
  return path.join(os.homedir(), ".cache");
}

function resolveLegacyDir(): string | null {
  const envDir = readMikiEnv("MIKI_WORKSPACE_DIR");
  if (envDir) return path.resolve(envDir);
  const runtimeRoot = readMikiEnv("MIKI_RUNTIME_ROOT");
  if (runtimeRoot) return path.resolve(runtimeRoot);
  return null;
}

function migrationNeeded(legacyDir: string, configDir: string): boolean {
  const oldConfig = path.join(legacyDir, "config", "agent.yaml");
  const newConfig = path.join(configDir, "agent.yaml");
  return fs.existsSync(oldConfig) && !fs.existsSync(newConfig);
}

function migrateDirectory(source: string, dest: string): void {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.cpSync(source, dest, { recursive: true, force: false });
  } catch {
    console.warn(`[paths] Could not migrate ${source} -> ${dest}`);
  }
}

export function normalizeRuntimePaths(paths?: RuntimePathsInput): RuntimePaths {
  if (!paths) return resolveRuntimePaths();
  if (typeof paths === "string") {
    const sourceDir = path.resolve(paths);
    return {
      configDir: path.join(sourceDir, "config"),
      dataDir: path.join(sourceDir, "data"),
      skillsDir: path.join(sourceDir, "src", "skills"),
      cacheDir: path.join(sourceDir, "data", "cache"),
      binDir: path.join(sourceDir, "bin"),
      docsDir: path.join(sourceDir, "docs"),
      outputDir: path.join(sourceDir, "output"),
      sourceDir,
    };
  }

  const sourceDir = path.resolve(
    paths.sourceDir ?? paths.configDir ?? paths.dataDir ?? process.cwd(),
  );
  const configDir = paths.configDir ?? path.join(sourceDir, "config");
  const dataDir = paths.dataDir ?? path.join(sourceDir, "data");
  const skillsDir = paths.skillsDir ?? path.join(sourceDir, "src", "skills");
  const cacheDir = paths.cacheDir ?? path.join(dataDir, "cache");
  const binDir = paths.binDir ?? path.join(sourceDir, "bin");
  const docsDir = paths.docsDir ?? path.join(sourceDir, "docs");
  const outputDir = paths.outputDir ?? path.join(sourceDir, "output");

  return {
    configDir,
    dataDir,
    skillsDir,
    cacheDir,
    binDir,
    docsDir,
    outputDir,
    sourceDir: paths.sourceDir ? path.resolve(paths.sourceDir) : sourceDir,
  };
}

/**
 * Where downloaded/installed skills should actually be written.
 *
 * With security.sandbox_mode: true in agent.yaml (the default), this is
 * always <dataDir>/downloaded-skills — a location fully isolated from the
 * agent's own source/workspace tree and from the bundled skill catalog
 * (packages/skills/src), even when RuntimePaths was constructed from a raw
 * workspace path (dev mode), where skillsDir would otherwise resolve
 * *inside* the source tree at <sourceDir>/src/skills.
 *
 * This exists specifically so that cleaning up or resetting the workspace
 * can never accidentally delete a skill fetched from the internet that the
 * agent still needs — full system access elsewhere is unaffected; this
 * only isolates internet-sourced content.
 *
 * With sandbox_mode: false, falls back to the legacy runtimePaths.skillsDir
 * for backward compatibility with existing setups that rely on that path.
 */
export function resolveDownloadedSkillsDir(
  runtimePaths: RuntimePaths,
  workspaceDir?: string,
): string {
  const wd = workspaceDir ?? runtimePaths.sourceDir;
  if (isSandboxModeEnabled(wd)) {
    return path.join(runtimePaths.dataDir, "downloaded-skills");
  }
  return runtimePaths.skillsDir;
}

export function resolveRuntimePaths(): RuntimePaths {
  const legacyDir = resolveLegacyDir();
  // An explicit runtime root is an isolation boundary for supervised, test,
  // and multi-instance deployments. Do not silently fall back to the shared
  // OS-level Miki directories when the supervisor has selected a runtime.
  const explicitRuntimeRoot = readMikiEnv("MIKI_RUNTIME_ROOT");
  const runtimeRoot = explicitRuntimeRoot
    ? path.resolve(explicitRuntimeRoot)
    : undefined;
  const configDir = runtimeRoot
    ? path.join(runtimeRoot, "config")
    : path.join(osConfigRoot(), Miki_NS);
  const dataDir = runtimeRoot
    ? path.join(runtimeRoot, "data")
    : path.join(osDataRoot(), Miki_NS);
  const skillsDir = runtimeRoot
    ? path.join(runtimeRoot, "skills")
    : path.join(osDataRoot(), Miki_NS, "skills");
  const cacheDir = runtimeRoot
    ? path.join(runtimeRoot, "cache")
    : path.join(osCacheRoot(), Miki_NS);
  const binDir = runtimeRoot
    ? path.join(runtimeRoot, "bin")
    : path.join(osDataRoot(), Miki_NS, "bin");
  const docsDir = runtimeRoot
    ? path.join(runtimeRoot, "docs")
    : path.join(osDataRoot(), Miki_NS, "docs");
  const outputDir = runtimeRoot
    ? path.join(runtimeRoot, "output")
    : path.join(osDataRoot(), Miki_NS, "output");
  const sourceDir = legacyDir ?? process.cwd();

  const paths: RuntimePaths = {
    configDir,
    dataDir,
    skillsDir,
    cacheDir,
    binDir,
    docsDir,
    outputDir,
    sourceDir,
  };

  if (legacyDir && migrationNeeded(legacyDir, configDir)) {
    migrateDirectory(path.join(legacyDir, "config"), configDir);
    migrateDirectory(path.join(legacyDir, "data"), dataDir);
    migrateDirectory(path.join(legacyDir, "docs"), docsDir);
    migrateDirectory(path.join(legacyDir, "output"), outputDir);
    migrateDirectory(path.join(legacyDir, "src", "skills"), skillsDir);
  }

  for (const dir of Object.values(paths)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return paths;
}
