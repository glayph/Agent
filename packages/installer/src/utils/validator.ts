import * as fs from "fs";
import * as path from "path";
import {
  PluginContracts,
  PluginManifest,
  PluginValidationResult,
} from "../types.js";

const RESERVED_TOOL_NAMES = new Set([
  "shell_execute",
  "file_read",
  "file_write",
  "file_delete",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_invoke",
  "browser_fill",
  "browser_press",
  "browser_extract",
  "browser_screenshot",
  "browser_scroll",
  "browser_close",
  "scrape_page",
  "scrape_selectors",
  "scrape_paginated",
  "scrape_infinite_scroll",
  "scrape_json",
  "scrape_table",
  "screen_screenshot",
  "screen_mouse_move",
  "screen_click",
  "screen_double_click",
  "screen_right_click",
  "screen_drag",
  "screen_type",
  "screen_hotkey",
  "screen_press",
  "screen_size",
  "screen_read_text",
  "screen_scroll",
  "screen_locate",
  "computer_observe",
  "computer_focus",
  "computer_invoke",
  "computer_set_text",
  "computer_hotkey",
  "computer_clipboard",
  "computer_launch",
  "computer_verify",
]);

const SEMVER_REGEX = /^\d+\.\d+\.\d+/;
const SNAKE_CASE_REGEX = /^[a-z][a-z0-9_]*$/;
const MAX_NAME_LENGTH = 64;
const MAX_VERSION_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_ENTRYPOINT_LENGTH = 512;
const MAX_PERMISSION_LENGTH = 128;
const MAX_CONTRACTS_PER_KIND = 128;
const CONTRACT_IDENTIFIER_REGEX = /^[a-z][a-z0-9_.-]{0,63}$/;
const PERMISSION_REGEX = /^[a-z][a-z0-9_.:-]{0,127}$/;
const CONTRACT_KINDS = [
  "tools",
  "channels",
  "skills",
  "providers",
  "hooks",
] as const;
type PluginBlock = NonNullable<PluginManifest["plugin"]>;
const ALLOWED_ENTRYPOINT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".mjs",
  ".py",
  ".ts",
  ".tsx",
]);

function isPathSafeSegment(value: string): boolean {
  return (
    value.trim() === value &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function resolveEntrypoint(
  filesDir: string,
  entrypoint: string,
): string | null {
  if (
    path.isAbsolute(entrypoint) ||
    entrypoint.trim() !== entrypoint ||
    entrypoint.length > MAX_ENTRYPOINT_LENGTH ||
    /[\0\r\n]/.test(entrypoint)
  ) {
    return null;
  }

  const baseDir = path.resolve(filesDir);
  const resolved = path.resolve(baseDir, entrypoint);
  const relative = path.relative(baseDir, resolved);

  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  return resolved;
}

async function isRealPathInside(baseDir: string, targetPath: string) {
  try {
    const [baseReal, targetReal] = await Promise.all([
      fs.promises.realpath(baseDir),
      fs.promises.realpath(targetPath),
    ]);
    const relative = path.relative(baseReal, targetReal);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  } catch {
    return false;
  }
}

function stringField(
  manifest: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof manifest[key] === "string"
    ? (manifest[key] as string)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePermissionList(
  value: unknown,
  errors: string[],
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of permission strings`);
    return undefined;
  }

  const permissions: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (
      typeof item !== "string" ||
      item.trim() !== item ||
      item.length === 0 ||
      item.length > MAX_PERMISSION_LENGTH ||
      !PERMISSION_REGEX.test(item)
    ) {
      errors.push(
        `${label}[${index}] must be a lowercase permission token such as "network.http"`,
      );
      continue;
    }
    if (seen.has(item)) {
      errors.push(`${label} contains duplicate permission "${item}"`);
      continue;
    }
    seen.add(item);
    permissions.push(item);
  }

  return permissions;
}

async function validateEntrypointPath(
  filesDir: string,
  entrypoint: string,
  errors: string[],
  label: string,
): Promise<void> {
  const entryPath = resolveEntrypoint(filesDir, entrypoint);
  if (!entryPath) {
    errors.push(
      `${label} "${entrypoint}" must be a relative path inside the plugin files directory`,
    );
    return;
  }

  const extension = path.extname(entryPath).toLowerCase();
  if (!ALLOWED_ENTRYPOINT_EXTENSIONS.has(extension)) {
    errors.push(
      `${label} "${entrypoint}" must use one of: ${Array.from(
        ALLOWED_ENTRYPOINT_EXTENSIONS,
      )
        .sort()
        .join(", ")}`,
    );
  }

  try {
    const stat = await fs.promises.stat(entryPath);
    if (!stat.isFile()) {
      errors.push(`${label} "${entrypoint}" is not a file`);
    } else if (!(await isRealPathInside(filesDir, entryPath))) {
      errors.push(
        `${label} "${entrypoint}" must resolve inside the plugin files directory`,
      );
    }
  } catch {
    errors.push(`${label} "${entrypoint}" does not exist at "${entryPath}"`);
  }
}

async function validatePluginContracts(
  value: unknown,
  filesDir: string,
  errors: string[],
  label: string,
): Promise<PluginContracts | undefined> {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }

  const contracts: PluginContracts = {};

  for (const kind of CONTRACT_KINDS) {
    const rawContracts = value[kind];
    if (rawContracts === undefined) continue;
    if (!Array.isArray(rawContracts)) {
      errors.push(`${label}.${kind} must be an array`);
      continue;
    }
    if (rawContracts.length > MAX_CONTRACTS_PER_KIND) {
      errors.push(
        `${label}.${kind} must declare ${MAX_CONTRACTS_PER_KIND} entries or fewer`,
      );
      continue;
    }

    const seen = new Set<string>();
    const parsedContracts: NonNullable<PluginContracts[typeof kind]> = [];

    for (const [index, rawContract] of rawContracts.entries()) {
      const contractLabel = `${label}.${kind}[${index}]`;
      if (!isRecord(rawContract)) {
        errors.push(`${contractLabel} must be an object`);
        continue;
      }

      const rawName = rawContract.name;
      if (
        typeof rawName !== "string" ||
        rawName.trim() !== rawName ||
        rawName.length === 0 ||
        !CONTRACT_IDENTIFIER_REGEX.test(rawName)
      ) {
        errors.push(
          `${contractLabel}.name must be a lowercase capability identifier`,
        );
        continue;
      }
      if (seen.has(rawName)) {
        errors.push(
          `${label}.${kind} contains duplicate contract "${rawName}"`,
        );
        continue;
      }
      if (kind === "tools" && RESERVED_TOOL_NAMES.has(rawName)) {
        errors.push(
          `${contractLabel}.name "${rawName}" is reserved by a built-in tool`,
        );
        continue;
      }

      seen.add(rawName);

      const parsedContract: NonNullable<PluginContracts[typeof kind]>[number] =
        {
          name: rawName,
        };

      if (rawContract.description !== undefined) {
        if (
          typeof rawContract.description !== "string" ||
          rawContract.description.length > MAX_DESCRIPTION_LENGTH
        ) {
          errors.push(
            `${contractLabel}.description must be a string ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
          );
        } else {
          parsedContract.description = rawContract.description;
        }
      }

      if (rawContract.entrypoint !== undefined) {
        if (typeof rawContract.entrypoint !== "string") {
          errors.push(`${contractLabel}.entrypoint must be a string`);
        } else {
          parsedContract.entrypoint = rawContract.entrypoint;
          await validateEntrypointPath(
            filesDir,
            rawContract.entrypoint,
            errors,
            `${contractLabel}.entrypoint`,
          );
        }
      }

      const permissions = validatePermissionList(
        rawContract.permissions,
        errors,
        `${contractLabel}.permissions`,
      );
      if (permissions) parsedContract.permissions = permissions;

      if (rawContract.configSchema !== undefined) {
        if (!isRecord(rawContract.configSchema)) {
          errors.push(`${contractLabel}.configSchema must be an object`);
        } else {
          parsedContract.configSchema = rawContract.configSchema;
        }
      }

      if (rawContract.metadata !== undefined) {
        if (!isRecord(rawContract.metadata)) {
          errors.push(`${contractLabel}.metadata must be an object`);
        } else {
          parsedContract.metadata = rawContract.metadata;
        }
      }

      parsedContracts.push(parsedContract);
    }

    contracts[kind] = parsedContracts;
  }

  return contracts;
}

export async function validatePluginManifest(
  manifest: unknown,
  filesDir: string,
): Promise<PluginValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!manifest || typeof manifest !== "object") {
    return {
      valid: false,
      errors: ["Manifest must be a non-null object"],
      warnings: [],
      manifest: null,
    };
  }

  const m = manifest as Record<string, unknown>;

  if (typeof m.name !== "string" || m.name.trim().length === 0) {
    errors.push('Manifest "name" must be a non-empty string');
  } else {
    const name = m.name as string;
    if (name.length > MAX_NAME_LENGTH) {
      errors.push(
        `Manifest "name" must be ${MAX_NAME_LENGTH} characters or fewer`,
      );
    }
    if (/[\0\r\n]/.test(name)) {
      errors.push('Manifest "name" must not contain control characters');
    }
    if (!isPathSafeSegment(name)) {
      errors.push(
        'Manifest "name" must not contain path separators or dot segments',
      );
    }
    if (!SNAKE_CASE_REGEX.test(name)) {
      warnings.push(`Manifest "name" should be snake_case (got "${m.name}")`);
    }
    if (RESERVED_TOOL_NAMES.has(name)) {
      errors.push(`Plugin name "${m.name}" is reserved by a built-in tool`);
    }
  }

  if (!m.version || typeof m.version !== "string") {
    errors.push('Manifest must have a string "version" field');
  } else {
    const version = m.version as string;
    if (version.length > MAX_VERSION_LENGTH || /[\0\r\n]/.test(version)) {
      errors.push('Manifest "version" contains invalid characters or length');
    } else if (!SEMVER_REGEX.test(version)) {
      warnings.push(
        `Version "${m.version}" does not follow semver (expected X.Y.Z)`,
      );
    }
  }

  if (!m.description || typeof m.description !== "string") {
    errors.push('Manifest must have a string "description" field');
  } else if ((m.description as string).trim().length === 0) {
    errors.push('Manifest "description" must not be empty');
  } else if ((m.description as string).length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `Manifest "description" must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
    );
  }

  const permissions = validatePermissionList(
    m.permissions,
    errors,
    'Manifest "permissions"',
  );
  const contracts = await validatePluginContracts(
    m.contracts,
    filesDir,
    errors,
    'Manifest "contracts"',
  );

  let entrypoint: string | undefined;
  let plugin: PluginManifest["plugin"] | undefined;
  if (m.plugin !== undefined && (!m.plugin || typeof m.plugin !== "object")) {
    errors.push('Manifest "plugin" must be an object when provided');
  } else if (m.plugin && typeof m.plugin === "object") {
    const pluginBlock = m.plugin as Record<string, unknown>;
    if (
      pluginBlock.entrypoint !== undefined &&
      typeof pluginBlock.entrypoint !== "string"
    ) {
      errors.push('Manifest "plugin.entrypoint" must be a string');
    } else if (typeof pluginBlock.entrypoint === "string") {
      entrypoint = pluginBlock.entrypoint;
    }
    plugin = {
      entrypoint: stringField(pluginBlock, "entrypoint"),
      hooks: pluginBlock.hooks as PluginBlock["hooks"] | undefined,
      dependencies: pluginBlock.dependencies as
        | PluginBlock["dependencies"]
        | undefined,
      permissions: validatePermissionList(
        pluginBlock.permissions,
        errors,
        'Manifest "plugin.permissions"',
      ),
      contracts: await validatePluginContracts(
        pluginBlock.contracts,
        filesDir,
        errors,
        'Manifest "plugin.contracts"',
      ),
    };
  }
  if (!entrypoint && m.main && typeof m.main === "string") {
    entrypoint = m.main;
  }

  if (entrypoint) {
    await validateEntrypointPath(filesDir, entrypoint, errors, "Entrypoint");
  } else {
    warnings.push("No entrypoint specified — using default execute() stub");
  }

  const extractedManifest: PluginManifest = {
    name: stringField(m, "name") || "",
    version: stringField(m, "version") || "0.0.0",
    description: stringField(m, "description") || "",
    author: stringField(m, "author"),
    license: stringField(m, "license"),
    main: stringField(m, "main"),
    permissions,
    contracts,
    plugin,
  };

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifest: extractedManifest,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// EXTENSION POINT — Adding new validation rules
// ═══════════════════════════════════════════════════════════════════════
// Add new checks inside validatePluginManifest before the return statement.
// Push string messages to errors[] (fatal) or warnings[] (non-fatal).
// ═══════════════════════════════════════════════════════════════════════
