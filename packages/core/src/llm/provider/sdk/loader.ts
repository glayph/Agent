import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MIKI_PROVIDER_PLUGIN_API_VERSION,
  type MikiProviderManifest,
  type MikiProviderPlugin,
  type ProviderManifestValidation,
  type ProviderPluginDescriptor,
} from "./index.js";

const ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const ALLOWED_PERMISSIONS = new Set([
  "network",
  "filesystem",
  "shell",
  "secrets",
]);
const ENTRYPOINT_PATTERN = /^[^/\\][^:]*\.(?:mjs|cjs|js)$/i;

type PluginSource = "builtin" | "external";

export interface ProviderPluginLoaderOptions {
  builtinDirectories?: string[];
  externalDirectory?: string;
  allowExternal?: boolean;
  allowedExternalPermissions?: Array<
    "network" | "filesystem" | "shell" | "secrets"
  >;
  mikiVersion?: string;
  pluginApiVersion?: string;
}

export interface ProviderManifestRecord {
  directory: string;
  manifestPath: string;
  manifest: MikiProviderManifest;
  source: PluginSource;
  descriptor: ProviderPluginDescriptor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean";
}

function semverParts(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function apiMajor(value: string): number | null {
  const match = /^(?:v)?(\d+)(?:\.|$)/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function validateProviderManifest(
  input: unknown,
  options: {
    source?: PluginSource;
    mikiVersion?: string;
    pluginApiVersion?: string;
    allowedExternalPermissions?: string[];
  } = {},
): ProviderManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(input))
    return { valid: false, errors: ["manifest must be an object"], warnings };

  const id = stringValue(input.id);
  const displayName = stringValue(input.displayName);
  const version = stringValue(input.version);
  const pluginApiVersion = stringValue(input.pluginApiVersion);
  if (!ID_PATTERN.test(id))
    errors.push("id must match /^[a-z][a-z0-9_-]{1,63}$/");
  if (!displayName) errors.push("displayName is required");
  if (!semverParts(version))
    errors.push("version must be semantic version x.y.z");
  if (apiMajor(pluginApiVersion) === null)
    errors.push("pluginApiVersion is required");
  if (
    apiMajor(pluginApiVersion) !==
    apiMajor(options.pluginApiVersion || MIKI_PROVIDER_PLUGIN_API_VERSION)
  ) {
    errors.push(
      "pluginApiVersion is incompatible with this Agent Miki runtime",
    );
  }

  const capabilities = input.capabilities;
  if (!isRecord(capabilities)) {
    errors.push("capabilities is required");
  } else {
    for (const key of ["chat", "tools", "streaming", "vision", "local"]) {
      if (!booleanValue(capabilities[key]))
        errors.push(`capabilities.${key} must be boolean`);
    }
  }

  if (input.entrypoint !== undefined) {
    const entrypoint = stringValue(input.entrypoint);
    if (!ENTRYPOINT_PATTERN.test(entrypoint) || entrypoint.includes("..")) {
      errors.push(
        "entrypoint must be a relative .js/.mjs/.cjs path without traversal",
      );
    }
  }
  if (input.minMikiVersion !== undefined) {
    const required = semverParts(stringValue(input.minMikiVersion));
    const current = semverParts(
      options.mikiVersion || process.env.MIKI_VERSION || "1.3.3",
    );
    if (!required) errors.push("minMikiVersion must be semantic version x.y.z");
    else if (current && required[0] > current[0])
      errors.push("minMikiVersion is newer than this Agent Miki runtime");
    else if (current && required[0] === current[0] && required[1] > current[1])
      warnings.push("plugin requires a newer minor Agent Miki version");
  }

  if (
    input.modelPrefixes !== undefined &&
    (!Array.isArray(input.modelPrefixes) ||
      input.modelPrefixes.some((item) => typeof item !== "string"))
  ) {
    errors.push("modelPrefixes must be an array of strings");
  }
  if (
    input.modelIds !== undefined &&
    (!Array.isArray(input.modelIds) ||
      input.modelIds.some((item) => typeof item !== "string"))
  ) {
    errors.push("modelIds must be an array of strings");
  }
  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions))
      errors.push("permissions must be an array");
    else {
      for (const permission of input.permissions) {
        if (
          typeof permission !== "string" ||
          !ALLOWED_PERMISSIONS.has(permission)
        )
          errors.push(`unsupported permission: ${String(permission)}`);
        if (
          options.source === "external" &&
          !(options.allowedExternalPermissions || ["network"]).includes(
            String(permission),
          )
        ) {
          errors.push(
            `external permission is not allowed: ${String(permission)}`,
          );
        }
      }
    }
  }
  if (options.source === "external" && input.entrypoint && !input.permissions)
    warnings.push(
      "external executable plugin declares no permissions; it will remain policy-blocked",
    );
  return { valid: errors.length === 0, errors, warnings };
}

function manifestFromJson(
  input: Record<string, unknown>,
): MikiProviderManifest {
  return {
    id: stringValue(input.id),
    displayName: stringValue(input.displayName),
    version: stringValue(input.version),
    pluginApiVersion: stringValue(input.pluginApiVersion),
    minMikiVersion: stringValue(input.minMikiVersion) || undefined,
    entrypoint: stringValue(input.entrypoint) || undefined,
    capabilities: input.capabilities as MikiProviderManifest["capabilities"],
    modelPrefixes: Array.isArray(input.modelPrefixes)
      ? input.modelPrefixes.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined,
    modelIds: Array.isArray(input.modelIds)
      ? input.modelIds.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined,
    permissions: Array.isArray(input.permissions)
      ? input.permissions.filter(
          (item): item is MikiProviderManifest["permissions"][number] =>
            typeof item === "string",
        )
      : undefined,
  };
}

export class ProviderPluginLoader {
  private readonly options: Required<
    Pick<
      ProviderPluginLoaderOptions,
      "allowExternal" | "mikiVersion" | "pluginApiVersion"
    >
  > &
    ProviderPluginLoaderOptions;

  constructor(options: ProviderPluginLoaderOptions = {}) {
    this.options = {
      ...options,
      allowExternal: options.allowExternal === true,
      mikiVersion: options.mikiVersion || process.env.MIKI_VERSION || "1.3.3",
      pluginApiVersion:
        options.pluginApiVersion || MIKI_PROVIDER_PLUGIN_API_VERSION,
    };
  }

  discover(): ProviderManifestRecord[] {
    const records: ProviderManifestRecord[] = [];
    const seen = new Set<string>();
    const roots: Array<{ directory: string; source: PluginSource }> = [];
    for (const directory of this.options.builtinDirectories || [])
      roots.push({ directory, source: "builtin" });
    if (this.options.externalDirectory && this.options.allowExternal)
      roots.push({
        directory: this.options.externalDirectory,
        source: "external",
      });

    for (const root of roots) {
      if (
        !fs.existsSync(root.directory) ||
        !fs.statSync(root.directory).isDirectory()
      )
        continue;
      const entries = fs.readdirSync(root.directory, { withFileTypes: true });
      for (const entry of entries) {
        const directory = entry.isDirectory()
          ? path.join(root.directory, entry.name)
          : root.directory;
        const manifestPath = entry.isDirectory()
          ? path.join(directory, "miki.provider.json")
          : path.join(root.directory, "miki.provider.json");
        if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile())
          continue;
        try {
          const raw = JSON.parse(
            fs.readFileSync(manifestPath, "utf8"),
          ) as unknown;
          const validation = validateProviderManifest(raw, {
            source: root.source,
            mikiVersion: this.options.mikiVersion,
            pluginApiVersion: this.options.pluginApiVersion,
            allowedExternalPermissions: this.options.allowedExternalPermissions,
          });
          const manifest = isRecord(raw)
            ? manifestFromJson(raw)
            : manifestFromJson({});
          const duplicate = seen.has(manifest.id);
          if (duplicate) {
            records.push({
              directory,
              manifestPath,
              manifest,
              source: root.source,
              descriptor: {
                manifest,
                auth: { mode: "placeholder", allowEmptyKey: false },
                source: root.source,
                readiness: "rejected",
                reason: "duplicate provider id",
              },
            });
            continue;
          }
          seen.add(manifest.id);
          records.push({
            directory,
            manifestPath,
            manifest,
            source: root.source,
            descriptor: {
              manifest,
              auth: {
                mode: manifest.capabilities.local ? "local" : "placeholder",
                allowEmptyKey: manifest.capabilities.local,
              },
              source: root.source,
              readiness: validation.valid
                ? manifest.entrypoint
                  ? "ready"
                  : "metadata_only"
                : "rejected",
              reason: validation.valid
                ? validation.warnings.join(" ") || undefined
                : validation.errors.join(" "),
            },
          });
        } catch (error) {
          records.push({
            directory,
            manifestPath,
            manifest: manifestFromJson({}),
            source: root.source,
            descriptor: {
              manifest: manifestFromJson({}),
              auth: { mode: "placeholder", allowEmptyKey: false },
              source: root.source,
              readiness: "rejected",
              reason:
                error instanceof Error
                  ? `invalid manifest: ${error.message}`
                  : "invalid manifest",
            },
          });
        }
      }
    }
    return records;
  }

  async load(record: ProviderManifestRecord): Promise<MikiProviderPlugin> {
    if (record.source === "external") {
      throw new Error(
        "external provider entrypoints require the bounded runtime-contract executor",
      );
    }
    if (record.descriptor.readiness !== "ready" || !record.manifest.entrypoint)
      throw new Error(
        record.descriptor.reason || "provider plugin is not ready",
      );
    const entrypoint = path.resolve(
      record.directory,
      record.manifest.entrypoint,
    );
    if (!isPathInside(record.directory, entrypoint))
      throw new Error("provider entrypoint escapes its manifest directory");
    if (!fs.existsSync(entrypoint) || !fs.statSync(entrypoint).isFile())
      throw new Error("provider entrypoint is missing");
    const imported = await import(pathToFileURL(entrypoint).href);
    const plugin = (imported.default ||
      imported.plugin ||
      imported.providerPlugin) as MikiProviderPlugin;
    if (
      !plugin ||
      plugin.manifest?.id !== record.manifest.id ||
      typeof plugin.complete !== "function" ||
      typeof plugin.catalog !== "function"
    ) {
      throw new Error(
        "provider entrypoint must export a compatible MikiProviderPlugin",
      );
    }
    return plugin;
  }
}
