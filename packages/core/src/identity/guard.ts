import * as fs from "fs";
import * as path from "path";
import { resolveIdentityPaths } from "./paths.js";

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function normalizeForComparison(p: string): string {
  const resolved = realOrResolved(p);
  // Windows paths are case-insensitive; compare case-insensitively there so
  // "identity/soul.md" can't slip past a "SOUL.md" check on that platform.
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * True when `candidatePath` resolves to this identity directory's SOUL.md.
 * `candidatePath` may be relative or absolute — both are resolved before
 * comparison. Returns false (never protects anything) when no identityDir
 * is configured, so callers don't need to special-case that.
 *
 * SOUL.md is meant to be edited by a human only; no agent tool or function
 * may write or delete it (step 01 behavior contract, item 3). This is
 * checked at the file_write/file_delete chokepoint
 * (tools/executor/file-security.ts), which is the one place every
 * model-directed file operation passes through. It does not stop a raw
 * shell command from editing the file on disk — closing that gap is part of
 * step 04's tool-exec-permissions layer, not this one.
 */
export function isSoulProtectedPath(
  candidatePath: string,
  identityDir: string | null | undefined,
): boolean {
  if (!identityDir || !candidatePath) return false;
  const soulPath = resolveIdentityPaths(identityDir).soul;
  return (
    normalizeForComparison(candidatePath) === normalizeForComparison(soulPath)
  );
}

export const SOUL_PROTECTED_MESSAGE =
  "SOUL.md is read-only to agent tools. Edit it directly as a human (outside any agent tool call) to change it.";
