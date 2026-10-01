import * as path from "path";
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
): MemoryPaths {
  const root = path.resolve(override?.trim() ? override : identityDir);
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
export function isMemoryFile(paths: MemoryPaths, absolute: string): boolean {
  const resolved = path.resolve(absolute);
  if (resolved === paths.memoryMd) return true;
  const rel = path.relative(paths.dailyDir, resolved);
  return (
    !!rel &&
    !rel.startsWith("..") &&
    !path.isAbsolute(rel) &&
    resolved.toLowerCase().endsWith(".md")
  );
}
