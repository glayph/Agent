import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const runtimeRoot = path.join(root, "dist", "runtime");
const stagingRoot = path.join(root, "dist", `.runtime-staging-${process.pid}`);
const removeOptions = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
};

const packageNames = [
  "config",
  "installer",
  "skills",
  "core",
  "gateway",
];

function shouldCopyRuntimeFile(source) {
  return path.extname(source).toLowerCase() !== ".map";
}

function copyRecursive(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(
      `Required build artifact is missing: ${path.relative(root, source)}`,
    );
  }
  const stat = fs.statSync(source);
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
  if (!shouldCopyRuntimeFile(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function assertSafeWorkspacePath(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (
    resolved === root ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to remove path outside workspace: ${resolved}`);
  }
}

function isRetriableRemoveError(error) {
  return (
    error &&
    typeof error === "object" &&
    ["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)
  );
}

function chmodRecursive(target) {
  if (!fs.existsSync(target)) return;

  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }

  try {
    fs.chmodSync(target, stat.isDirectory() ? 0o777 : 0o666);
  } catch {
    // Best-effort only. The follow-up rmSync preserves the real failure.
  }

  if (!stat.isDirectory() || stat.isSymbolicLink()) return;

  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    chmodRecursive(path.join(target, entry.name));
  }
}

function removeRuntimeRoot() {
  assertSafeWorkspacePath(runtimeRoot);
  if (!fs.existsSync(runtimeRoot)) return;

  try {
    fs.rmSync(runtimeRoot, removeOptions);
    return;
  } catch (error) {
    if (!isRetriableRemoveError(error)) {
      throw error;
    }
  }

  chmodRecursive(runtimeRoot);

  try {
    fs.rmSync(runtimeRoot, removeOptions);
  } catch (error) {
    throw new Error(
      `Failed to remove ${runtimeRoot}. Close any process using dist/runtime and retry.`,
      { cause: error },
    );
  }
}

function removeStagingRoot() {
  assertSafeWorkspacePath(stagingRoot);
  fs.rmSync(stagingRoot, removeOptions);
}

function removeEmptyDirectories(target) {
  if (!fs.existsSync(target)) return;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      removeEmptyDirectories(child);
    }
  }
  try {
    fs.rmdirSync(target);
  } catch {
    // Locked or non-empty directories can remain during an in-place runtime
    // refresh. The active runtime keeps using the old path while new files are
    // copied over for the next launch.
  }
}

function syncRuntimeDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const sourceEntries = new Set(fs.readdirSync(source));

  for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
    if (sourceEntries.has(entry.name)) continue;
    const target = path.join(destination, entry.name);
    chmodRecursive(target);
    try {
      fs.rmSync(target, removeOptions);
    } catch (error) {
      if (!isRetriableRemoveError(error)) throw error;
      console.warn(
        `Leaving locked stale runtime entry in place: ${path.relative(root, target)}`,
      );
    }
  }

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourceChild = path.join(source, entry.name);
    const destinationChild = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      syncRuntimeDirectory(sourceChild, destinationChild);
      continue;
    }
    fs.mkdirSync(path.dirname(destinationChild), { recursive: true });
    try {
      fs.copyFileSync(sourceChild, destinationChild);
    } catch (error) {
      if (!isRetriableRemoveError(error) || !fs.existsSync(destinationChild)) {
        throw error;
      }
      console.warn(
        `Leaving locked runtime file in place: ${path.relative(root, destinationChild)}`,
      );
    }
  }

  removeEmptyDirectories(destination);
}

function publishRuntimeRoot() {
  assertSafeWorkspacePath(runtimeRoot);
  assertSafeWorkspacePath(stagingRoot);

  try {
    removeRuntimeRoot();
    fs.renameSync(stagingRoot, runtimeRoot);
    return;
  } catch (error) {
    if (!isRetriableRemoveError(error.cause || error)) {
      throw error;
    }
  }

  console.warn(
    "dist/runtime is locked by an active process; refreshing runtime files in place.",
  );
  syncRuntimeDirectory(stagingRoot, runtimeRoot);
  removeStagingRoot();
}

removeStagingRoot();
fs.mkdirSync(stagingRoot, { recursive: true });

for (const name of packageNames) {
  const packageDir = path.join(root, "packages", name);
  const runtimePackageDir = path.join(stagingRoot, "packages", name);
  copyRecursive(
    path.join(packageDir, "dist"),
    path.join(runtimePackageDir, "dist"),
  );
  copyRecursive(
    path.join(packageDir, "package.json"),
    path.join(runtimePackageDir, "package.json"),
  );
  if (name === "skills") {
    copyRecursive(
      path.join(packageDir, "src"),
      path.join(runtimePackageDir, "src"),
    );
  }

  // Copy workspace package into node_modules for resolution
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"));
  const pkgNmDir = path.join(stagingRoot, "node_modules", pkg.name);
  fs.mkdirSync(path.dirname(pkgNmDir), { recursive: true });
  copyRecursive(path.join(runtimePackageDir, "dist"), path.join(pkgNmDir, "dist"));
  copyRecursive(path.join(runtimePackageDir, "package.json"), path.join(pkgNmDir, "package.json"));
}

// Copy production npm dependencies from root node_modules (excluding dev-only packages)
const rootNm = path.join(root, "node_modules");
const stagingNm = path.join(stagingRoot, "node_modules");
const devExcludePrefixes = new Set([
  "prettier", "eslint", "jest", "nodemon", "rimraf",
  "rollup", "vite", "vitest", "babel", "typescript",
  "turbo", "ts-jest", "ts-node",
  // Also skip large test/build tooling
  "webpack", "esbuild", "parcel", "swc",
]);
const scopedDevExcludes = new Set([
  "types", "typescript-eslint", "eslint", "jest", "babel", "vitejs", "trivago",
  "testing-library", "storybook",
]);
// Directories inside node_modules that are never needed at runtime
const alwaysExcludeNames = new Set([".cache", ".turbo", ".git", ".github", ".ignored", ".pnpm"]);

let copiedCount = 0;
for (const entry of fs.readdirSync(rootNm, { withFileTypes: true })) {
  if (entry.name === ".bin" || !entry.isDirectory()) continue;
  if (alwaysExcludeNames.has(entry.name)) continue;
  // Skip known dev-only packages
  if (devExcludePrefixes.has(entry.name)) continue;
  // Skip dev-only scoped packages
  if (entry.name.startsWith("@")) {
    let skipScope = false;
    try {
      for (const sub of fs.readdirSync(path.join(rootNm, entry.name), { withFileTypes: true })) {
        if (scopedDevExcludes.has(sub.name)) { skipScope = true; break; }
      }
    } catch { /* best-effort */ }
    if (skipScope) continue;
  }
  const src = path.join(rootNm, entry.name);
  const dest = path.join(stagingNm, entry.name);
  if (!fs.existsSync(dest)) {  // skip if already copied by workspace package step
    copyRecursive(src, dest);
    copiedCount++;
    if (copiedCount % 10 === 0) {
      process.stdout.write(`  Copied ${copiedCount} node_modules packages...\r`);
    }
  }
}
process.stdout.write(`  Copied ${copiedCount} node_modules packages.     \n`);

copyRecursive(
  path.join(root, "packages", "ui", "frontend", "dist"),
  path.join(stagingRoot, "packages", "ui", "frontend", "dist"),
);
copyRecursive(
  path.join(root, "packages", "ui", "frontend", "dist"),
  path.join(stagingRoot, "packages", "ui", "backend", "dist"),
);
copyRecursive(
  path.join(root, "packages", "ui", "backend", "dist", "bin"),
  path.join(stagingRoot, "packages", "ui", "backend", "dist", "bin"),
);
copyRecursive(
  path.join(root, "packages", "cli", "dist", "bin"),
  path.join(stagingRoot, "bin"),
);

fs.writeFileSync(
  path.join(stagingRoot, "runtime-loader.mjs"),
  `import path from "node:path";\nimport { fileURLToPath, pathToFileURL } from "node:url";\n\nconst loaderDir = path.dirname(fileURLToPath(import.meta.url));\nconst runtimeRoot = path.resolve(process.env.Hiro_RUNTIME_ROOT || loaderDir);\nconst packageMap = new Map([\n  ["@hiro/config", "packages/config/dist/index.js"],\n  ["@hiro/config/security", "packages/config/dist/security.js"],\n  ["@hiro/installer", "packages/installer/dist/index.js"],\n  ["@hiro/skills", "packages/skills/dist/index.js"],\n  ["@hiro/core", "packages/core/dist/api/index.js"],\n  ["@hiro/gateway", "packages/gateway/dist/index.js"],\n]);\n\nexport async function resolve(specifier, context, nextResolve) {\n  const mapped = packageMap.get(specifier);\n  if (mapped) {\n    return { url: pathToFileURL(path.join(runtimeRoot, mapped)).href, shortCircuit: true };\n  }\n  return nextResolve(specifier, context);\n}\n`,
  "utf-8",
);

copyRecursive(
  path.join(root, "config"),
  path.join(stagingRoot, "config"),
);

const envSrc = path.join(root, ".env.example");
if (fs.existsSync(envSrc)) {
  fs.copyFileSync(envSrc, path.join(stagingRoot, ".env.example"));
}

const licenseSrc = path.join(root, "LICENSE");
if (fs.existsSync(licenseSrc)) {
  fs.copyFileSync(licenseSrc, path.join(stagingRoot, "LICENSE"));
}

publishRuntimeRoot();

console.log(`Prepared runtime package at ${path.relative(root, runtimeRoot)}`);
