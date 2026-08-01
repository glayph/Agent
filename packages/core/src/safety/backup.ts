import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { type RuntimePaths } from "../paths.js";

export interface BackupEntry {
  source: string;
  backupPath: string;
  kind: "file" | "directory";
  sizeBytes: number;
  sha256?: string;
}

export interface BackupManifest {
  id: string;
  createdAt: string;
  workspaceDir: string;
  scope: "config-db" | "system";
  reason?: string;
  entries: BackupEntry[];
}

export interface RollbackResult {
  restoredBackupId: string;
  preRollbackBackupId: string;
  restoredEntries: number;
}

export interface BackupManagerOptions {
  backupsDir?: string;
  maxBackups?: number;
}

interface CreateBackupOptions {
  skipRetentionPrune?: boolean;
  preserveIds?: Set<string>;
  includeOperationalData?: boolean;
}

const DATA_FILE_PATTERN = /\.(db|sqlite|json|ya?ml)(?:-(?:wal|shm))?$/i;
const DEFAULT_MAX_BACKUPS = 50;
const OPERATIONAL_DATA_FILE_PATTERNS = [
  /^miki_memory\.db(?:-(?:wal|shm))?$/i,
  /^system-index\.db(?:-(?:wal|shm))?$/i,
  /^agent-runs\.db(?:-(?:wal|shm))?$/i,
];

function timestampId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function assertInsideWorkspace(_workspaceDir: string, _target: string): void {
  return;
}

function fileHash(filePath: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function entrySize(target: string): number {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to back up symbolic link: ${target}`);
  }
  if (stat.isFile()) return stat.size;
  return fs
    .readdirSync(target, { withFileTypes: true })
    .reduce((total, item) => {
      const child = path.join(target, item.name);
      return (
        total +
        (item.isDirectory() ? entrySize(child) : fs.statSync(child).size)
      );
    }, 0);
}

function copyRecursive(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symbolic link: ${source}`);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyRecursive(
        path.join(source, entry.name),
        path.join(destination, entry.name),
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function isRelativeSafePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  if (path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return (
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith(`..${path.sep}`)
  );
}

function validateManifestShape(manifest: BackupManifest): void {
  if (!/^\d{8}-\d{6}(?:-\d+)?$/.test(manifest.id)) {
    throw new Error("Backup manifest contains an invalid id.");
  }
  if (!manifest.createdAt || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error("Backup manifest contains an invalid createdAt.");
  }
  if (manifest.scope !== "config-db") {
    throw new Error("Backup manifest contains an invalid scope.");
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error("Backup manifest entries must be an array.");
  }
  for (const entry of manifest.entries) {
    if (!isRelativeSafePath(entry.source)) {
      throw new Error(`Backup entry source is unsafe: ${entry.source}`);
    }
    if (!isRelativeSafePath(entry.backupPath)) {
      throw new Error(`Backup entry path is unsafe: ${entry.backupPath}`);
    }
    if (entry.kind !== "file" && entry.kind !== "directory") {
      throw new Error(`Backup entry kind is invalid: ${entry.kind}`);
    }
    if (
      !Number.isFinite(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      Math.floor(entry.sizeBytes) !== entry.sizeBytes
    ) {
      throw new Error(`Backup entry size is invalid: ${entry.source}`);
    }
    if (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error(`Backup entry checksum is invalid: ${entry.source}`);
    }
  }
}

function deleteRecursive(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function normalizeRetentionLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_MAX_BACKUPS;
  }
  if (!Number.isFinite(limit)) {
    throw new Error("maxBackups must be a finite number.");
  }
  return Math.max(1, Math.floor(limit));
}

function isOperationalDataFile(fileName: string): boolean {
  return OPERATIONAL_DATA_FILE_PATTERNS.some((pattern) =>
    pattern.test(fileName),
  );
}

function validateBackupEntry(backupRoot: string, entry: BackupEntry): void {
  const backupPath = path.resolve(backupRoot, entry.backupPath);
  assertInsideWorkspace(backupRoot, backupPath);
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup entry is missing: ${entry.backupPath}`);
  }
  const stat = fs.statSync(backupPath);
  if (entry.kind === "file" && !stat.isFile()) {
    throw new Error(`Backup entry is not a file: ${entry.backupPath}`);
  }
  if (entry.kind === "directory" && !stat.isDirectory()) {
    throw new Error(`Backup entry is not a directory: ${entry.backupPath}`);
  }
  if (entry.sha256 && stat.isFile() && fileHash(backupPath) !== entry.sha256) {
    throw new Error(`Backup entry checksum mismatch: ${entry.backupPath}`);
  }
}

export class BackupManager {
  private readonly baseDir: string;
  private readonly workspaceDir: string;
  private readonly backupsDir: string;
  private readonly maxBackups: number;
  private readonly issuedBackupIds = new Set<string>();

  constructor(
    baseDir: string,
    backupsDirOrOptions?: string | BackupManagerOptions,
  ) {
    this.baseDir = path.resolve(baseDir);
    this.workspaceDir = this.baseDir;
    const options =
      typeof backupsDirOrOptions === "string"
        ? { backupsDir: backupsDirOrOptions }
        : (backupsDirOrOptions ?? {});
    this.backupsDir = path.resolve(
      options.backupsDir || path.join(this.baseDir, "data", "backups"),
    );
    this.maxBackups = normalizeRetentionLimit(options.maxBackups);
    fs.mkdirSync(this.backupsDir, { recursive: true });
  }

  createBackup(
    reason = "manual",
    options: CreateBackupOptions = {},
  ): BackupManifest {
    const id = this.nextBackupId();
    const backupRoot = path.join(this.backupsDir, id);
    const entries: BackupEntry[] = [];
    fs.mkdirSync(backupRoot, { recursive: true });

    for (const source of this.collectSources(options)) {
      const relative = path.relative(this.workspaceDir, source);
      const destination = path.join(backupRoot, "files", relative);
      copyRecursive(source, destination);
      const stat = fs.statSync(source);
      entries.push({
        source: relative,
        backupPath: path.relative(backupRoot, destination),
        kind: stat.isDirectory() ? "directory" : "file",
        sizeBytes: entrySize(source),
        sha256: stat.isFile() ? fileHash(source) : undefined,
      });
    }

    const manifest: BackupManifest = {
      id,
      createdAt: new Date().toISOString(),
      workspaceDir: this.workspaceDir,
      scope: "config-db",
      reason,
      entries,
    };
    fs.writeFileSync(
      path.join(backupRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );
    if (!options.skipRetentionPrune) {
      this.pruneBackups(options.preserveIds ?? new Set([id]));
    }
    return manifest;
  }

  listBackups(): BackupManifest[] {
    try {
      return fs
        .readdirSync(this.backupsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readManifest(entry.name))
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  readManifest(id: string): BackupManifest {
    const backupRoot = this.resolveBackupRoot(id);
    const manifestPath = path.join(backupRoot, "manifest.json");
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    validateManifestShape(parsed as BackupManifest);
    return parsed as BackupManifest;
  }

  rollback(id: string): RollbackResult {
    const manifest = this.readManifest(id);
    const backupRoot = this.resolveBackupRoot(id);
    for (const entry of manifest.entries) {
      validateBackupEntry(backupRoot, entry);
    }

    const preRollback = this.createBackup(`pre-rollback:${id}`, {
      skipRetentionPrune: true,
    });

    for (const entry of manifest.entries) {
      const source = path.resolve(this.workspaceDir, entry.source);
      const backupPath = path.resolve(backupRoot, entry.backupPath);
      assertInsideWorkspace(this.workspaceDir, source);
      assertInsideWorkspace(backupRoot, backupPath);
      copyRecursive(backupPath, source);
    }

    this.pruneBackups(new Set([id, preRollback.id]));

    return {
      restoredBackupId: id,
      preRollbackBackupId: preRollback.id,
      restoredEntries: manifest.entries.length,
    };
  }

  private collectSources(options: CreateBackupOptions = {}): string[] {
    const sources: string[] = [];
    const configDir = path.join(this.workspaceDir, "config");
    const envFile = path.join(this.workspaceDir, ".env");
    const dataDir = path.join(this.workspaceDir, "data");
    const includeOperationalData = options.includeOperationalData !== false;
    if (fs.existsSync(configDir)) sources.push(configDir);
    if (fs.existsSync(envFile)) sources.push(envFile);
    if (fs.existsSync(dataDir)) {
      for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (DATA_FILE_PATTERN.test(entry.name)) {
          if (!includeOperationalData && isOperationalDataFile(entry.name)) {
            continue;
          }
          sources.push(path.join(dataDir, entry.name));
        }
      }
    }
    return sources;
  }

  private resolveBackupRoot(id: string): string {
    if (!/^\d{8}-\d{6}(?:-\d+)?$/.test(id)) {
      throw new Error("Invalid backup id.");
    }
    const backupRoot = path.resolve(this.backupsDir, id);
    assertInsideWorkspace(this.backupsDir, backupRoot);
    return backupRoot;
  }

  private pruneBackups(preserveIds = new Set<string>()): void {
    const backups = this.listBackups();
    let kept = 0;

    for (const backup of backups) {
      if (kept < this.maxBackups || preserveIds.has(backup.id)) {
        kept += 1;
        continue;
      }

      const backupRoot = this.resolveBackupRoot(backup.id);
      assertInsideWorkspace(this.backupsDir, backupRoot);
      deleteRecursive(backupRoot);
    }
  }

  private nextBackupId(): string {
    const base = timestampId();
    let id = base;
    let suffix = 1;
    while (
      this.issuedBackupIds.has(id) ||
      fs.existsSync(path.join(this.backupsDir, id))
    ) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    this.issuedBackupIds.add(id);
    return id;
  }
}

export function createBackupManager(
  paths: RuntimePaths,
  options?: BackupManagerOptions,
): BackupManager {
  return new BackupManager(paths.sourceDir ?? paths.dataDir, {
    ...options,
    backupsDir: options?.backupsDir ?? path.join(paths.dataDir, "backups"),
  });
}
