import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as yaml from "js-yaml";
import { type RuntimePaths } from "../paths.js";
import {
  DEFAULT_RULES_FILES,
  defaultWorkspaceFoldersConfig,
  type WorkspaceFolder,
  type WorkspaceFoldersConfig,
} from "./types.js";

function configPath(runtimePaths: RuntimePaths): string {
  return path.join(runtimePaths.configDir, "workspace-folders.yaml");
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeFolderInput(
  input: Partial<WorkspaceFolder> & { path: string },
  existing?: WorkspaceFolder,
): WorkspaceFolder {
  const now = new Date().toISOString();
  const resolved = path.resolve(input.path);
  const label =
    (input.label && input.label.trim()) ||
    existing?.label ||
    path.basename(resolved) ||
    resolved;
  const rulesFiles =
    Array.isArray(input.rulesFiles) && input.rulesFiles.length > 0
      ? uniqueStrings(input.rulesFiles)
      : existing?.rulesFiles?.length
        ? existing.rulesFiles
        : [...DEFAULT_RULES_FILES];

  return {
    id: existing?.id || input.id || crypto.randomUUID(),
    path: resolved,
    label,
    enabled: input.enabled ?? existing?.enabled ?? true,
    index: input.index ?? existing?.index ?? true,
    restrictDefault:
      input.restrictDefault ?? existing?.restrictDefault ?? false,
    rulesFiles,
    notes: input.notes ?? existing?.notes,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [
    ...new Set(
      values
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeConfig(raw: unknown): WorkspaceFoldersConfig {
  const base = defaultWorkspaceFoldersConfig();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  const foldersRaw = Array.isArray(obj.folders) ? obj.folders : [];
  const folders: WorkspaceFolder[] = [];
  for (const item of foldersRaw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    if (typeof f.path !== "string" || !f.path.trim()) continue;
    folders.push(
      normalizeFolderInput({
        id: typeof f.id === "string" ? f.id : undefined,
        path: f.path,
        label: typeof f.label === "string" ? f.label : undefined,
        enabled: typeof f.enabled === "boolean" ? f.enabled : true,
        index: typeof f.index === "boolean" ? f.index : true,
        restrictDefault:
          typeof f.restrictDefault === "boolean" ? f.restrictDefault : false,
        rulesFiles: Array.isArray(f.rulesFiles)
          ? (f.rulesFiles as string[])
          : undefined,
        notes: typeof f.notes === "string" ? f.notes : undefined,
        createdAt: typeof f.createdAt === "string" ? f.createdAt : undefined,
        updatedAt: typeof f.updatedAt === "string" ? f.updatedAt : undefined,
      } as Partial<WorkspaceFolder> & { path: string }),
    );
  }
  return {
    schemaVersion: 1,
    indexOnlyConfigured:
      typeof obj.indexOnlyConfigured === "boolean"
        ? obj.indexOnlyConfigured
        : true,
    folders,
  };
}

export function loadWorkspaceFolders(
  runtimePaths: RuntimePaths,
): WorkspaceFoldersConfig {
  const file = configPath(runtimePaths);
  if (!fs.existsSync(file)) {
    const cfg = defaultWorkspaceFoldersConfig();
    saveWorkspaceFolders(runtimePaths, cfg);
    return cfg;
  }
  try {
    const raw = yaml.load(fs.readFileSync(file, "utf-8"));
    return normalizeConfig(raw);
  } catch {
    return defaultWorkspaceFoldersConfig();
  }
}

export function saveWorkspaceFolders(
  runtimePaths: RuntimePaths,
  config: WorkspaceFoldersConfig,
): void {
  const file = configPath(runtimePaths);
  ensureDir(file);
  const normalized = normalizeConfig(config);
  fs.writeFileSync(
    file,
    yaml.dump(normalized, { lineWidth: 120, noRefs: true }),
    "utf-8",
  );
}

export function listEnabledFolders(
  runtimePaths: RuntimePaths,
): WorkspaceFolder[] {
  return loadWorkspaceFolders(runtimePaths).folders.filter((f) => f.enabled);
}

export function listIndexRoots(runtimePaths: RuntimePaths): string[] {
  const cfg = loadWorkspaceFolders(runtimePaths);
  if (!cfg.indexOnlyConfigured) {
    // Fallback: all enabled folders still preferred; system indexer may add more
    return cfg.folders.filter((f) => f.enabled && f.index).map((f) => f.path);
  }
  return cfg.folders.filter((f) => f.enabled && f.index).map((f) => f.path);
}

export function findFolderForPath(
  runtimePaths: RuntimePaths,
  targetPath: string,
): WorkspaceFolder | null {
  const resolved = path.resolve(targetPath);
  const folders = listEnabledFolders(runtimePaths);
  // Longest path match wins (most specific folder)
  let best: WorkspaceFolder | null = null;
  let bestLen = -1;
  for (const folder of folders) {
    const root = path.resolve(folder.path);
    const rel = path.relative(root, resolved);
    const inside =
      rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (inside && root.length > bestLen) {
      best = folder;
      bestLen = root.length;
    }
  }
  return best;
}

export function isPathRestrictedByDefault(
  runtimePaths: RuntimePaths,
  targetPath: string,
): boolean {
  const folder = findFolderForPath(runtimePaths, targetPath);
  if (!folder) {
    // Outside configured folders: restricted for proactive work/index when
    // indexOnlyConfigured is true — user must explicitly ask.
    const cfg = loadWorkspaceFolders(runtimePaths);
    return cfg.indexOnlyConfigured;
  }
  return folder.restrictDefault === true;
}

export function addWorkspaceFolder(
  runtimePaths: RuntimePaths,
  input: {
    path: string;
    label?: string;
    index?: boolean;
    restrictDefault?: boolean;
    rulesFiles?: string[];
    notes?: string;
  },
): WorkspaceFolder {
  const cfg = loadWorkspaceFolders(runtimePaths);
  const resolved = path.resolve(input.path);
  const existing = cfg.folders.find((f) => path.resolve(f.path) === resolved);
  if (existing) {
    const updated = normalizeFolderInput(
      { ...existing, ...input, path: resolved },
      existing,
    );
    cfg.folders = cfg.folders.map((f) => (f.id === existing.id ? updated : f));
    saveWorkspaceFolders(runtimePaths, cfg);
    return updated;
  }
  const folder = normalizeFolderInput({
    path: resolved,
    label: input.label,
    index: input.index,
    restrictDefault: input.restrictDefault,
    rulesFiles: input.rulesFiles,
    notes: input.notes,
  });
  cfg.folders.push(folder);
  saveWorkspaceFolders(runtimePaths, cfg);
  return folder;
}

export function updateWorkspaceFolder(
  runtimePaths: RuntimePaths,
  id: string,
  patch: Partial<WorkspaceFolder>,
): WorkspaceFolder | null {
  const cfg = loadWorkspaceFolders(runtimePaths);
  const idx = cfg.folders.findIndex((f) => f.id === id);
  if (idx < 0) return null;
  const current = cfg.folders[idx]!;
  const updated = normalizeFolderInput(
    {
      ...current,
      ...patch,
      path: patch.path ? path.resolve(patch.path) : current.path,
    },
    current,
  );
  cfg.folders[idx] = updated;
  saveWorkspaceFolders(runtimePaths, cfg);
  return updated;
}

export function removeWorkspaceFolder(
  runtimePaths: RuntimePaths,
  id: string,
): boolean {
  const cfg = loadWorkspaceFolders(runtimePaths);
  const before = cfg.folders.length;
  cfg.folders = cfg.folders.filter((f) => f.id !== id);
  if (cfg.folders.length === before) return false;
  saveWorkspaceFolders(runtimePaths, cfg);
  return true;
}

export function setIndexOnlyConfigured(
  runtimePaths: RuntimePaths,
  value: boolean,
): WorkspaceFoldersConfig {
  const cfg = loadWorkspaceFolders(runtimePaths);
  cfg.indexOnlyConfigured = value;
  saveWorkspaceFolders(runtimePaths, cfg);
  return cfg;
}
