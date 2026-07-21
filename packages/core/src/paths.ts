import * as path from "path";
import * as fs from "fs";
import * as os from "os";

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

const Hiro_NS = "Hiro";

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
  const envDir = process.env["Hiro_WORKSPACE_DIR"];
  if (envDir) return path.resolve(envDir);
  if (process.env["Hiro_RUNTIME_ROOT"])
    return path.resolve(process.env["Hiro_RUNTIME_ROOT"]);
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

export function resolveRuntimePaths(): RuntimePaths {
  const legacyDir = resolveLegacyDir();
  const configDir = path.join(osConfigRoot(), Hiro_NS);
  const dataDir = path.join(osDataRoot(), Hiro_NS);
  const skillsDir = path.join(osDataRoot(), Hiro_NS, "skills");
  const cacheDir = path.join(osCacheRoot(), Hiro_NS);
  const binDir = path.join(osDataRoot(), Hiro_NS, "bin");
  const docsDir = path.join(osDataRoot(), Hiro_NS, "docs");
  const outputDir = path.join(osDataRoot(), Hiro_NS, "output");
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
