import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  SourceProtocol,
  ParsedSkillSpec,
  PluginDownloadResult,
  PluginManifest,
} from "./types.js";
import { downloadFile, downloadJson } from "./utils/downloader.js";
import { extractTarGz, findManifest } from "./utils/extractor.js";
import {
  assertNoPathSegments,
  safeTempName,
  validateGitBranchName,
  validateNpmPackageName,
} from "./utils/source-safety.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CLAWHUB_REGISTRY = "https://clawhub.local/api";

interface ClawhubPackageResponse {
  name: string;
  version: string;
  description: string;
  downloadUrl: string;
  author?: string;
  license?: string;
  manifest?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (item): item is string => typeof item === "string" && item.trim() === item,
  );
  return values.length === value.length ? values : undefined;
}

function providerManifestToPlugin(
  raw: Record<string, unknown>,
): PluginManifest | null {
  const id = stringValue(raw.id);
  const displayName = stringValue(raw.displayName) || stringValue(raw.name);
  const version = stringValue(raw.version);
  if (!id || !displayName || !version) return null;

  const permissions = stringArray(raw.permissions);
  const entrypoint = stringValue(raw.entrypoint);
  const metadata: Record<string, unknown> = {
    id,
    display_name: displayName,
    ...(stringValue(raw.baseUrl) ? { base_url: stringValue(raw.baseUrl) } : {}),
    ...(stringValue(raw.apiKeyEnv)
      ? { api_key_env: stringValue(raw.apiKeyEnv) }
      : {}),
    ...(typeof raw.local === "boolean" ? { local: raw.local } : {}),
    ...(typeof raw.supportsFetch === "boolean"
      ? { supports_fetch: raw.supportsFetch }
      : {}),
    ...(stringValue(raw.authMethod)
      ? { auth_method: stringValue(raw.authMethod) }
      : {}),
    ...(stringArray(raw.modelIds) ? { models: stringArray(raw.modelIds) } : {}),
    ...(stringArray(raw.secretFields)
      ? { secret_fields: stringArray(raw.secretFields) }
      : {}),
    capabilities: isRecord(raw.capabilities) ? raw.capabilities : {},
    plugin_api_version: stringValue(raw.pluginApiVersion) || "1.0",
  };

  return {
    name: id,
    version,
    description: displayName,
    permissions,
    plugin: {
      entrypoint,
      permissions,
      contracts: {
        providers: [
          {
            name: id,
            description: displayName,
            entrypoint,
            permissions,
            metadata,
          },
        ],
      },
    },
  };
}

function normalizeGitUrl(raw: string): string {
  if (raw.startsWith("git://") || raw.startsWith("http://"))
    throw new Error("Git source URLs must use https:// or ssh://");
  if (raw.startsWith("https://") || raw.startsWith("ssh://")) return raw;
  if (/^[\w.-]+@[\w.-]+:/.test(raw)) return raw;
  if (raw.includes("github.com") || raw.includes("gitlab.com"))
    return `https://${raw}`;
  return `https://${raw}`;
}

async function buildManifest(
  found: { manifest: unknown; filePath?: string } | null,
  fallback: Partial<PluginManifest>,
  _destDir: string,
): Promise<{
  manifest: PluginManifest;
  entrypoint: string;
  manifestFormat?: "plugin.json" | "package.json" | "miki.provider.json";
}> {
  let manifest: PluginManifest;
  let manifestFormat:
    "plugin.json" | "package.json" | "miki.provider.json" | undefined;
  if (found) {
    const raw = isRecord(found.manifest) ? found.manifest : {};
    manifestFormat = path.basename(
      found.filePath || "",
    ) as typeof manifestFormat;
    const providerManifest =
      manifestFormat === "miki.provider.json"
        ? providerManifestToPlugin(raw)
        : null;
    manifest = providerManifest || {
      name: (raw.name as string) || fallback.name || "",
      version: (raw.version as string) || fallback.version || "0.0.0",
      description: (raw.description as string) || fallback.description || "",
      author: (raw.author as string) || fallback.author,
      license: (raw.license as string) || fallback.license,
      main: (raw.main as string) || undefined,
      permissions: raw.permissions as PluginManifest["permissions"],
      contracts: raw.contracts as PluginManifest["contracts"],
      plugin: raw.plugin as PluginManifest["plugin"],
    };
  } else {
    manifest = {
      name: fallback.name || "",
      version: fallback.version || "0.0.0",
      description: fallback.description || "",
      author: fallback.author,
      license: fallback.license,
      permissions: fallback.permissions,
    };
  }
  const entrypoint =
    manifest.plugin?.entrypoint ||
    manifest.main ||
    (manifestFormat === "miki.provider.json" ? "" : `${manifest.name}.ts`);
  return { manifest, entrypoint, manifestFormat };
}

async function fetchGit(
  spec: ParsedSkillSpec,
  destDir: string,
): Promise<PluginDownloadResult> {
  const repoUrl = normalizeGitUrl(spec.packageName);
  const cloneDir = path.join(
    os.tmpdir(),
    `git-clone-${safeTempName(spec.packageName)}-${randomUUID()}`,
  );
  await fs.promises.mkdir(cloneDir, { recursive: true });
  try {
    const args = ["clone", "--depth", "1"];
    if (spec.branch) {
      validateGitBranchName(spec.branch);
      args.push("--branch", spec.branch);
    }
    args.push(repoUrl, cloneDir);
    await execFileAsync("git", args, { shell: false, timeout: 120000 });
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.cp(cloneDir, destDir, {
      recursive: true,
      force: true,
      filter: (src: string) => path.basename(src) !== ".git",
    });
    const found = await findManifest(destDir);
    if (!found)
      throw new Error(
        `No plugin.json, miki.provider.json, or package.json found in git repo "${spec.packageName}"`,
      );
    const { manifest, entrypoint, manifestFormat } = await buildManifest(
      found,
      { name: path.basename(repoUrl).replace(/\.git$/, "") },
      destDir,
    );
    return { manifest, filesDir: destDir, entrypoint, manifestFormat };
  } finally {
    fs.promises.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchNpm(
  spec: ParsedSkillSpec,
  destDir: string,
): Promise<PluginDownloadResult> {
  validateNpmPackageName(spec.packageName);
  const tmpDir = path.join(
    os.tmpdir(),
    `npm-${safeTempName(spec.packageName)}-${randomUUID()}`,
  );
  await fs.promises.mkdir(tmpDir, { recursive: true });
  try {
    const pkgSpec = spec.version
      ? `${spec.packageName}@${spec.version}`
      : spec.packageName;
    await execFileAsync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", pkgSpec, "--pack-destination", tmpDir],
      { shell: false, timeout: 60000 },
    );
    const files = await fs.promises.readdir(tmpDir);
    const tgzFile = files.find((f) => f.endsWith(".tgz"));
    if (!tgzFile)
      throw new Error(`npm pack did not produce a .tgz file for "${pkgSpec}"`);
    await fs.promises.mkdir(destDir, { recursive: true });
    await extractTarGz(path.join(tmpDir, tgzFile), destDir, {
      stripComponents: 1,
    });
    const found = await findManifest(destDir);
    if (!found)
      throw new Error(
        `No package.json, plugin.json, or miki.provider.json found in npm package "${pkgSpec}"`,
      );
    const { manifest, entrypoint, manifestFormat } = await buildManifest(
      found,
      { name: spec.packageName },
      destDir,
    );
    return { manifest, filesDir: destDir, entrypoint, manifestFormat };
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchLocal(
  spec: ParsedSkillSpec,
  destDir: string,
): Promise<PluginDownloadResult> {
  const sourcePath = path.resolve(spec.packageName);
  const stat = await fs.promises.stat(sourcePath).catch(() => {
    throw new Error(`Local path does not exist: "${spec.packageName}"`);
  });
  if (!stat.isDirectory())
    throw new Error(`Local path is not a directory: "${spec.packageName}"`);
  await fs.promises.mkdir(destDir, { recursive: true });
  try {
    await fs.promises.cp(sourcePath, destDir, {
      recursive: true,
      force: true,
      filter: (src: string) => {
        const base = path.basename(src);
        return base !== "node_modules" && base !== ".git";
      },
    });
  } catch (cpErr) {
    await fs.promises
      .rm(destDir, { recursive: true, force: true })
      .catch(() => {});
    throw new Error(
      `Failed to copy plugin from "${spec.packageName}": ${cpErr instanceof Error ? cpErr.message : String(cpErr)}`,
    );
  }
  const found = await findManifest(destDir);
  if (!found)
    throw new Error(
      `No plugin.json, miki.provider.json, or package.json found in local path "${spec.packageName}"`,
    );
  const { manifest, entrypoint, manifestFormat } = await buildManifest(
    found,
    { name: path.basename(sourcePath) },
    destDir,
  );
  return { manifest, filesDir: destDir, entrypoint, manifestFormat };
}

async function fetchClawhub(
  spec: ParsedSkillSpec,
  destDir: string,
  registryUrl?: string,
): Promise<PluginDownloadResult> {
  const regUrl =
    registryUrl || process.env["CLAWHUB_REGISTRY"] || DEFAULT_CLAWHUB_REGISTRY;
  assertNoPathSegments(spec.packageName, "Clawhub package name");
  const tmpDir = path.join(
    os.tmpdir(),
    `clawhub-${safeTempName(spec.packageName)}-${randomUUID()}`,
  );
  await fs.promises.mkdir(tmpDir, { recursive: true });
  try {
    const pkgInfo = await downloadJson<ClawhubPackageResponse>(
      `${regUrl}/packages/${encodeURIComponent(spec.packageName)}`,
      {
        headers: { Accept: "application/json" },
        allowHttp: process.env["CLAWHUB_ALLOW_HTTP"] === "true",
      },
    );
    if (!pkgInfo || typeof pkgInfo.name !== "string" || !pkgInfo.name)
      throw new Error(
        `Invalid response from registry for package "${spec.packageName}"`,
      );
    if (typeof pkgInfo.downloadUrl !== "string" || !pkgInfo.downloadUrl)
      throw new Error(
        `No download URL returned for package "${spec.packageName}"`,
      );
    const archivePath = path.join(tmpDir, "package.tgz");
    await downloadFile(pkgInfo.downloadUrl, archivePath, {
      allowHttp: process.env["CLAWHUB_ALLOW_HTTP"] === "true",
    });
    await fs.promises.mkdir(destDir, { recursive: true });
    await extractTarGz(archivePath, destDir, { stripComponents: 1 });
    const found = await findManifest(destDir);
    const { manifest, entrypoint, manifestFormat } = await buildManifest(
      found,
      pkgInfo,
      destDir,
    );
    return { manifest, filesDir: destDir, entrypoint, manifestFormat };
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function fetchSkill(
  protocol: SourceProtocol,
  spec: ParsedSkillSpec,
  destDir: string,
  options?: { clawhubRegistryUrl?: string },
): Promise<PluginDownloadResult> {
  if (
    typeof spec.packageName !== "string" ||
    spec.packageName.trim().length === 0
  ) {
    throw new Error(`Package name is required for ${protocol} source`);
  }
  switch (protocol) {
    case SourceProtocol.GIT:
      return fetchGit(spec, destDir);
    case SourceProtocol.NPM:
      return fetchNpm(spec, destDir);
    case SourceProtocol.LOCAL:
      return fetchLocal(spec, destDir);
    case SourceProtocol.CLAWHUB:
      return fetchClawhub(spec, destDir, options?.clawhubRegistryUrl);
    default:
      throw new Error(`Unknown source protocol: ${protocol}`);
  }
}
