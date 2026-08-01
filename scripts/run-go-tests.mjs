import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const modules = [
  "packages/Hiro-cli",
  "packages/ui/backend",
];

for (const relative of modules) {
  const moduleDir = path.join(root, relative);
  if (!fs.existsSync(path.join(moduleDir, "go.mod"))) {
    console.error(`Missing Go module: ${relative}`);
    process.exit(1);
  }

  console.log(`\n> go test ./... (${relative})`);
  const result = spawnSync("go", ["test", "./..."], {
    cwd: moduleDir,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\nGo test suites passed.");
