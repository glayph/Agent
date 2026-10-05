import * as fs from "node:fs";
import * as path from "node:path";
const SENSITIVE_BASENAME = [
    /^\.env(\..*)?$/i,
    /\.(sqlite|sqlite3|db|pem|key|p12|pfx|kdbx)(-wal|-shm)?$/i,
    /^id_(rsa|dsa|ecdsa|ed25519)/i,
    /^secret-vault\.json$/i,
    /^(credentials|auth|token|tokens)\.json$/i,
    /^\.npmrc$/i,
];
export const HIDDEN_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".turbo"]);
/** True for files that commonly hold credentials and must never be exposed to a model. */
export function isSensitivePath(candidate) {
    const base = path.basename(candidate);
    if (SENSITIVE_BASENAME.some((pattern) => pattern.test(base)))
        return true;
    const segments = candidate.split(/[\\/]/);
    return segments.includes(".ssh") || segments.includes(".gnupg");
}
/**
 * Resolve `input` inside `root`. Rejects traversal (`..`) and symlinks that
 * leave the workspace. The returned path is absolute.
 */
export function resolveWorkspacePath(root, input) {
    const rootReal = fs.realpathSync(root);
    const abs = path.resolve(rootReal, input || ".");
    const inside = (candidate) => candidate === rootReal || candidate.startsWith(`${rootReal}${path.sep}`);
    if (!inside(abs))
        throw new Error("Path is outside the workspace.");
    let probe = abs;
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe)
            break;
        probe = parent;
    }
    if (!inside(fs.realpathSync(probe)))
        throw new Error("Path escapes the workspace through a symbolic link.");
    return abs;
}
