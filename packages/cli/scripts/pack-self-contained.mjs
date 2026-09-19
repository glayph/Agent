import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Assembles a fully self-contained publishable bundle inside
// packages/cli/dist/pack/, so that `npm pack` / `npm publish` on this single
// package ships 100% of Agent Miki: gateway, core (incl. the bundled
// llama.cpp native binary when present), memory, config, installer, skills,
// the built frontend, and (when Go is available on the packaging machine)
// the compiled Go TUI dashboard binary.
//
// A single published bin command, `miki`, is the only public entry point.
// See dist/pack/bin/miki.js (a copy of the repo root's bin/miki.js) for the
// startup orchestration (memory service + gateway/core, with the Go
// dashboard binary used when present and a Node CLI fallback otherwise).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(cliDir, "..", "..");
const packDir = path.join(cliDir, "dist", "pack");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(" ")}`);
  }
}

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
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

// Allow skipping the (slow) full monorepo rebuild when the caller already
// ran `npm run build` and `prepare-runtime-package.mjs` themselves, e.g. in
// CI where those are separate, cacheable steps.
const skipBuild = process.env.MIKI_PACK_SKIP_BUILD === "1";

if (!skipBuild) {
  console.log("[pack-self-contained] Building the full Agent Miki runtime...");
  run("npm", ["run", "build"], { cwd: repoRoot });
  run("node", ["scripts/prepare-runtime-package.mjs"], { cwd: repoRoot });
} else {
  console.log("[pack-self-contained] MIKI_PACK_SKIP_BUILD=1 set; assuming dist/runtime is already current.");
}

const runtimeSource = path.join(repoRoot, "dist", "runtime");
if (!fs.existsSync(runtimeSource)) {
  throw new Error(
    `Runtime bundle not found at ${runtimeSource}. Run "npm run build && node scripts/prepare-runtime-package.mjs" from the repo root first.`,
  );
}

console.log("[pack-self-contained] Copying runtime bundle into packages/cli/dist/pack ...");
fs.rmSync(packDir, { recursive: true, force: true });
copyRecursive(runtimeSource, packDir);

// Write this package's own manifest at the pack root so tooling that
// inspects dist/pack directly (or a future split into its own repo) sees a
// consistent, minimal package.json. The actual published manifest is still
// packages/cli/package.json; this is for completeness/debugging only.
const cliPkg = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf-8"));
const dashboardBinaryExists =
  fs.existsSync(path.join(packDir, "bin", "Miki-cli")) ||
  fs.existsSync(path.join(packDir, "bin", "Miki-cli.exe"));

console.log(
  dashboardBinaryExists
    ? "[pack-self-contained] Go dashboard binary included: full TUI experience will be available."
    : "[pack-self-contained] Go dashboard binary NOT found (Go toolchain unavailable during build). " +
        "The package will still work via the bundled Node CLI fallback (headless gateway + web UI), " +
        "but `miki` will not open the interactive terminal dashboard. Build with Go available for the full experience.",
);

console.log(`[pack-self-contained] Ready: ${path.relative(repoRoot, packDir)} (v${cliPkg.version})`);
