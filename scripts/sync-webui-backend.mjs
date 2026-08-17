import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const frontendDist = path.join(
  root,
  "packages",
  "ui",
  "frontend",
  "dist",
);
const backendDist = path.join(
  root,
  "packages",
  "ui",
  "backend",
  "dist",
);

function assertWorkspacePath(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (
    resolved === root ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to mutate path outside workspace: ${resolved}`);
  }
}

function copyRecursive(source, destination) {
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

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

if (!fs.existsSync(path.join(frontendDist, "index.html"))) {
  throw new Error(
    "Frontend dist is missing. Run `npm run build:webui` before syncing backend dashboard assets.",
  );
}

assertWorkspacePath(backendDist);
fs.mkdirSync(backendDist, { recursive: true });
for (const entry of fs.readdirSync(backendDist, { withFileTypes: true })) {
  if (entry.name === "bin") continue;
  fs.rmSync(path.join(backendDist, entry.name), { recursive: true, force: true });
}
copyRecursive(frontendDist, backendDist);

fs.writeFileSync(
  path.join(backendDist, ".gitkeep"),
  "# Keep the embedded web backend dist directory in version control.\n",
);

console.log(
  `Synced dashboard assets from ${path.relative(
    root,
    frontendDist,
  )} to ${path.relative(root, backendDist)}`,
);
