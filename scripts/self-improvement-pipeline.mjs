#!/usr/bin/env node
/**
 * Safe, isolated source-development and release promotion pipeline.
 * The active release pointer is switched atomically; previous releases are retained for rollback.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0] || "help";
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const deployRoot = path.resolve(option("--deploy-root", path.join(projectRoot, ".miki-deployments")));
const stagingRoot = path.join(deployRoot, "staging");
const releasesRoot = path.join(deployRoot, "releases");
const activePointer = path.join(deployRoot, "active-release.json");
const historyFile = path.join(deployRoot, "deployment-history.json");
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function fail(message) { throw new Error(message); }
function ensureRoots() { fs.mkdirSync(stagingRoot, { recursive: true }); fs.mkdirSync(releasesRoot, { recursive: true }); }
function safeId(value) { if (!idPattern.test(String(value || ""))) fail("Invalid release ID."); return String(value); }
function hashTree(root) {
  const entries = [];
  const excluded = new Set([".git", "node_modules", "dist", ".miki-deployments", "coverage", "data", "logs"]);
  const visit = (dir, relative = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name) || entry.name === ".env" || (entry.name.startsWith(".env.") && entry.name !== ".env.example")) continue;
      const rel = path.posix.join(relative.split(path.sep).join("/"), entry.name);
      if (rel === "miki-release-manifest.json") continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail(`Release input contains a symlink: ${rel}`);
      if (entry.isDirectory()) visit(full, rel);
      else if (entry.isFile()) entries.push({ path: rel, sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") });
    }
  };
  visit(root);
  return { entries, sha256: crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function copyCandidate(sourceDir, destination) {
  const source = fs.realpathSync(sourceDir);
  if (!fs.statSync(source).isDirectory()) fail("Candidate source must be a directory.");
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    filter: (candidate) => {
      const relative = path.relative(source, candidate);
      const segments = relative.split(path.sep).filter(Boolean);
      const excludedDirectory = segments.some((segment) => [".git", "node_modules", "dist", ".miki-deployments", "coverage", "data", "logs"].includes(segment));
      return !excludedDirectory
        && path.basename(candidate) !== ".env"
        && (!path.basename(candidate).startsWith(".env.") || path.basename(candidate) === ".env.example")
        && !fs.lstatSync(candidate).isSymbolicLink();
    },
  });
}
function verifyManifest(root, manifest) {
  const actual = hashTree(root);
  if (actual.sha256 !== manifest.sha256) fail("Staged source changed after its manifest was created.");
}
function run(commandName, commandArgs, cwd) {
  const executable = process.platform === "win32" && commandName === "npm" ? "npm.cmd" : commandName;
  const result = spawnSync(executable, commandArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" && commandName === "npm", env: { ...process.env, CI: "1", MIKI_SELF_IMPROVEMENT_PIPELINE: "1" } });
  if (result.error) fail(`${commandName} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${commandName} ${commandArgs.join(" ")} failed with exit code ${result.status ?? 1}.`);
}
function loadManifest(id) {
  const file = path.join(stagingRoot, id, "miki-release-manifest.json");
  const manifest = readJson(file);
  if (!manifest || manifest.releaseId !== id) fail(`Staged release ${id} was not found or its manifest is invalid.`);
  verifyManifest(path.join(stagingRoot, id), manifest);
  return { file, manifest };
}

try {
  ensureRoots();
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`Usage:
  node scripts/self-improvement-pipeline.mjs stage <candidate-dir> --id <release-id>
  node scripts/self-improvement-pipeline.mjs verify <release-id>
  node scripts/self-improvement-pipeline.mjs activate <release-id>
  node scripts/self-improvement-pipeline.mjs rollback
  node scripts/self-improvement-pipeline.mjs status

Staging excludes secrets, runtime data, node_modules, generated output and symlinks.
Activation only changes the atomic release pointer; the service manager must launch from that release root.`);
  } else if (command === "stage") {
    const sourceDir = args[1];
    const id = safeId(option("--id", `candidate-${new Date().toISOString().replace(/[:.]/g, "-")}`));
    if (!sourceDir) fail("stage requires a candidate source directory.");
    const destination = path.join(stagingRoot, id);
    if (fs.existsSync(destination)) fail(`Staging directory already exists: ${id}`);
    fs.mkdirSync(destination, { recursive: true });
    try {
      copyCandidate(sourceDir, destination);
      const manifestData = hashTree(destination);
      const manifest = { schemaVersion: 1, releaseId: id, createdAt: new Date().toISOString(), source: path.resolve(sourceDir), sha256: manifestData.sha256, files: manifestData.entries.length, verified: false };
      fs.writeFileSync(path.join(destination, "miki-release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      console.log(JSON.stringify(manifest, null, 2));
    } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
  } else if (command === "verify") {
    const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
    if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) fail(`Node.js >=22.19.0 is required for release verification; current runtime is ${process.versions.node}.`);
    const id = safeId(args[1]);
    const { file, manifest } = loadManifest(id);
    const stageDir = path.join(stagingRoot, id);
    if (!fs.existsSync(path.join(stageDir, "package-lock.json"))) fail("Candidate must include package-lock.json for reproducible installation.");
    run("npm", ["ci"], stageDir);
    run("npm", ["run", "verify"], stageDir);
    manifest.verified = true;
    manifest.verifiedAt = new Date().toISOString();
    manifest.verificationCommand = "npm ci && npm run verify";
    atomicJson(file, manifest);
    console.log(`Verified release ${id}.`);
  } else if (command === "activate") {
    const id = safeId(args[1]);
    const { manifest } = loadManifest(id);
    if (manifest.verified !== true || !manifest.verifiedAt) fail("Release has not passed the complete verification gate.");
    const destination = path.join(releasesRoot, id);
    if (!fs.existsSync(destination)) fs.cpSync(path.join(stagingRoot, id), destination, { recursive: true, errorOnExist: true });
    const releaseManifest = readJson(path.join(destination, "miki-release-manifest.json"));
    if (!releaseManifest || releaseManifest.sha256 !== manifest.sha256 || releaseManifest.verified !== true) fail("Promoted release manifest does not match the verified candidate.");
    const previous = readJson(activePointer);
    const history = readJson(historyFile, []);
    const next = { releaseId: id, releasePath: destination, activatedAt: new Date().toISOString(), previousReleaseId: previous?.releaseId ?? null, sha256: manifest.sha256 };
    if (previous?.releaseId && previous.releaseId !== id) history.push({ ...previous, deactivatedAt: new Date().toISOString() });
    atomicJson(historyFile, history.slice(-50));
    atomicJson(activePointer, next);
    console.log(JSON.stringify({ activated: next, previousReleaseRetained: Boolean(previous?.releaseId) }, null, 2));
  } else if (command === "rollback") {
    const current = readJson(activePointer);
    const history = readJson(historyFile, []);
    if (!current?.releaseId) fail("There is no active release to roll back.");
    const previous = [...history].reverse().find((entry) => entry.releaseId && entry.releaseId !== current.releaseId && fs.existsSync(entry.releasePath));
    if (!previous) fail("No retained previous release is available for rollback.");
    atomicJson(historyFile, [...history, { ...current, deactivatedAt: new Date().toISOString(), rollbackReason: "operator_or_supervisor_rollback" }].slice(-50));
    atomicJson(activePointer, { releaseId: previous.releaseId, releasePath: previous.releasePath, activatedAt: new Date().toISOString(), previousReleaseId: current.releaseId, sha256: previous.sha256, rollback: true });
    console.log(`Rolled back from ${current.releaseId} to ${previous.releaseId}.`);
  } else if (command === "status") {
    console.log(JSON.stringify({ active: readJson(activePointer), staged: fs.readdirSync(stagingRoot).filter((id) => fs.statSync(path.join(stagingRoot, id)).isDirectory()), releases: fs.readdirSync(releasesRoot).filter((id) => fs.statSync(path.join(releasesRoot, id)).isDirectory()), history: readJson(historyFile, []) }, null, 2));
  } else fail(`Unknown command: ${command}`);
} catch (error) {
  console.error(`[self-improvement-pipeline] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
