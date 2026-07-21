import { pathToFileURL } from "url";
import * as fs from "fs";
import * as path from "path";

export function rewriteApiProxyPath(p: string): string {
  return `/api${p}`;
}

export function rewriteWebhookProxyPath(p: string): string {
  return p === "/" ? "/webhooks" : `/webhooks${p}`;
}

export function rewriteMcpProxyPath(p: string): string {
  return p === "/" ? "/mcp" : `/mcp${p}`;
}

export function runtimeLoaderArgsFor(
  loaderPath: string,
  exists: (p: string) => boolean,
): string[] {
  if (!exists(loaderPath)) return [];
  const registerSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, pathToFileURL("./"));`,
  ].join(" ");
  return ["--import", `data:text/javascript,${encodeURIComponent(registerSource)}`];
}

export interface ResolveLiteLLMCommandOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  fileExists?: (candidate: string) => boolean;
}

export interface LiteLLMCommand {
  command: string;
  shell: boolean;
}

/**
 * Scan a directory for Python3XX subdirectories and return them sorted
 * by version descending (newest first), so Python 3.14 is tried before 3.13.
 */
function findPythonVersionDirs(baseDir: string, fexists: (p: string) => boolean): string[] {
  if (!fexists(baseDir)) return [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^Python3\d+$/i.test(e.name))
      .map((e) => path.join(baseDir, e.name))
      .sort()
      .reverse(); // newest version first
  } catch {
    return [];
  }
}

export function resolveLiteLLMCommand(options: ResolveLiteLLMCommandOptions = {}): LiteLLMCommand {
  const plat = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fexists = options.fileExists ?? ((p: string) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  if (plat !== "win32") {
    const pathDirs = (env.PATH ?? "").split(":");
    for (const dir of pathDirs) {
      const candidate = `${dir}/litellm`;
      if (fexists(candidate)) return { command: candidate, shell: false };
    }
    return { command: "litellm", shell: false };
  }

  // Windows: try Hiro_PYTHON_DIR env var first (user override)
  if (env.Hiro_PYTHON_DIR) {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const candidate = path.join(env.Hiro_PYTHON_DIR, "Scripts", `litellm${ext}`);
      if (fexists(candidate)) return { command: candidate, shell: ext !== ".exe" };
    }
  }

  // Dynamically scan APPDATA\Python\Python3XX\Scripts\ (covers 3.13, 3.14, etc.)
  const appData = env.APPDATA;
  if (appData) {
    const pythonBase = path.join(appData, "Python");
    for (const versionDir of findPythonVersionDirs(pythonBase, fexists)) {
      for (const ext of [".exe", ".cmd", ".bat"]) {
        const candidate = path.join(versionDir, "Scripts", `litellm${ext}`);
        if (fexists(candidate)) return { command: candidate, shell: ext !== ".exe" };
      }
    }
    // Also try APPDATA\Python\Scripts (flat layout some versions use)
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const candidate = path.join(pythonBase, "Scripts", `litellm${ext}`);
      if (fexists(candidate)) return { command: candidate, shell: ext !== ".exe" };
    }
  }

  // Dynamically scan LOCALAPPDATA\Programs\Python\Python3XX\Scripts\
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    const pythonBase = path.join(localAppData, "Programs", "Python");
    for (const versionDir of findPythonVersionDirs(pythonBase, fexists)) {
      for (const ext of [".exe", ".cmd", ".bat"]) {
        const candidate = path.join(versionDir, "Scripts", `litellm${ext}`);
        if (fexists(candidate)) return { command: candidate, shell: ext !== ".exe" };
      }
    }
  }

  // Fall back to PATH scan
  const pathDirs = (env.PATH ?? "").split(";");
  for (const dir of pathDirs) {
    for (const ext of [".exe", ".cmd", ".bat", ".ps1"]) {
      const candidate = `${dir}\\litellm${ext}`;
      if (fexists(candidate)) {
        return { command: candidate, shell: ext !== ".exe" };
      }
    }
  }

  return { command: "litellm", shell: true };
}

