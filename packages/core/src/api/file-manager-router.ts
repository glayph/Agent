import { Router, type Request, type Response } from "express";
import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import * as tar from "tar";
import { TextDecoder } from "util";
import { type RuntimePaths } from "../paths.js";

const MAX_LIST_ENTRIES = 1000;
const MAX_TEXT_READ_BYTES = 5 * 1024 * 1024;
const MAX_WRITE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Limits applied while walking a directory tree before recursive copy/move
 * operations. These keep a single request from traversing an unbounded tree
 * (including symlink/junction descendants that would otherwise escape the
 * selected source).
 */
const MAX_COPY_TREE_DEPTH = 32;
const MAX_COPY_TREE_ENTRIES = 50_000;
const MAX_COPY_TREE_BYTES = 2 * 1024 * 1024 * 1024;

const PREVIEW_MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

type FileEntryType = "file" | "directory" | "symlink";
type FileManagerSystemWritePolicy = boolean | (() => boolean);

interface FileManagerRouterOptions {
  runtimePaths: RuntimePaths;
  allowSystemWrite?: FileManagerSystemWritePolicy;
  /** @deprecated Use runtimePaths instead */
  workspaceDir?: string;
}

interface FileRoot {
  id: string;
  label: string;
  path: string;
  kind: "home" | "workspace" | "drive" | "root" | "quickAccess";
  protected: boolean;
  storage?: FileRootStorage;
}

interface FileRootStorage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

interface FileEntry {
  name: string;
  path: string;
  type: FileEntryType;
  sizeBytes: number;
  modifiedAt: string;
  extension: string;
  hidden: boolean;
  readonly: boolean;
}

class FileManagerError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FileManagerError";
    this.status = status;
  }
}

function normalizeKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
  return normalizeKey(a) === normalizeKey(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function resolveInputPath(value: unknown): string {
  const input = stringField(value).trim();
  if (!input) {
    throw new FileManagerError(400, "path is required");
  }
  if (input.includes("\0")) {
    throw new FileManagerError(400, "path contains an invalid character");
  }
  if (!path.isAbsolute(input)) {
    throw new FileManagerError(400, "path must be absolute");
  }
  return path.resolve(input);
}

function validateName(name: unknown, field = "name"): string {
  const value = stringField(name).trim();
  if (!value) {
    throw new FileManagerError(400, `${field} is required`);
  }
  if (
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new FileManagerError(400, `${field} is invalid`);
  }
  return value;
}

function filesystemRoot(targetPath: string): string {
  const root = path.parse(path.resolve(targetPath)).root;
  return root ? path.resolve(root) : path.resolve(targetPath);
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = normalizeKey(parentPath);
  const child = normalizeKey(childPath);
  if (parent === child) return true;
  const relative = path.relative(parentPath, childPath);
  return Boolean(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
}

function commonParentPath(paths: string[]): string {
  if (paths.length === 0) {
    throw new FileManagerError(400, "paths are required");
  }

  const roots = new Set(
    paths.map((item) => normalizeKey(path.parse(item).root)),
  );
  if (roots.size > 1) {
    throw new FileManagerError(
      400,
      "downloaded items must be on the same filesystem root",
    );
  }

  const parents = paths.map((item) => path.dirname(item));
  let candidate = parents[0];
  const root = filesystemRoot(candidate);
  while (!parents.every((parent) => isPathInside(candidate, parent))) {
    const next = path.dirname(candidate);
    if (samePath(next, candidate) || samePath(candidate, root)) {
      return root;
    }
    candidate = next;
  }
  return candidate;
}

function isProtectedLocation(
  targetPath: string,
  runtimePaths: RuntimePaths,
): boolean {
  const resolved = path.resolve(targetPath);
  return (
    samePath(resolved, filesystemRoot(resolved)) ||
    samePath(resolved, runtimePaths.sourceDir ?? process.cwd())
  );
}

function allowSystemWriteFromEnv(): boolean {
  const envVal = process.env["Hiro_FILE_MANAGER_ALLOW_SYSTEM_WRITE"];
  if (envVal === "true") return true;
  return false;
}

function resolveAllowSystemWrite(
  policy: FileManagerSystemWritePolicy | undefined,
): boolean {
  if (typeof policy === "function") return policy();
  if (typeof policy === "boolean") return policy;
  return allowSystemWriteFromEnv();
}

async function assertMutableScope(
  targetPath: string,
  runtimePaths: RuntimePaths,
  allowSystemWrite: boolean,
): Promise<void> {
  const sourceDir = path.resolve(
    runtimePaths.sourceDir ?? runtimePaths.dataDir,
  );
  const resolved = path.resolve(targetPath);
  // Resolve symlinks/junctions to the real path before scope checking.
  let realPath: string;
  try {
    realPath = await fsp.realpath(resolved);
  } catch {
    // If realpath fails (parent doesn't exist yet), fall back to resolved.
    // The parent existence check in assertMutableTarget will catch bad paths.
    realPath = resolved;
  }
  const isInside =
    realPath === sourceDir || realPath.startsWith(sourceDir + path.sep);

  if (!isInside && !allowSystemWrite) {
    throw new FileManagerError(403, "write outside workspace is not allowed");
  }
}

async function assertMutableTarget(
  targetPath: string,
  runtimePaths: RuntimePaths,
  allowSystemWrite: boolean,
): Promise<void> {
  await assertMutableScope(targetPath, runtimePaths, allowSystemWrite);
  if (isProtectedLocation(targetPath, runtimePaths)) {
    throw new FileManagerError(
      403,
      "protected filesystem root cannot be modified",
    );
  }

  const stat = await fsp.lstat(targetPath).catch(() => null);
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new FileManagerError(400, "symbolic links are not supported");
    }
    return;
  }

  const parentPath = path.dirname(targetPath);
  await assertSafeFilesystemNode(parentPath);
}

async function assertDirectory(targetPath: string): Promise<fs.Stats> {
  const stat = await fsp.stat(targetPath);
  if (!stat.isDirectory()) {
    throw new FileManagerError(400, "target path is not a directory");
  }
  return stat;
}

async function assertRegularFile(targetPath: string): Promise<fs.Stats> {
  const stat = await fsp.stat(targetPath);
  if (!stat.isFile()) {
    throw new FileManagerError(400, "target path is not a file");
  }
  return stat;
}

async function assertSafeFilesystemNode(targetPath: string): Promise<void> {
  const stat = await fsp.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    throw new FileManagerError(400, "symbolic links are not supported");
  }
  // Validate ancestors are not symlinks/junctions — a symlink ancestor
  // could allow writes to escape the workspace even if the final path
  // resolves inside it.
  let current = path.dirname(targetPath);
  const root = filesystemRoot(targetPath);
  while (current !== root && current !== path.dirname(current)) {
    try {
      const ancestorStat = await fsp.lstat(current);
      if (ancestorStat.isSymbolicLink()) {
        throw new FileManagerError(
          400,
          "path contains a symbolic link ancestor",
        );
      }
    } catch (err) {
      if (err instanceof FileManagerError) throw err;
      break;
    }
    current = path.dirname(current);
  }
  if (stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()) {
    return;
  }
  throw new FileManagerError(400, "special filesystem nodes are not supported");
}

/**
 * Recursively walk a directory tree before a recursive copy/move and reject
 * any symlink/junction descendant. Node's `fsp.cp({ recursive: true })` will
 * otherwise follow POSIX symlinks and Windows junctions nested inside a normal
 * looking folder, importing external filesystem contents into the workspace.
 *
 * Also enforces depth/file-count/byte budgets so a single request cannot
 * traverse an unbounded tree.
 */
async function assertSafeRecursiveTree(
  rootPath: string,
  rootStat?: fs.Stats,
): Promise<void> {
  const root = rootStat ?? (await fsp.lstat(rootPath));
  if (root.isSymbolicLink()) {
    throw new FileManagerError(400, "symbolic links are not supported");
  }
  if (!root.isDirectory()) return;

  let entryCount = 1; // include the root directory itself
  let totalBytes = 0;
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: rootPath, depth: 0 },
  ];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_COPY_TREE_DEPTH) {
      throw new FileManagerError(400, "directory tree is too deep to copy");
    }
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable subdirectories are surfaced by the copy itself; do not
      // block the whole operation for a single inaccessible folder.
      continue;
    }
    for (const dirent of dirents) {
      entryCount += 1;
      if (entryCount > MAX_COPY_TREE_ENTRIES) {
        throw new FileManagerError(
          413,
          "directory tree has too many entries to copy",
        );
      }
      // Symbolic links and Windows junctions appear as symbolic links via
      // lstat/Dirent. Reject them explicitly so the recursive copy cannot
      // follow them out of the selected tree.
      if (dirent.isSymbolicLink()) {
        throw new FileManagerError(
          400,
          "symbolic links are not supported inside copied folders",
        );
      }
      const childPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push({ dir: childPath, depth: depth + 1 });
      } else if (dirent.isFile()) {
        try {
          const stat = await fsp.stat(childPath);
          totalBytes += stat.size;
          if (totalBytes > MAX_COPY_TREE_BYTES) {
            throw new FileManagerError(
              413,
              "directory tree is too large to copy",
            );
          }
        } catch (err) {
          if (err instanceof FileManagerError) throw err;
          // Stat failure for a single file does not block the walk.
        }
      } else {
        throw new FileManagerError(
          400,
          "special filesystem nodes are not supported",
        );
      }
    }
  }
}

function resolveInputPaths(value: unknown): string[] {
  if (Array.isArray(value)) {
    const paths = value.map((item) => resolveInputPath(item));
    if (paths.length === 0) {
      throw new FileManagerError(400, "paths are required");
    }
    return paths;
  }
  return [resolveInputPath(value)];
}

function readonlyFromMode(mode: number): boolean {
  return (mode & 0o200) === 0;
}

function entryTypeFromStats(dirent: fs.Dirent, stat: fs.Stats): FileEntryType {
  if (dirent.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  return "file";
}

async function entryFromDirent(
  parentPath: string,
  dirent: fs.Dirent,
): Promise<FileEntry | null> {
  const fullPath = path.join(parentPath, dirent.name);
  try {
    const stat = await fsp.lstat(fullPath);
    if (stat.isSymbolicLink()) {
      return {
        name: dirent.name,
        path: fullPath,
        type: "symlink",
        sizeBytes: 0,
        modifiedAt: stat.mtime.toISOString(),
        extension: path.extname(dirent.name).toLowerCase(),
        hidden: dirent.name.startsWith("."),
        readonly: true,
      };
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      return null;
    }
    return {
      name: dirent.name,
      path: fullPath,
      type: entryTypeFromStats(dirent, stat),
      sizeBytes: stat.isDirectory() ? 0 : stat.size,
      modifiedAt: stat.mtime.toISOString(),
      extension: stat.isDirectory()
        ? ""
        : path.extname(dirent.name).toLowerCase(),
      hidden: dirent.name.startsWith("."),
      readonly: readonlyFromMode(stat.mode),
    };
  } catch {
    return null;
  }
}

function sortEntries(a: FileEntry, b: FileEntry): number {
  if (a.type === "directory" && b.type !== "directory") return -1;
  if (a.type !== "directory" && b.type === "directory") return 1;
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

async function listDirectory(targetPath: string): Promise<FileEntry[]> {
  await assertDirectory(targetPath);
  const dirents = (
    await fsp.readdir(targetPath, { withFileTypes: true })
  ).slice(0, MAX_LIST_ENTRIES);
  const entries = await Promise.all(
    dirents.map((dirent) => entryFromDirent(targetPath, dirent)),
  );
  return entries
    .filter((entry): entry is FileEntry => entry !== null)
    .sort(sortEntries);
}

function detectBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  let control = 0;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      control += 1;
    }
  }
  return sample.length > 0 && control / sample.length > 0.02;
}

function decodeText(buffer: Buffer): string {
  if (detectBinary(buffer)) {
    throw new FileManagerError(415, "binary files cannot be edited inline");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new FileManagerError(415, "file is not valid UTF-8 text");
  }
}

async function readTextFile(targetPath: string): Promise<{
  content: string;
  sizeBytes: number;
  modifiedAt: string;
  readonly: boolean;
}> {
  const stat = await assertRegularFile(targetPath);
  if (stat.size > MAX_TEXT_READ_BYTES) {
    throw new FileManagerError(413, "file is too large for inline preview");
  }
  const buffer = await fsp.readFile(targetPath);
  return {
    content: decodeText(buffer),
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    readonly: readonlyFromMode(stat.mode),
  };
}

async function atomicWriteText(
  targetPath: string,
  content: string,
): Promise<FileEntry> {
  const parentPath = path.dirname(targetPath);
  await assertDirectory(parentPath);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WRITE_BYTES) {
    throw new FileManagerError(413, "file content exceeds the write limit");
  }
  const tempPath = path.join(
    parentPath,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fsp.writeFile(tempPath, content, { encoding: "utf8", mode: 0o644 });
  try {
    await fsp.rename(tempPath, targetPath);
  } catch (err) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
  return (await entryFromPath(targetPath))!;
}

async function entryFromPath(targetPath: string): Promise<FileEntry | null> {
  const stat = await fsp.stat(targetPath);
  if (!stat.isFile() && !stat.isDirectory()) return null;
  return {
    name: path.basename(targetPath) || targetPath,
    path: targetPath,
    type: stat.isDirectory() ? "directory" : "file",
    sizeBytes: stat.isDirectory() ? 0 : stat.size,
    modifiedAt: stat.mtime.toISOString(),
    extension: stat.isDirectory() ? "" : path.extname(targetPath).toLowerCase(),
    hidden: path.basename(targetPath).startsWith("."),
    readonly: readonlyFromMode(stat.mode),
  };
}

async function copyFilesystemNode(
  sourcePath: string,
  targetPath: string,
): Promise<FileEntry> {
  await assertSafeFilesystemNode(sourcePath);
  const sourceStat = await fsp.stat(sourcePath);
  if (fs.existsSync(targetPath)) {
    throw new FileManagerError(409, "target already exists");
  }
  if (sourceStat.isDirectory()) {
    if (isPathInside(sourcePath, targetPath)) {
      throw new FileManagerError(400, "cannot copy a folder into itself");
    }
    // Walk the tree first so symlink/junction descendants and oversized trees
    // are rejected before fsp.cp follows them out of the selected source.
    await assertSafeRecursiveTree(sourcePath, sourceStat);
    await fsp.cp(sourcePath, targetPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } else if (sourceStat.isFile()) {
    await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  } else {
    throw new FileManagerError(
      400,
      "special filesystem nodes are not supported",
    );
  }
  const entry = await entryFromPath(targetPath);
  if (!entry) throw new FileManagerError(500, "copied entry is unavailable");
  return entry;
}

async function moveFilesystemNode(
  sourcePath: string,
  targetPath: string,
  runtimePaths: RuntimePaths,
  allowSystemWrite: boolean,
): Promise<FileEntry> {
  await assertMutableTarget(sourcePath, runtimePaths, allowSystemWrite);
  await assertMutableTarget(targetPath, runtimePaths, allowSystemWrite);
  await assertSafeFilesystemNode(sourcePath);
  const sourceStat = await fsp.stat(sourcePath);
  if (sourceStat.isDirectory() && isPathInside(sourcePath, targetPath)) {
    throw new FileManagerError(400, "cannot move a folder into itself");
  }
  if (fs.existsSync(targetPath)) {
    throw new FileManagerError(409, "target already exists");
  }
  try {
    await fsp.rename(sourcePath, targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw err;
    await copyFilesystemNode(sourcePath, targetPath);
    await fsp.rm(sourcePath, {
      recursive: sourceStat.isDirectory(),
      force: false,
    });
  }
  const entry = await entryFromPath(targetPath);
  if (!entry) throw new FileManagerError(500, "moved entry is unavailable");
  return entry;
}

function openWithSystemLauncher(targetPath: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Start-Process -LiteralPath $args[0]",
          targetPath,
        ]
      : [targetPath];

  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: 5000,
        windowsHide: true,
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

function contentDispositionFilename(filename: string): string {
  const safe = filename.replace(/[^\w .()[\]-]/g, "_") || "download";
  return `attachment; filename="${safe.replace(/"/g, "_")}"`;
}

function inlineContentDisposition(filename: string): string {
  const safe = filename.replace(/[^\w .()[\]-]/g, "_") || "preview";
  return `inline; filename="${safe.replace(/"/g, "_")}"`;
}

function previewMimeType(targetPath: string): string | null {
  return PREVIEW_MIME_TYPES[path.extname(targetPath).toLowerCase()] ?? null;
}

function byteRange(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    throw new FileManagerError(416, "invalid range");
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    throw new FileManagerError(416, "invalid range");
  }

  let start = rawStart ? Number(rawStart) : size - Number(rawEnd);
  let end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new FileManagerError(416, "invalid range");
  }
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end || start >= size) {
    throw new FileManagerError(416, "range not satisfiable");
  }
  return { start, end };
}

async function sendPreviewFile(
  req: Request,
  res: Response,
  targetPath: string,
): Promise<void> {
  const mimeType = previewMimeType(targetPath);
  if (!mimeType) {
    throw new FileManagerError(415, "file type cannot be previewed inline");
  }

  await assertSafeFilesystemNode(targetPath);
  const stat = await assertRegularFile(targetPath);
  const range = byteRange(req.headers.range, stat.size);

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mimeType);
  res.setHeader(
    "Content-Disposition",
    inlineContentDisposition(path.basename(targetPath)),
  );
  if (mimeType === "image/svg+xml") {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    );
  }

  if (range) {
    res.status(206);
    res.setHeader(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${stat.size}`,
    );
    res.setHeader("Content-Length", String(range.end - range.start + 1));
  } else {
    res.setHeader("Content-Length", String(stat.size));
  }

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(
      targetPath,
      range ? { start: range.start, end: range.end } : undefined,
    );
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

function archiveDownloadName(paths: string[]): string {
  if (paths.length === 1) {
    const name = path.basename(paths[0]) || "download";
    return `${name}.tar.gz`;
  }
  return `selection-${new Date().toISOString().slice(0, 10)}.tar.gz`;
}

async function sendArchiveDownload(
  res: Response,
  sourcePaths: string[],
): Promise<void> {
  const archiveRoot = commonParentPath(sourcePaths);
  const relativePaths: string[] = [];

  for (const sourcePath of sourcePaths) {
    await assertSafeFilesystemNode(sourcePath);
    const stat = await fsp.stat(sourcePath);
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new FileManagerError(
        400,
        "special filesystem nodes are not supported",
      );
    }
    const relativePath = path.relative(archiveRoot, sourcePath);
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath)
    ) {
      throw new FileManagerError(400, "path cannot be archived");
    }
    relativePaths.push(relativePath);
  }

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader(
    "Content-Disposition",
    contentDispositionFilename(archiveDownloadName(sourcePaths)),
  );

  await new Promise<void>((resolve, reject) => {
    const archive = tar.c(
      {
        cwd: archiveRoot,
        gzip: true,
        portable: true,
        filter: (_archivePath, stat) => {
          const filesystemStat = stat as fs.Stats | undefined;
          return Boolean(
            filesystemStat &&
            typeof filesystemStat.isFile === "function" &&
            (filesystemStat.isFile() || filesystemStat.isDirectory()),
          );
        },
      },
      relativePaths,
    );
    archive.on("error", reject);
    res.on("error", reject);
    res.on("finish", resolve);
    archive.pipe(res);
  });
}

function pushRoot(roots: FileRoot[], seen: Set<string>, root: FileRoot): void {
  const resolved = path.resolve(root.path);
  if (!fs.existsSync(resolved)) return;
  const key = normalizeKey(resolved);
  if (seen.has(key)) return;
  seen.add(key);
  roots.push({ ...root, path: resolved });
}

function windowsDriveRoots(): string[] {
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (fs.existsSync(drive)) {
      roots.push(drive);
    }
  }
  return roots;
}

function isQuickAccessRecord(
  value: unknown,
): value is { label?: unknown; path?: unknown } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fallbackRootLabel(targetPath: string): string {
  return path.basename(path.resolve(targetPath)) || path.resolve(targetPath);
}

function fileRootStorage(
  totalBytes: number,
  freeBytes: number,
): FileRootStorage | undefined {
  if (
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(freeBytes) ||
    totalBytes <= 0 ||
    freeBytes < 0
  ) {
    return undefined;
  }
  const boundedFreeBytes = Math.min(freeBytes, totalBytes);
  return {
    totalBytes,
    freeBytes: boundedFreeBytes,
    usedBytes: totalBytes - boundedFreeBytes,
  };
}

function statfsStorage(targetPath: string): FileRootStorage | undefined {
  try {
    const stats = fs.statfsSync(targetPath);
    return fileRootStorage(
      stats.blocks * stats.bsize,
      stats.bavail * stats.bsize,
    );
  } catch {
    return undefined;
  }
}

function windowsQuickAccessFolders(): Array<{ label: string; path: string }> {
  if (process.platform !== "win32") return [];

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace('shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}')
$items = @()
if ($null -ne $folder) {
  foreach ($item in $folder.Items()) {
    $itemPath = [string]$item.Path
    if ($itemPath -and (Test-Path -LiteralPath $itemPath -PathType Container)) {
      $isPinned = $item.ExtendedProperty('System.IsPinnedToNameSpaceTree')
      if ($isPinned -eq $true) {
        $items += [pscustomobject]@{
          label = [string]$item.Name
          path = $itemPath
        }
      }
    }
  }
}
$items | ConvertTo-Json -Compress
`;

  try {
    const stdout = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2500,
        windowsHide: true,
      },
    ).trim();
    if (!stdout) return [];
    const parsed = JSON.parse(stdout) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records
      .filter(isQuickAccessRecord)
      .map((record) => ({
        label: stringField(record.label).trim(),
        path: stringField(record.path).trim(),
      }))
      .filter((record) => record.path && fs.existsSync(record.path))
      .map((record) => {
        const resolved = path.resolve(record.path);
        return {
          label: record.label || fallbackRootLabel(resolved),
          path: resolved,
        };
      });
  } catch {
    return [];
  }
}

function rootEntries(runtimePaths: RuntimePaths): FileRoot[] {
  const roots: FileRoot[] = [];
  const seen = new Set<string>();
  const resolvedWorkspace = path.resolve(
    runtimePaths.sourceDir ?? process.cwd(),
  );

  windowsQuickAccessFolders().forEach((folder, index) => {
    pushRoot(roots, seen, {
      id: `quick-access-${index}`,
      label: folder.label,
      path: folder.path,
      kind: "quickAccess",
      protected: false,
    });
  });

  pushRoot(roots, seen, {
    id: "workspace",
    label: "Workspace",
    path: resolvedWorkspace,
    kind: "workspace",
    protected: true,
  });

  pushRoot(roots, seen, {
    id: "home",
    label: "Home",
    path: os.homedir(),
    kind: "home",
    protected: false,
  });

  if (process.platform === "win32") {
    for (const drive of windowsDriveRoots()) {
      pushRoot(roots, seen, {
        id: `drive-${drive[0].toLowerCase()}`,
        label: `${drive[0].toUpperCase()}:`,
        path: drive,
        kind: "drive",
        protected: true,
        storage: statfsStorage(drive),
      });
    }
  } else {
    pushRoot(roots, seen, {
      id: "root",
      label: "Filesystem",
      path: "/",
      kind: "root",
      protected: true,
      storage: statfsStorage("/"),
    });
  }

  return roots;
}

function parentPathFor(targetPath: string): string | null {
  const resolved = path.resolve(targetPath);
  if (samePath(resolved, filesystemRoot(resolved))) {
    return null;
  }
  const parentPath = path.dirname(resolved);
  return samePath(parentPath, resolved) ? null : parentPath;
}

function bodyRecord(req: Request): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

function sendError(res: Response, err: unknown): void {
  const status = err instanceof FileManagerError ? err.status : 500;
  res.status(status).json({
    error: err instanceof Error ? err.message : String(err),
  });
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((err) => sendError(res, err));
  };
}

function readRequestBuffer(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new FileManagerError(413, "upload exceeds the size limit"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

function multipartBoundary(req: Request): string {
  const contentType = req.headers["content-type"] || "";
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType));
  if (!match) {
    throw new FileManagerError(415, "multipart/form-data boundary is required");
  }
  return match[1] || match[2] || "";
}

function parseContentDisposition(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    const key = rawKey.toLowerCase();
    if (!key || rawValue.length === 0) continue;
    result[key] = rawValue.join("=").trim().replace(/^"|"$/g, "");
  }
  return result;
}

function parseMultipartForm(
  body: Buffer,
  boundary: string,
): {
  fields: Record<string, string>;
  files: Array<{ field: string; filename: string; data: Buffer }>;
} {
  const marker = Buffer.from(`--${boundary}`);
  const separator = Buffer.from("\r\n\r\n");
  const fields: Record<string, string> = {};
  const files: Array<{ field: string; filename: string; data: Buffer }> = [];
  let cursor = body.indexOf(marker);

  while (cursor >= 0) {
    cursor += marker.length;
    if (body.subarray(cursor, cursor + 2).toString() === "--") break;
    if (body.subarray(cursor, cursor + 2).toString() === "\r\n") cursor += 2;

    const headerEnd = body.indexOf(separator, cursor);
    if (headerEnd < 0) break;
    const headers = body.subarray(cursor, headerEnd).toString("utf8");
    const dataStart = headerEnd + separator.length;
    const next = body.indexOf(marker, dataStart);
    if (next < 0) break;
    let dataEnd = next;
    if (body.subarray(dataEnd - 2, dataEnd).toString() === "\r\n") {
      dataEnd -= 2;
    }

    const dispositionLine =
      headers
        .split(/\r?\n/)
        .find((line) => /^content-disposition:/i.test(line)) || "";
    const disposition = parseContentDisposition(
      dispositionLine.replace(/^content-disposition:\s*/i, ""),
    );
    const field = disposition.name;
    if (field) {
      const data = body.subarray(dataStart, dataEnd);
      if (disposition.filename) {
        files.push({ field, filename: disposition.filename, data });
      } else {
        fields[field] = data.toString("utf8");
      }
    }
    cursor = next;
  }

  return { fields, files };
}

export function createFileManagerRouter({
  runtimePaths,
  allowSystemWrite,
}: FileManagerRouterOptions): Router {
  const router = Router();
  const currentAllowSystemWrite = (): boolean =>
    resolveAllowSystemWrite(allowSystemWrite);
  const assertCurrentMutableScope = (targetPath: string): Promise<void> =>
    assertMutableScope(targetPath, runtimePaths, currentAllowSystemWrite());
  const assertCurrentMutableTarget = (targetPath: string): Promise<void> =>
    assertMutableTarget(targetPath, runtimePaths, currentAllowSystemWrite());

  router.get("/roots", (_req, res) => {
    res.json({ roots: rootEntries(runtimePaths) });
  });

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const targetPath = resolveInputPath(req.query.path);
      await assertSafeFilesystemNode(targetPath);
      const stat = await fsp.stat(targetPath);
      if (!stat.isDirectory()) {
        throw new FileManagerError(400, "path is not a directory");
      }
      res.json({
        path: targetPath,
        parentPath: parentPathFor(targetPath),
        entries: await listDirectory(targetPath),
        limit: MAX_LIST_ENTRIES,
      });
    }),
  );

  router.get(
    "/read",
    asyncRoute(async (req, res) => {
      const targetPath = resolveInputPath(req.query.path);
      await assertSafeFilesystemNode(targetPath);
      const file = await readTextFile(targetPath);
      res.json({ path: targetPath, ...file });
    }),
  );

  router.put(
    "/write",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req);
      const targetPath = resolveInputPath(body.path);
      await assertCurrentMutableTarget(targetPath);
      const content = stringField(body.content);
      const expectedModifiedAt = stringField(body.expectedModifiedAt).trim();
      const current = await fsp.stat(targetPath).catch(() => null);
      if (current?.isDirectory()) {
        throw new FileManagerError(400, "cannot write a directory");
      }
      if (
        expectedModifiedAt &&
        current &&
        current.mtime.toISOString() !== expectedModifiedAt
      ) {
        throw new FileManagerError(
          409,
          "file changed on disk; reload before saving",
        );
      }
      const entry = await atomicWriteText(targetPath, content);
      res.json({ status: "ok", entry });
    }),
  );

  router.post(
    "/create",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req);
      const parentPath = resolveInputPath(body.parentPath);
      await assertSafeFilesystemNode(parentPath);
      await assertDirectory(parentPath);
      const name = validateName(body.name);
      const type = stringField(body.type);
      const targetPath = path.join(parentPath, name);
      await assertCurrentMutableTarget(targetPath);
      if (fs.existsSync(targetPath)) {
        throw new FileManagerError(409, "target already exists");
      }
      if (type === "directory") {
        await fsp.mkdir(targetPath, { mode: 0o755 });
      } else if (type === "file") {
        await atomicWriteText(targetPath, stringField(body.content));
      } else {
        throw new FileManagerError(400, "type must be file or directory");
      }
      res
        .status(201)
        .json({ status: "ok", entry: await entryFromPath(targetPath) });
    }),
  );

  router.patch(
    "/rename",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req);
      const targetPath = resolveInputPath(body.path);
      await assertCurrentMutableTarget(targetPath);
      await assertSafeFilesystemNode(targetPath);
      const newName = validateName(body.newName, "newName");
      const nextPath = path.join(path.dirname(targetPath), newName);
      if (fs.existsSync(nextPath)) {
        throw new FileManagerError(409, "target already exists");
      }
      await fsp.rename(targetPath, nextPath);
      res.json({ status: "ok", entry: await entryFromPath(nextPath) });
    }),
  );

  router.post(
    "/copy",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req);
      const sources = resolveInputPaths(body.paths ?? body.path);
      const destinationPath = resolveInputPath(body.destinationPath);
      await assertSafeFilesystemNode(destinationPath);
      await assertDirectory(destinationPath);
      const entries: FileEntry[] = [];
      for (const sourcePath of sources) {
        const targetPath = path.join(
          destinationPath,
          path.basename(sourcePath),
        );
        await assertCurrentMutableTarget(targetPath);
        entries.push(await copyFilesystemNode(sourcePath, targetPath));
      }
      res.status(201).json({ status: "ok", entries });
    }),
  );

  router.post(
    "/move",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req);
      const sources = resolveInputPaths(body.paths ?? body.path);
      const destinationPath = resolveInputPath(body.destinationPath);
      await assertSafeFilesystemNode(destinationPath);
      await assertDirectory(destinationPath);
      const entries: FileEntry[] = [];
      const allowCurrentSystemWrite = currentAllowSystemWrite();
      for (const sourcePath of sources) {
        const targetPath = path.join(
          destinationPath,
          path.basename(sourcePath),
        );
        entries.push(
          await moveFilesystemNode(
            sourcePath,
            targetPath,
            runtimePaths,
            allowCurrentSystemWrite,
          ),
        );
      }
      res.json({ status: "ok", entries });
    }),
  );

  router.post(
    "/run",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req);
      const targetPath = resolveInputPath(body.path);
      await assertCurrentMutableScope(targetPath);
      await assertSafeFilesystemNode(targetPath);
      await assertRegularFile(targetPath);
      await openWithSystemLauncher(targetPath);
      res.json({ status: "ok" });
    }),
  );

  router.delete(
    "/",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req);
      const targetPath = resolveInputPath(body.path);
      await assertCurrentMutableTarget(targetPath);
      await assertSafeFilesystemNode(targetPath);
      const stat = await fsp.stat(targetPath);
      if (stat.isDirectory() && body.recursive !== true) {
        throw new FileManagerError(
          400,
          "recursive=true is required for directories",
        );
      }
      await fsp.rm(targetPath, {
        recursive: stat.isDirectory(),
        force: false,
      });
      res.json({ status: "ok" });
    }),
  );

  router.get(
    "/download",
    asyncRoute(async (req, res) => {
      const targetPath = resolveInputPath(req.query.path);
      await assertSafeFilesystemNode(targetPath);
      const stat = await assertRegularFile(targetPath);
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        contentDispositionFilename(path.basename(targetPath)),
      );
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(targetPath);
        stream.on("error", reject);
        stream.on("end", resolve);
        stream.pipe(res);
      });
    }),
  );

  router.get(
    "/download-archive",
    asyncRoute(async (req, res) => {
      const sourcePaths = resolveInputPaths(req.query.paths ?? req.query.path);
      await sendArchiveDownload(res, sourcePaths);
    }),
  );

  router.get(
    "/preview",
    asyncRoute(async (req, res) => {
      const targetPath = resolveInputPath(req.query.path);
      await sendPreviewFile(req, res, targetPath);
    }),
  );

  router.post(
    "/upload",
    asyncRoute(async (req, res) => {
      const boundary = multipartBoundary(req);
      const body = await readRequestBuffer(req, MAX_UPLOAD_BYTES + 1024 * 1024);
      const form = parseMultipartForm(body, boundary);
      const parentPath = resolveInputPath(
        form.fields.parentPath || form.fields.path,
      );
      await assertSafeFilesystemNode(parentPath);
      await assertDirectory(parentPath);
      const uploaded =
        form.files.find((file) => file.field === "file") || form.files[0];
      if (!uploaded) {
        throw new FileManagerError(400, "file is required");
      }
      if (uploaded.data.length > MAX_UPLOAD_BYTES) {
        throw new FileManagerError(413, "uploaded file exceeds the size limit");
      }
      const name = validateName(uploaded.filename);
      const targetPath = path.join(parentPath, name);
      await assertCurrentMutableTarget(targetPath);
      if (fs.existsSync(targetPath)) {
        throw new FileManagerError(409, "target already exists");
      }
      await fsp.writeFile(targetPath, uploaded.data, { mode: 0o644 });
      res
        .status(201)
        .json({ status: "ok", entry: await entryFromPath(targetPath) });
    }),
  );

  return router;
}
