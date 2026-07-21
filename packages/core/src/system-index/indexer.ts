import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getErrorMessage } from "../errors.js";
import { SystemIndexDatabase } from "./database.js";
import { type RuntimePaths } from "../paths.js";
import {
  extractIndexableContent,
  normalizeExtension,
  shouldSkipDirectory,
  shouldSkipFile,
} from "./extractors.js";
import {
  DEFAULT_SYSTEM_INDEX_CONFIG,
  type SystemIndexConfig,
  type SystemIndexSearchResult,
  type SystemIndexStatus,
} from "./types.js";

interface RebuildOptions {
  wait?: boolean;
}

interface SystemIndexerOptions {
  startWatchers?: boolean;
}

interface ConfigureInput {
  roots?: unknown;
  includeSystemRoots?: unknown;
  indexContent?: unknown;
  realtime?: unknown;
  maxFileSizeBytes?: unknown;
  excludedDirectories?: unknown;
  excludedExtensions?: unknown;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return unique(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function normalizeRoot(root: string): string {
  return path.resolve(root);
}

function pathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function detectSystemRoots(): string[] {
  if (process.platform === "win32") {
    const roots: string[] = [];
    for (let code = 67; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      if (fs.existsSync(root)) roots.push(root);
    }
    return roots;
  }
  return fs.existsSync("/") ? ["/"] : [os.homedir()];
}

export class SystemIndexer {
  private readonly indexRoots: string[];
  private readonly configPath: string;
  private readonly startWatchersOnInit: boolean;
  private readonly db: SystemIndexDatabase;
  private config: SystemIndexConfig;
  private scanPromise: Promise<void> | null = null;
  private stopRequested = false;
  private paused = false;
  private currentPath: string | null = null;
  private scannedFiles = 0;
  private startedAt: string | null = null;
  private completedAt: string | null = null;
  private lastErrors: string[] = [];
  private watchers: fs.FSWatcher[] = [];
  private watchQueue = new Map<string, NodeJS.Timeout>();

  constructor(
    paths: RuntimePaths,
    databasePath?: string,
    options: SystemIndexerOptions = {},
  ) {
    const resolvedSource = path.resolve(paths.sourceDir ?? paths.dataDir);
    this.indexRoots = [resolvedSource, ...detectSystemRoots()];
    this.startWatchersOnInit = options.startWatchers ?? true;
    fs.mkdirSync(paths.dataDir, { recursive: true });
    this.configPath = path.join(paths.dataDir, "system-index-config.json");
    this.config = this.loadConfig();
    this.db = new SystemIndexDatabase(
      databasePath || path.join(paths.dataDir, "system-index.db"),
    );
    if (this.config.realtime && this.startWatchersOnInit) {
      this.startWatchers();
    }
  }

  configure(input: ConfigureInput): SystemIndexStatus {
    this.config = this.normalizeConfig(
      { ...input, includeSystemRoots: input.includeSystemRoots ?? true },
      this.config,
    );
    this.saveConfig();
    if (!this.paused) {
      this.startWatchers();
    }
    return this.status();
  }

  async rebuild(
    input: ConfigureInput = {},
    options: RebuildOptions = {},
  ): Promise<SystemIndexStatus> {
    this.configure(input);
    if (this.scanPromise) {
      this.stopRequested = true;
      await this.scanPromise.catch(() => undefined);
    }

    this.db.clear();
    this.stopRequested = false;
    this.paused = false;
    this.scannedFiles = 0;
    this.currentPath = null;
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this.lastErrors = [];

    this.scanPromise = this.runFullScan().finally(() => {
      this.scanPromise = null;
      this.currentPath = null;
      this.completedAt = new Date().toISOString();
      if (this.config.realtime && !this.stopRequested) {
        this.startWatchers();
      }
    });

    if (options.wait) {
      await this.scanPromise;
    }
    return this.status();
  }

  pause(): SystemIndexStatus {
    this.paused = true;
    this.closeWatchers();
    return this.status();
  }

  resume(): SystemIndexStatus {
    this.paused = false;
    if (this.config.realtime) this.startWatchers();
    return this.status();
  }

  async stop(): Promise<SystemIndexStatus> {
    this.stopRequested = true;
    this.paused = false;
    this.closeWatchers();
    if (this.scanPromise) {
      await this.scanPromise.catch(() => undefined);
    }
    this.stopRequested = false;
    return this.status();
  }

  async indexPath(filePath: string): Promise<void> {
    if (this.paused) return;
    const target = path.resolve(filePath);
    if (!this.isAllowedTarget(target)) {
      this.recordError(`${target}: path is outside configured index roots`);
      return;
    }
    try {
      const stat = await fs.promises.lstat(target);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        await this.scanDirectory(target);
        return;
      }
      if (stat.isFile()) {
        await this.indexFile(target, stat);
      }
    } catch {
      this.db.remove(target);
    }
  }

  removePath(filePath: string): void {
    this.db.remove(path.resolve(filePath));
  }

  search(query: string, limit = 25): SystemIndexSearchResult[] {
    return this.db.search(query, limit);
  }

  roots(): string[] {
    return detectSystemRoots();
  }

  effectiveRoots(): string[] {
    const roots = this.config.roots.map(normalizeRoot);
    const systemRoots = this.config.includeSystemRoots
      ? detectSystemRoots()
      : [];
    return unique([...systemRoots, ...roots]);
  }

  status(): SystemIndexStatus {
    return {
      state: this.stopRequested
        ? "stopping"
        : this.paused
          ? "paused"
          : this.scanPromise
            ? "scanning"
            : "idle",
      config: this.config,
      effectiveRoots: this.effectiveRoots(),
      stats: this.db.stats(),
      queueSize: this.watchQueue.size,
      currentPath: this.currentPath,
      scannedFiles: this.scannedFiles,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      realtimeWatchers: this.watchers.length,
      lastErrors: this.lastErrors,
    };
  }

  close(): void {
    this.closeWatchers();
    this.db.close();
  }

  private async runFullScan(): Promise<void> {
    this.closeWatchers();
    for (const root of this.effectiveRoots()) {
      if (this.stopRequested) return;
      try {
        await this.scanEntry(root);
      } catch (err) {
        this.recordError(`${root}: ${getErrorMessage(err)}`);
      }
    }
  }

  private async scanEntry(entryPath: string): Promise<void> {
    await this.waitIfPaused();
    if (this.stopRequested) return;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(entryPath);
    } catch (err) {
      this.recordError(`${entryPath}: ${getErrorMessage(err)}`);
      return;
    }

    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (shouldSkipDirectory(entryPath, this.config)) return;
      await this.scanDirectory(entryPath);
      return;
    }
    if (stat.isFile()) {
      await this.indexFile(entryPath, stat);
    }
  }

  private async scanDirectory(directoryPath: string): Promise<void> {
    if (shouldSkipDirectory(directoryPath, this.config)) return;
    this.currentPath = directoryPath;
    let dir: fs.Dir;
    try {
      dir = await fs.promises.opendir(directoryPath);
    } catch (err) {
      this.recordError(`${directoryPath}: ${getErrorMessage(err)}`);
      return;
    }

    for await (const entry of dir) {
      if (this.stopRequested) return;
      await this.waitIfPaused();
      await this.scanEntry(path.join(directoryPath, entry.name));
    }
  }

  private async indexFile(filePath: string, stat: fs.Stats): Promise<void> {
    if (shouldSkipFile(filePath, this.config)) return;
    const extracted = await extractIndexableContent(
      filePath,
      stat,
      this.config,
    );
    this.db.upsert({
      path: filePath,
      name: path.basename(filePath),
      extension: normalizeExtension(filePath),
      parentPath: path.dirname(filePath),
      sizeBytes: stat.size,
      modifiedAtMs: stat.mtimeMs,
      createdAtMs: stat.ctimeMs,
      birthtimeMs: stat.birthtimeMs,
      indexedAt: new Date().toISOString(),
      contentIndexed: extracted.contentIndexed,
      content: extracted.content,
      error: extracted.error,
    });
    this.scannedFiles += 1;
    if (this.scannedFiles % 200 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private startWatchers(): void {
    this.closeWatchers();
    if (!this.config.realtime) return;

    for (const root of this.effectiveRoots()) {
      if (!fs.existsSync(root)) continue;
      try {
        const watcher = fs.watch(
          root,
          { recursive: process.platform === "win32" },
          (_eventType, filename) => {
            if (!filename) return;
            const target = path.resolve(root, String(filename));
            if (!pathInsideRoot(root, target)) return;
            this.enqueueWatchUpdate(target);
          },
        );
        watcher.on("error", (err) => {
          this.recordError(`watch ${root}: ${getErrorMessage(err)}`);
        });
        this.watchers.push(watcher);
      } catch (err) {
        this.recordError(`watch ${root}: ${getErrorMessage(err)}`);
      }
    }
  }

  private enqueueWatchUpdate(target: string): void {
    const existing = this.watchQueue.get(target);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.watchQueue.delete(target);
      void this.indexPath(target).catch((err: unknown) => {
        this.recordError(`${target}: ${getErrorMessage(err)}`);
      });
    }, 750);
    timer.unref?.();
    this.watchQueue.set(target, timer);
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    for (const timer of this.watchQueue.values()) {
      clearTimeout(timer);
    }
    this.watchQueue.clear();
  }

  private isAllowedTarget(target: string): boolean {
    return this.effectiveRoots().some((root) =>
      pathInsideRoot(normalizeRoot(root), target),
    );
  }

  private async waitIfPaused(): Promise<void> {
    while (this.paused && !this.stopRequested) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private recordError(message: string): void {
    this.lastErrors = [message, ...this.lastErrors].slice(0, 20);
  }

  private loadConfig(): SystemIndexConfig {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.configPath, "utf-8"),
      ) as ConfigureInput;
      return this.normalizeConfig(parsed, DEFAULT_SYSTEM_INDEX_CONFIG);
    } catch {
      return DEFAULT_SYSTEM_INDEX_CONFIG;
    }
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private normalizeConfig(
    input: ConfigureInput,
    fallback: SystemIndexConfig,
  ): SystemIndexConfig {
    const roots = normalizeStringArray(input.roots)?.map(normalizeRoot);
    const excludedDirectories = normalizeStringArray(input.excludedDirectories);
    const excludedExtensions = normalizeStringArray(input.excludedExtensions);
    const maxFileSizeBytes =
      typeof input.maxFileSizeBytes === "number" &&
      Number.isFinite(input.maxFileSizeBytes)
        ? Math.max(0, Math.min(25 * 1024 * 1024, input.maxFileSizeBytes))
        : fallback.maxFileSizeBytes;

    return {
      roots: roots ?? fallback.roots,
      includeSystemRoots:
        typeof input.includeSystemRoots === "boolean"
          ? input.includeSystemRoots
          : fallback.includeSystemRoots,
      indexContent:
        typeof input.indexContent === "boolean"
          ? input.indexContent
          : fallback.indexContent,
      realtime:
        typeof input.realtime === "boolean"
          ? input.realtime
          : fallback.realtime,
      maxFileSizeBytes,
      excludedDirectories: excludedDirectories ?? fallback.excludedDirectories,
      excludedExtensions:
        excludedExtensions?.map((item) =>
          item.startsWith(".") ? item.toLowerCase() : `.${item.toLowerCase()}`,
        ) ?? fallback.excludedExtensions,
    };
  }
}
