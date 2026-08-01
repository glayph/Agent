import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const targets = [
  "dist",
  "packages/config/dist",
  "packages/core/dist",
  "packages/gateway/dist",
  "packages/installer/dist",
  "packages/skills/dist",
  "packages/ui/frontend/dist",
  "packages/ui/backend/dist",
  "packages/Hiro-cli/dist",
  "packages/ui/frontend/node_modules/node_modules",
];

for (const relative of targets) {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Refusing to remove outside workspace: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
