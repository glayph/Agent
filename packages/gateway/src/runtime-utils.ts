import { pathToFileURL } from "url";

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

export function resolveLiteLLMCommand(options: ResolveLiteLLMCommandOptions = {}): LiteLLMCommand {
  const plat = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fexists = options.fileExists ?? ((p: string) => {
    try {
      return require("fs").existsSync(p);
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

  const appData = env.APPDATA;
  if (appData) {
    const candidate = `${appData}\\Python\\Python313\\Scripts\\litellm.exe`;
    if (fexists(candidate)) return { command: candidate, shell: false };
  }

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
