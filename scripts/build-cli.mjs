import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = path.join(root, "packages", "cli");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

if (!fs.existsSync(tsc)) {
  console.error("TypeScript is required to build the Miki CLI. Run npm install first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsc, "-p", path.join(cliDir, "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

if (result.status !== 0) process.exit(result.status ?? 1);

const output = path.join(cliDir, "dist", "cli.js");
if (!fs.existsSync(output)) {
  console.error(`TypeScript build completed without producing ${path.relative(root, output)}`);
  process.exit(1);
}

console.log(`Built ${path.relative(root, output)} (native Go CLI is no longer required).`);
