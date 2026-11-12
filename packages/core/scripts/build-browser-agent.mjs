import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const source = path.join(packageRoot, "src/plugins/browser/extension");
const output = path.join(packageRoot, "dist/plugins/browser/extension");
const commonFiles = ["service-worker.js", "content.js", "options.html", "options.js", "popup.html", "popup.js"];
const targets = [
  ["chrome", "manifest.chrome.json"],
  ["firefox", "manifest.firefox.json"],
  ["safari", "manifest.safari.json"],
];

for (const [target, manifestName] of targets) {
  const manifestPath = path.join(source, manifestName);
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing ${target} browser manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.manifest_version !== 3) throw new Error(`${target} extension must use Manifest V3.`);
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes("tabs") || !manifest.permissions.includes("storage")) {
    throw new Error(`${target} extension is missing required WebExtensions permissions.`);
  }
  for (const file of commonFiles) {
    if (!fs.existsSync(path.join(source, file))) throw new Error(`Missing ${target} extension asset: ${file}`);
  }
  const targetDir = path.join(output, target);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of commonFiles) fs.copyFileSync(path.join(source, file), path.join(targetDir, file));
  fs.copyFileSync(manifestPath, path.join(targetDir, "manifest.json"));
}

console.log(`Browser Agent extensions prepared in ${output} (Chrome/Chromium, Firefox and Safari source bundle).`);
