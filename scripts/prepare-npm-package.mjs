import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const runtimeRoot = path.join(root, "dist", "runtime");

function copyRecursive(source, destination) {
  if (!fs.existsSync(source)) return;
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyRecursive(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (path.extname(source).toLowerCase() === ".map") return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

const packageNames = ["config", "installer", "skills", "core", "gateway"];

for (const name of packageNames) {
  const packageDir = path.join(root, "packages", name);
  const runtimePackageDir = path.join(runtimeRoot, "packages", name);
  copyRecursive(path.join(packageDir, "dist"), path.join(runtimePackageDir, "dist"));
  copyRecursive(path.join(packageDir, "package.json"), path.join(runtimePackageDir, "package.json"));
  if (name === "skills") {
    copyRecursive(path.join(packageDir, "src"), path.join(runtimePackageDir, "src"));
  }
  // Replace workspace:^ protocol with actual version in copied package.json
  const pkgJsonPath = path.join(runtimePackageDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    let pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    if (pkg.dependencies) {
      for (const [dep, ver] of Object.entries(pkg.dependencies)) {
        if (ver.startsWith("workspace:")) {
          pkg.dependencies[dep] = "^1.0.0";
        }
      }
    }
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  }
}

copyRecursive(path.join(root, "packages", "ui", "frontend", "dist"), path.join(runtimeRoot, "packages", "ui", "frontend", "dist"));
copyRecursive(path.join(root, "packages", "ui", "frontend", "dist"), path.join(runtimeRoot, "packages", "ui", "backend", "dist"));
copyRecursive(path.join(root, "packages", "ui", "backend", "dist", "bin"), path.join(runtimeRoot, "packages", "ui", "backend", "dist", "bin"));
copyRecursive(path.join(root, "packages", "cli", "dist", "bin"), path.join(runtimeRoot, "bin"));

const loaderContent = `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const loaderDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(process.env.Hiro_RUNTIME_ROOT || loaderDir);
const packageMap = new Map([
  ["@hiro/config", "packages/config/dist/index.js"],
  ["@hiro/config/security", "packages/config/dist/security.js"],
  ["@hiro/installer", "packages/installer/dist/index.js"],
  ["@hiro/skills", "packages/skills/dist/index.js"],
  ["@hiro/core", "packages/core/dist/api/index.js"],
  ["@hiro/gateway", "packages/gateway/dist/index.js"],
]);

export async function resolve(specifier, context, nextResolve) {
  const mapped = packageMap.get(specifier);
  if (mapped) {
    return {url: pathToFileURL(path.join(runtimeRoot, mapped)).href, shortCircuit: true};
  }

  for (const [prefix, target] of packageMap) {
    if (specifier.startsWith(prefix + "/")) {
      const sub = specifier.slice(prefix.length + 1);
      const resolved = path.join(path.dirname(target), sub) + ".js";
      const fullPath = path.join(runtimeRoot, resolved);

      if (fs.existsSync(fullPath)) {
        return {url: pathToFileURL(fullPath).href, shortCircuit: true};
      }
    }
  }
  return nextResolve(specifier, context);
}`;

fs.writeFileSync(path.join(runtimeRoot, "runtime-loader.mjs"), loaderContent, "utf-8");

copyRecursive(path.join(root, "config"), path.join(runtimeRoot, "config"));
const envSrc = path.join(root, ".env.example");
if (fs.existsSync(envSrc)) fs.copyFileSync(envSrc, path.join(runtimeRoot, ".env.example"));
const licenseSrc = path.join(root, "LICENSE");
if (fs.existsSync(licenseSrc)) fs.copyFileSync(licenseSrc, path.join(runtimeRoot, "LICENSE"));

console.log("Prepared runtime package at dist/runtime");
