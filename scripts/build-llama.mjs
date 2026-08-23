#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const localRoot = path.join(
  projectRoot,
  "packages",
  "core",
  "src",
  "llm",
  "local",
);
const sourceCandidates = [
  process.env.MIKI_LLAMA_SOURCE_DIR,
  path.join(localRoot, "miki-native-runtime"),
  path.join(
    localRoot,
    "miki-native-runtime (keep it Always for windows build)",
  ),
].filter(Boolean);
const sourceRoot =
  sourceCandidates.find((candidate) => existsSync(candidate)) ||
  sourceCandidates[0];
const platformKey = `${process.platform}-${process.arch}`;
const executableName =
  process.platform === "win32" ? "llama-server.exe" : "llama-server";
const bundledExecutable = path.join(
  localRoot,
  "native",
  platformKey,
  executableName,
);
const distRoot = path.join(
  projectRoot,
  "packages",
  "core",
  "dist",
  "llm",
  "local",
  "native",
  platformKey,
);
const distExecutable = path.join(distRoot, executableName);
const buildRoot = path.join(
  projectRoot,
  ".miki-build",
  "llama.cpp",
  platformKey,
);
const metadataPath = path.join(distRoot, "build-metadata.json");
const forceRebuild = process.env.MIKI_LLAMA_FORCE_REBUILD === "1";

function log(message) {
  console.log(`[miki:llama] ${message}`);
}

function fail(message) {
  console.error(`[miki:llama] ERROR: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error)
    fail(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} exited with status ${result.status ?? "unknown"}`);
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
  });
  return result.status === 0;
}

function findBuiltExecutable(root) {
  if (!existsSync(root)) return undefined;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (
        entry.isFile() &&
        entry.name.toLowerCase() === executableName.toLowerCase()
      )
        return candidate;
    }
  }
  return undefined;
}

function copyIfDifferent(sourceExecutable, destination) {
  if (path.resolve(sourceExecutable) === path.resolve(destination)) return;
  cpSync(sourceExecutable, destination);
}

function persistArtifact(sourceExecutable, mode) {
  mkdirSync(distRoot, { recursive: true });
  mkdirSync(path.dirname(bundledExecutable), { recursive: true });
  copyIfDifferent(sourceExecutable, distExecutable);
  copyIfDifferent(sourceExecutable, bundledExecutable);
  if (process.platform !== "win32") {
    try {
      chmodSync(distExecutable, 0o755);
    } catch {}
    try {
      chmodSync(bundledExecutable, 0o755);
    } catch {}
  }
  writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        provider: "llama.cpp",
        artifact: executableName,
        platform: process.platform,
        architecture: process.arch,
        mode,
        source_commit: null,
        web_ui: "disabled",
        build_flags: [
          "LLAMA_BUILD_SERVER=ON",
          "LLAMA_BUILD_UI=OFF",
          "LLAMA_USE_PREBUILT_UI=OFF",
          "LLAMA_BUILD_TESTS=OFF",
          "LLAMA_BUILD_EXAMPLES=OFF",
          "LLAMA_BUILD_TOOLS=ON",
          "LLAMA_BUILD_APP=OFF",
          "LLAMA_OPENSSL=OFF",
          "GGML_NATIVE=OFF",
        ],
        generated_at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    path.join(localRoot, "native", platformKey, "build-metadata.json"),
    readFileSync(metadataPath),
  );
}

if (!forceRebuild && existsSync(bundledExecutable)) {
  persistArtifact(bundledExecutable, "bundled");
  log(
    `Using bundled ${platformKey} llama-server artifact; no separate server command is required.`,
  );
  process.exit(0);
}

if (!forceRebuild && existsSync(distExecutable) && existsSync(metadataPath)) {
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (
      metadata.platform === process.platform &&
      metadata.architecture === process.arch &&
      metadata.web_ui === "disabled"
    ) {
      log(
        `llama-server is already built for ${platformKey}; keeping the existing artifact.`,
      );
      process.exit(0);
    }
  } catch {}
}

if (!existsSync(sourceRoot)) {
  fail(
    `Miki native runtime source is unavailable at ${sourceRoot}. Provide a platform-native source bundle or configure an executable_path for ${platformKey}.`,
  );
}

if (!commandExists(process.platform === "win32" ? "cmake.exe" : "cmake")) {
  fail(
    `CMake is required to build the Miki native runtime on ${platformKey}. Install CMake and a C/C++ compiler once, then rerun npm run build:all, or configure an executable_path for a prebuilt runtime.`,
  );
}

mkdirSync(path.dirname(buildRoot), { recursive: true });
const configureArgs = [
  "-S",
  sourceRoot,
  "-B",
  buildRoot,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_SHARED_LIBS=OFF",
  "-DLLAMA_BUILD_SERVER=ON",
  "-DLLAMA_BUILD_UI=OFF",
  "-DLLAMA_USE_PREBUILT_UI=OFF",
  "-DLLAMA_BUILD_TESTS=OFF",
  "-DLLAMA_BUILD_EXAMPLES=OFF",
  "-DLLAMA_BUILD_TOOLS=ON",
  "-DLLAMA_BUILD_APP=OFF",
  "-DLLAMA_BUILD_COMMON=ON",
  "-DLLAMA_TOOLS_INSTALL=OFF",
  "-DLLAMA_OPENSSL=OFF",
  "-DGGML_NATIVE=OFF",
];
const extraArgs = process.env.MIKI_LLAMA_CMAKE_ARGS?.trim();
if (extraArgs) configureArgs.push(...extraArgs.split(/\s+/));
run(process.platform === "win32" ? "cmake.exe" : "cmake", configureArgs);
const requestedJobs = Number.parseInt(
  process.env.MIKI_LLAMA_BUILD_JOBS || "2",
  10,
);
const buildJobs =
  Number.isSafeInteger(requestedJobs) && requestedJobs > 0
    ? Math.min(requestedJobs, Math.max(1, os.cpus().length))
    : 2;
run(process.platform === "win32" ? "cmake.exe" : "cmake", [
  "--build",
  buildRoot,
  "--config",
  "Release",
  "--target",
  "llama-server",
  "--parallel",
  String(buildJobs),
]);

const built = findBuiltExecutable(buildRoot);
if (!built || !statSync(built).isFile())
  fail(
    `The native runtime build completed but ${executableName} was not found below ${buildRoot}.`,
  );
persistArtifact(built, "source-build");
log(`Built headless Miki native runtime server for ${platformKey}.`);
