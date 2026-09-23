import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Assembles a fully self-contained publishable bundle inside
// packages/cli/dist/pack/, so that `npm pack` / `npm publish` on this single
// package ships 100% of Agent Miki: gateway, core (incl. the bundled
// llama.cpp native binary when present), memory, config, installer, skills,
// the built frontend, and the compiled TypeScript terminal dashboard.
//
// A single published bin command, `miki`, is the only public entry point.
// See dist/pack/bin/miki.js (a copy of the repo root's bin/miki.js) for the
// startup orchestration (memory service + gateway/core, with the TypeScript
// dashboard CLI as the portable runtime controller).

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
const skipNativeRebuild = process.env.MIKI_PACK_SKIP_NATIVE_REBUILD === "1";

if (!skipNativeRebuild) {
  console.log("[pack-self-contained] Rebuilding better-sqlite3 for the packaging Node.js runtime...");
  run("npm", ["rebuild", "better-sqlite3"], { cwd: repoRoot });
}

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
const typescriptCliExists = fs.existsSync(path.join(packDir, "packages", "cli", "dist", "cli.js"));
if (!typescriptCliExists) throw new Error("TypeScript CLI artifact is missing from the runtime bundle.");
console.log("[pack-self-contained] TypeScript dashboard CLI included: no Go toolchain is required.");

console.log(`[pack-self-contained] Ready: ${path.relative(repoRoot, packDir)} (v${cliPkg.version})`);
