import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const backendDir = path.join(root, "packages", "ui", "backend");
const outDir = path.join(backendDir, "dist", "bin");
const exe = "Hiro-web";

fs.mkdirSync(outDir, { recursive: true });

console.log("Building Go compatibility stub backend (legacy_backend tag is not part of the default build).");

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
    cwd: backendDir,
    stdio: "inherit",
    shell: false,
  },
);

if (result.error && result.error.code === 'ENOENT') {
  console.warn("Go is not installed on this system. Skipping go-backend build.");
  process.exit(0);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
