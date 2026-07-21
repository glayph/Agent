import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const cliExe = "Hiro-cli";
const webExe = "Hiro-web";

const requiredOutputs = [
  "packages/config/dist/index.js",
  "packages/installer/dist/index.js",
  "packages/skills/dist/index.js",
  "packages/core/dist/api/index.js",
  "packages/gateway/dist/index.js",
  "packages/ui/frontend/dist/index.html",
  `packages/ui/backend/dist/bin/${webExe}`,
  `packages/cli/dist/bin/${cliExe}`,
  "dist/runtime/runtime-loader.mjs",
  `dist/runtime/bin/${cliExe}`,
  "dist/runtime/packages/gateway/dist/index.js",
  "dist/runtime/packages/ui/frontend/dist/index.html",
];

const typescriptBuildInputs = [
  "tsconfig.json",
  "tsconfig.base.json",
];

const dashboardBuildInputs = [
  "packages/ui/frontend/src",
  "packages/ui/frontend/public",
  "packages/ui/frontend/scripts",
  "packages/ui/frontend/index.html",
  "packages/ui/frontend/package.json",
  "packages/ui/frontend/pnpm-lock.yaml",
  "packages/ui/frontend/tsconfig.json",
  "packages/ui/frontend/tsconfig.app.json",
  "packages/ui/frontend/tsconfig.node.json",
  "packages/ui/frontend/vite.config.ts",
  "scripts/frontend-pnpm.mjs",
];

const goBackendBuildInputs = [
  "packages/ui/backend",
  "scripts/build-go-backend.mjs",
];

const buildGroups = [
  {
    name: "config",
    inputs: [
      "packages/config/src",
      "packages/config/tsconfig.json",
      ...typescriptBuildInputs,
    ],
    outputs: ["packages/config/dist"],
    ignoreTests: true,
  },
  {
    name: "installer",
    inputs: [
      "packages/installer/src",
      "packages/installer/tsconfig.json",
      ...typescriptBuildInputs,
    ],
    outputs: ["packages/installer/dist"],
    ignoreTests: true,
  },
  {
    name: "skills",
    inputs: [
      "packages/skills/src",
      ...typescriptBuildInputs,
    ],
    outputs: ["packages/skills/dist"],
    ignoreTests: true,
  },
  {
    name: "core",
    inputs: [
      "packages/core/src",
      "packages/core/tsconfig.json",
      ...typescriptBuildInputs,
    ],
    outputs: ["packages/core/dist"],
    ignoreTests: true,
  },
  {
    name: "gateway",
    inputs: [
      "packages/gateway/src",
      "packages/gateway/tsconfig.json",
      ...typescriptBuildInputs,
    ],
    outputs: ["packages/gateway/dist"],
    ignoreTests: true,
  },
  {
    name: "dashboard",
    inputs: dashboardBuildInputs,
    outputs: [
      "packages/ui/frontend/dist",
      "packages/ui/backend/dist/index.html",
    ],
    ignoreTests: true,
  },
  {
    name: "go backend",
    inputs: goBackendBuildInputs,
    outputs: [`packages/ui/backend/dist/bin/${webExe}`],
  },
  {
    name: "go cli",
    inputs: ["packages/Hiro-cli", "scripts/build-cli.mjs"],
    outputs: [`packages/cli/dist/bin/${cliExe}`],
  },
  {
    name: "runtime package",
    inputs: [
      "packages/config/dist",
      "packages/installer/dist",
      "packages/skills/dist",
      "packages/core/dist",
      "packages/gateway/dist",
      "packages/ui/frontend/dist",
      "packages/ui/backend/dist/bin",
      "packages/cli/dist/bin",
      "package.json",
      "package-lock.json",
      "packages/config/package.json",
      "packages/installer/package.json",
      "packages/skills/package.json",
      "packages/core/package.json",
      "packages/gateway/package.json",
      "scripts/prepare-runtime-package.mjs",
    ],
    outputs: ["dist/runtime"],
  },
];

const ignoredDirs = new Set([
  ".git",
  ".codex-temp",
  "data",
  "dist",
  "node_modules",
  "output",
]);

function npmCommand() {
  return { command: "npm", args: [] };
}

function statMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function isIgnoredFile(relativePath, options = {}) {
  if (!options.ignoreTests) return false;
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized.includes("/__tests__/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized)
  );
}

function newestMtime(target, options = {}) {
  const fullPath = path.join(root, target);
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return { mtime: 0, path: target };
  }

  if (!stat.isDirectory()) {
    return isIgnoredFile(target, options)
      ? { mtime: 0, path: target }
      : { mtime: stat.mtimeMs, path: target };
  }

  let newest = { mtime: 0, path: target };
  for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const child = path.join(target, entry.name);
    const childNewest = newestMtime(child, options);
    if (childNewest.mtime > newest.mtime) newest = childNewest;
  }
  return newest;
}

function missingRequiredOutput() {
  for (const relativePath of requiredOutputs) {
    const mtime = statMtimeMs(path.join(root, relativePath));
    if (mtime === null) return relativePath;
  }
  return null;
}

function buildReason() {
  const missing = missingRequiredOutput();
  if (missing) return `required runtime output is missing: ${missing}`;

  for (const group of buildGroups) {
    const newestInput = group.inputs.reduce(
      (best, input) => {
        const current = newestMtime(input, { ignoreTests: group.ignoreTests });
        return current.mtime > best.mtime ? current : best;
      },
      { mtime: 0, path: "" },
    );
    const newestOutput = group.outputs.reduce(
      (best, output) => {
        const current = newestMtime(output);
        return current.mtime > best.mtime ? current : best;
      },
      { mtime: 0, path: "" },
    );

    if (newestOutput.mtime === 0) {
      return `${group.name} output is missing`;
    }
    if (newestInput.mtime > newestOutput.mtime + 1) {
      return `${group.name} input ${newestInput.path} is newer than ${newestOutput.path}`;
    }
  }

  return null;
}

const reason = buildReason();
if (!reason) {
  console.log("Runtime build artifacts are current; skipping full build.");
  process.exit(0);
}

console.log(`Runtime build artifacts are stale: ${reason}.`);
const npm = npmCommand();
const result = spawnSync(npm.command, [...npm.args, "run", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

process.exit(result.status ?? 1);
