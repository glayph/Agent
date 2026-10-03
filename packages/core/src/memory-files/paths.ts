import * as path from "path";
import * as fs from "fs";
import type { MemoryPaths } from "./types.js";

export const MEMORY_MD_FILE = "MEMORY.md";
export const MEMORY_DIR_NAME = "memory";

/**
 * Memory lives next to the identity files. It is one systemwide memory for
 * the whole agent, not a per-workspace-folder store.
 */
export function resolveMemoryPaths(
  identityDir: string,
  override?: string,
  scope?: string,
): MemoryPaths {
  const base = path.resolve(override?.trim() ? override : identityDir);
  // Fix #11: an owner/agent/workspace scope gets its own subtree, so two
  // scopes sharing one identity directory can never read each other's
  // MEMORY.md, daily notes or session summaries. The slug is sanitized so a
  // scope value can never escape the base directory.
  const slug = (scope ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
  const root = slug ? path.join(base, "scopes", slug) : base;
  const dailyDir = path.join(root, MEMORY_DIR_NAME);
  return {
    root,
    memoryMd: path.join(root, MEMORY_MD_FILE),
    dailyDir,
    compactionDir: path.join(dailyDir, "compactions"),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Local calendar date, matching how a human names a daily note. */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dailyFileName(d: Date): string {
  return `${formatDate(d)}.md`;
}

export function sessionFileName(d: Date, slug: string): string {
  return `${formatDate(d)}-${pad(d.getHours())}${pad(d.getMinutes())}-${slug}.md`;
}

/** Unicode-aware slug (keeps Bengali letters/marks), bounded and never empty. */
export function slugify(text: string, max = 40): string {
  const s = (text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "session";
}

/** Path relative to the memory root, always with forward slashes. */
export function relFromRoot(paths: MemoryPaths, absolute: string): string {
  return path.relative(paths.root, absolute).split(path.sep).join("/");
}

/**
 * True only for files inside the memory area (MEMORY.md or memory/**.md).
 * Used by memory_get so the tool reads memory, never arbitrary files.
 */
function isMemoryFileLexical(paths: MemoryPaths, absolute: string): boolean {
  const resolved = path.resolve(absolute);
  if (resolved === paths.memoryMd) return true;
  const rel = path.relative(paths.dailyDir, resolved);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel) && resolved.toLowerCase().endsWith(".md");
}

/**
 * Lexical containment is not enough for memory files: an allowed-looking path
 * can be a symlink into an identity/config/OS secret. Existing files are
 * checked against their real path; missing files remain valid so memory_get
 * can retain its empty-file semantics.
 */
export function isMemoryFile(paths: MemoryPaths, absolute: string): boolean {
  if (!isMemoryFileLexical(paths, absolute)) return false;
  try {
    return isMemoryFileLexical(paths, fs.realpathSync.native(path.resolve(absolute)));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function resolveMemoryFile(
  paths: MemoryPaths,
  absolute: string,
): Promise<string | null> {
  const candidate = path.resolve(absolute);
  if (!isMemoryFileLexical(paths, candidate)) return null;
  try {
    const real = await fs.promises.realpath(candidate);
    return isMemoryFileLexical(paths, real) ? real : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
    return null;
  }
}
