import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const frontendDir = path.join(root, "packages", "ui", "frontend");
const args = process.argv.slice(2);
const frontendPackage = JSON.parse(
  fs.readFileSync(path.join(frontendDir, "package.json"), "utf-8"),
);
const pnpmSpec = frontendPackage.packageManager || "pnpm@10.33.0";

function resolveCorepackPath() {
  if (process.platform === "win32") {
    // First try: check the node_modules/corepack path (old behavior)
    const bundledPath = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "corepack",
      "dist",
      "corepack.js",
    );
    if (fs.existsSync(bundledPath)) {
      return bundledPath;
    }
    // Second try: check if corepack is on PATH (shim or global install)
    try {
      const result = spawnSync("where", ["corepack"], {
        cwd: root,
        stdio: "pipe",
        shell: true,
      });
      if (result.status === 0 && result.stdout) {
        const corepackPath = result.stdout.toString().trim();
        if (corepackPath && fs.existsSync(corepackPath)) {
          return corepackPath;
        }
      }
    } catch {
      // where command may fail on some systems, ignore
    }
    // Third try: check for corepack.cmd in common locations
    const commonPaths = [
      path.join(path.dirname(process.execPath), "corepack.cmd"),
      path.join(path.dirname(process.execPath), "node_modules", "corepack.cmd"),
      "corepack.cmd",
    ];
    for (const p of commonPaths) {
      try {
        if (fs.existsSync(p)) {
          return p;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }
  // Non-Windows: just use "corepack" command
  return "corepack";
}

function corepackInvocation() {
  const corepackPath = resolveCorepackPath();
  if (!corepackPath) {
    console.error(
      "Corepack not found.\n" +
        "Install it with: npm install -g corepack\n" +
        "Or enable it with: corepack enable\n" +
        "See https://nodejs.org/api/corepack.html for details.",
    );
    process.exit(1);
  }
  if (process.platform === "win32" && corepackPath.endsWith(".cmd")) {
    return {
      command: "cmd",
      args: ["/c", corepackPath],
    };
  }
  if (process.platform === "win32" && corepackPath.endsWith(".js")) {
    return {
      command: process.execPath,
      args: [corepackPath],
    };
  }
  return { command: corepackPath, args: [] };
}

function hasValidInstall() {
  const binName = process.platform === "win32" ? "vite.cmd" : "vite";
  return (
    fs.existsSync(path.join(frontendDir, "node_modules", ".bin", binName)) &&
    fs.existsSync(path.join(frontendDir, "node_modules", "vite", "package.json"))
  );
}

function runCorepackPnpm(pnpmArgs) {
  const result = spawnSync(
    corepackInvocation().command,
    [...corepackInvocation().args, pnpmSpec, "--dir", frontendDir, ...pnpmArgs],
    {
      cwd: root,
      stdio: "inherit",
      shell: false,
    },
  );
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (args.length === 0) {
  console.error("Usage: node scripts/frontend-pnpm.mjs <pnpm-script-or-args>");
  process.exit(1);
}

if (args[0] !== "install" && !hasValidInstall()) {
  runCorepackPnpm(["install", "--frozen-lockfile"]);
}

runCorepackPnpm(args);
