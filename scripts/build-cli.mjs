import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const cliDir = path.join(root, "packages", "Hiro-cli");
const outDir = path.join(cliDir, "dist", "bin");
const exe = "Hiro-cli";

fs.mkdirSync(outDir, { recursive: true });

const result = spawnSync(
  "go",
  [
    "build",
    "-trimpath",
    "-buildvcs=false",
    "-ldflags",
    "-s -w",
    "-o",
    path.join(outDir, exe),
    ".",
  ],
  {
    cwd: cliDir,
    stdio: "inherit",
    shell: false,
  },
);

if (result.error && result.error.code === 'ENOENT') {
  console.warn("Go is not installed on this system. Skipping Hiro-cli build.");
  process.exit(0);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Built ${path.relative(root, path.join(outDir, exe))}`);
