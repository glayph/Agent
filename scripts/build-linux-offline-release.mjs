#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const rootPackage = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = rootPackage.version;
const packageName = "agent-miki-linux-x64-offline";
const releaseName = `${packageName}-${version}`;
const releaseDir = path.resolve(
  process.env.MIKI_RELEASE_DIR || path.join(os.tmpdir(), releaseName),
);
const stageDir = path.join(releaseDir, "package");
const runtimeDir = path.join(stageDir, "runtime");
const nodeVersion = "v22.23.2";
const nodeArchiveName = `node-${nodeVersion}-linux-x64.tar.xz`;
const nodeArchiveUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName}`;
const whisperCommit = "233fe1fc9b48a09e361d3594520838ca266537fe";
const whisperSourceUrl = "https://github.com/ggml-org/whisper.cpp";
const ffmpegVersion = "7.1.1";
const ffmpegSourceUrl = `https://ffmpeg.org/releases/ffmpeg-${ffmpegVersion}.tar.xz`;
const whisperModelSourceUrl = "https://huggingface.co/ggerganov/whisper.cpp";

function log(message) {
  console.log(`[offline-release] ${message}`);
}

function fail(message) {
  console.error(`[offline-release] ERROR: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  log(`Running: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} exited with status ${result.status ?? "unknown"}`);
}

function copyRecursive(source, destination, { skipMaps = true } = {}) {
  if (!fs.existsSync(source)) return false;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    copyRecursive(fs.realpathSync(source), destination, { skipMaps });
    return true;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyRecursive(path.join(source, entry.name), path.join(destination, entry.name), {
        skipMaps,
      });
    }
    return true;
  }
  if (skipMaps && path.extname(source).toLowerCase() === ".map") return true;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  try {
    fs.chmodSync(destination, stat.mode & 0o777);
  } catch {
    // Best effort for filesystems without POSIX mode support.
  }
  return true;
}

function copyRequired(source, destination, label) {
  if (!copyRecursive(source, destination)) fail(`Missing ${label}: ${source}`);
}

function writeText(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, {
    encoding: "utf8",
    mode,
  });
}

function chmodExecutable(file) {
  fs.chmodSync(file, 0o755);
}

function download(url, destination) {
  if (fs.existsSync(destination)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  run("curl", ["-fL", "--retry", "3", "--retry-delay", "2", url, "-o", destination], {
    cwd: root,
  });
}

function readPackage(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
}

function packageInstallPath(name) {
  return path.join(stageDir, "node_modules", ...name.split("/"));
}

function packageSourcePath(name, fromDir = root) {
  const candidates = [];
  let current = path.resolve(fromDir);
  while (true) {
    candidates.push(path.join(current, "node_modules", ...name.split("/")));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  candidates.push(path.join(root, "node_modules", ...name.split("/")));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function localPackageNames() {
  return ["config", "installer", "skills", "memory", "core", "gateway"].map(
    (name) => `@miki/${name}`,
  );
}

function collectProductionPackages() {
  const packages = new Map();
  const queue = localPackageNames().map((name) => ({
    name,
    dir: path.join(root, "packages", name.slice("@miki/".length)),
    local: true,
  }));
  while (queue.length) {
    const current = queue.shift();
    if (!current || packages.has(current.name)) continue;
    const source = current.local
      ? current.dir
      : packageSourcePath(current.name, current.fromDir || root);
    if (!source || !fs.existsSync(path.join(source, "package.json"))) {
      if (current.optional) continue;
      fail(`Production dependency is not installed: ${current.name}`);
    }
    const manifest = readPackage(source);
    packages.set(current.name, { source, manifest });
    for (const [dependency, spec] of Object.entries(manifest.dependencies || {})) {
      if (String(spec).startsWith("workspace:") || String(spec).startsWith("file:")) {
        const localName = dependency;
        const localDir = path.join(root, "packages", localName.replace(/^@miki\//, ""));
        queue.push({ name: localName, dir: localDir, local: true, optional: false });
      } else {
        queue.push({ name: dependency, fromDir: source, local: false, optional: false });
      }
    }
    for (const [dependency, spec] of Object.entries(manifest.optionalDependencies || {})) {
      if (String(spec).startsWith("workspace:") || String(spec).startsWith("file:")) {
        const localName = dependency;
        const localDir = path.join(root, "packages", localName.replace(/^@miki\//, ""));
        queue.push({ name: localName, dir: localDir, local: true, optional: true });
      } else {
        queue.push({ name: dependency, fromDir: source, local: false, optional: true });
      }
    }
  }
  return packages;
}

function stageProductionNodeModules() {
  const packages = collectProductionPackages();
  const bundleNames = [];
  for (const [name, { source, manifest }] of packages) {
    const preferredRoot = path.join(root, "node_modules", ...name.split("/"));
    const materializedSource =
      !name.startsWith("@miki/") && fs.existsSync(preferredRoot)
        ? preferredRoot
        : source;
    const destination = packageInstallPath(name);
    copyRequired(materializedSource, destination, `package ${name}`);
    bundleNames.push(name);
    if (!manifest.version) fail(`Package ${name} has no version.`);
  }
  return { packages, bundleNames };
}

function stageRuntimeTree() {
  const packageNames = ["config", "installer", "skills", "memory", "core", "gateway"];
  for (const name of packageNames) {
    const source = path.join(root, "packages", name);
    const destination = path.join(runtimeDir, "packages", name);
    if (name === "memory") {
      copyRequired(path.join(source, "src"), path.join(destination, "src"), "memory source");
    } else {
      copyRequired(path.join(source, "dist"), path.join(destination, "dist"), `${name} dist`);
    }
    copyRequired(path.join(source, "package.json"), path.join(destination, "package.json"), `${name} package.json`);
    if (name === "skills")
      copyRequired(path.join(source, "src"), path.join(destination, "src"), "skills catalog");
  }
  copyRequired(
    path.join(root, "packages", "ui", "frontend", "dist"),
    path.join(runtimeDir, "packages", "ui", "frontend", "dist"),
    "frontend build",
  );
  for (const name of ["agent.yaml", "tools.yaml"]) {
    copyRequired(path.join(root, "config", name), path.join(runtimeDir, "config", name), `${name} template`);
  }
  copyRequired(
    path.join(root, "config", ".env.example"),
    path.join(runtimeDir, "config", ".env.example"),
    "safe environment template",
  );
  copyRequired(path.join(root, "LICENSE"), path.join(stageDir, "LICENSE"), "Agent Miki license");
}

function writeRuntimeLoader() {
  const content = `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const loaderDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(process.env.MIKI_SOURCE_ROOT || loaderDir);
const packageRoots = new Map([
  ["@miki/config", "packages/config/dist"],
  ["@miki/installer", "packages/installer/dist"],
  ["@miki/skills", "packages/skills/dist"],
  ["@miki/memory", "packages/memory/src"],
  ["@miki/core", "packages/core/dist"],
  ["@miki/gateway", "packages/gateway/dist"],
]);
const packageEntrypoints = new Map([
  ["@miki/config", "packages/config/dist/index.js"],
  ["@miki/installer", "packages/installer/dist/index.js"],
  ["@miki/skills", "packages/skills/dist/index.js"],
  ["@miki/memory", "packages/memory/src/index.js"],
  ["@miki/core", "packages/core/dist/api/index.js"],
  ["@miki/gateway", "packages/gateway/dist/index.js"],
]);

function candidateFor(specifier) {
  const direct = packageEntrypoints.get(specifier);
  if (direct) return path.join(runtimeRoot, direct);
  for (const [name, root] of packageRoots) {
    if (!specifier.startsWith(name + "/")) continue;
    const subpath = specifier.slice(name.length + 1);
    const base = path.join(runtimeRoot, root, subpath);
    const candidates = [base, base + ".js", path.join(base, "index.js")];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
  }
  return undefined;
}

export async function resolve(specifier, context, nextResolve) {
  const target = candidateFor(specifier);
  if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
  writeText(path.join(runtimeDir, "runtime-loader.mjs"), content);
}

function stageNativeAndModels() {
  const llamaSource = process.env.MIKI_LLAMA_SERVER_BIN || path.join(
    root,
    "packages",
    "core",
    "src",
    "llm",
    "local",
    "native",
    "linux-x64",
    "llama-server",
  );
  copyRequired(llamaSource, path.join(runtimeDir, "native", "llama-server"), "Linux x64 llama-server");
  chmodExecutable(path.join(runtimeDir, "native", "llama-server"));

  const whisperSource = process.env.MIKI_WHISPER_CPP_BIN;
  const whisperModel = process.env.MIKI_WHISPER_CPP_MODEL;
  if (!whisperSource || !whisperModel) {
    fail(
      "Set MIKI_WHISPER_CPP_BIN and MIKI_WHISPER_CPP_MODEL to official, verified release inputs before building.",
    );
  }
  const voiceDir = path.join(runtimeDir, "voice");
  copyRequired(whisperSource, path.join(voiceDir, "whisper-cli"), "Whisper.cpp CLI");
  chmodExecutable(path.join(voiceDir, "whisper-cli"));
  const whisperLibraryDir = path.dirname(whisperSource);
  for (const entry of fs.readdirSync(whisperLibraryDir)) {
    if (/^lib.*\.so(?:\.|$)/.test(entry)) {
      copyRequired(path.join(whisperLibraryDir, entry), path.join(voiceDir, entry), `Whisper runtime library ${entry}`);
    }
  }
  copyRequired(whisperModel, path.join(voiceDir, "ggml-tiny.en.bin"), "Whisper tiny.en model");
}

function assertAnswerModelNotBundled() {
  const modelsDir = path.join(runtimeDir, "models");
  if (fs.existsSync(modelsDir)) {
    fail(`Answer-model directory must not be bundled: ${modelsDir}`);
  }
  const bundledGgufs = [];
  function scan(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(target);
      else if (entry.name.toLowerCase().endsWith(".gguf")) bundledGgufs.push(target);
    }
  }
  scan(runtimeDir);
  if (bundledGgufs.length > 0) {
    fail(`Answer-model GGUF must not be bundled: ${bundledGgufs.join(", ")}`);
  }
}

function stageNodeRuntime() {
  const archive = process.env.MIKI_NODE_TARBALL || path.join(releaseDir, nodeArchiveName);
  download(nodeArchiveUrl, archive);
  const extracted = path.join(releaseDir, "node-extracted");
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted, { recursive: true });
  run("tar", ["-xJf", archive, "--strip-components=1", "-C", extracted], { cwd: root });
  copyRequired(path.join(extracted, "bin", "node"), path.join(runtimeDir, "node", "bin", "node"), "Node Linux x64 binary");
  copyRequired(path.join(extracted, "LICENSE"), path.join(runtimeDir, "node", "LICENSE"), "Node license");
  copyRequired(path.join(extracted, "README.md"), path.join(runtimeDir, "node", "README.md"), "Node notice");
  chmodExecutable(path.join(runtimeDir, "node", "bin", "node"));
}

function stageNotices() {
  const licensesDir = path.join(stageDir, "licenses");
  copyRequired(
    path.join(root, "packages", "core", "src", "llm", "local", "miki-native-runtime (keep it Always for windows build)", "LICENSE"),
    path.join(licensesDir, "LLAMA_CPP_AND_GGML_LICENSE"),
    "llama.cpp/GGML license",
  );
  copyRequired(
    path.join("/tmp", "miki-whisper.cpp", "LICENSE"),
    path.join(licensesDir, "WHISPER_CPP_LICENSE"),
    "whisper.cpp license",
  );
  copyRequired(
    path.join("/tmp", "miki-ffmpeg-clean", `ffmpeg-${ffmpegVersion}`, "LICENSE.md"),
    path.join(licensesDir, "FFMPEG_LICENSE.md"),
    "FFmpeg license",
  );
  download(
    "https://raw.githubusercontent.com/openai/whisper/main/LICENSE",
    path.join(licensesDir, "OPENAI_WHISPER_LICENSE"),
  );
  const notices = `# Agent Miki Linux x64 offline release notices

This package ships the following third-party artifacts. Their licenses are included in the \`licenses/\` directory and remain separate from the Agent Miki MIT license.

| Component | Shipped artifact | License/notice | Official source |
| --- | --- | --- | --- |
| Node.js | \`runtime/node/bin/node\` (${nodeVersion}) | Node.js license and bundled-runtime notice | https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName} |
| llama.cpp / GGML | \`runtime/native/llama-server\` | MIT license | https://github.com/ggml-org/llama.cpp |
| whisper.cpp | \`runtime/voice/whisper-cli\` and its shared runtime libraries | MIT license | ${whisperSourceUrl} at commit ${whisperCommit} |
| FFmpeg decoder subset | Statically linked into the Whisper voice libraries | LGPL 2.1-or-later build | ${ffmpegSourceUrl} |
| OpenAI Whisper tiny.en | \`runtime/voice/ggml-tiny.en.bin\` | Upstream Whisper model attribution/license | ${whisperModelSourceUrl} |
`;
  writeText(path.join(stageDir, "THIRD_PARTY_NOTICES.md"), notices);
}

function stageLauncher() {
  copyRequired(
    path.join(root, "scripts", "offline-launcher-template.mjs"),
    path.join(stageDir, "bin", "miki-offline.js"),
    "offline launcher template",
  );
  chmodExecutable(path.join(stageDir, "bin", "miki-offline.js"));
  const installScript = `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NODE_BIN="$SCRIPT_DIR/runtime/node/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then
  echo "Embedded Node runtime is missing: $NODE_BIN" >&2
  exit 1
fi
exec "$NODE_BIN" "$SCRIPT_DIR/bin/miki-offline.js" install "$@"
`;
  writeText(path.join(stageDir, "install-offline.sh"), installScript, 0o755);
  chmodExecutable(path.join(stageDir, "install-offline.sh"));
}

function writePackageMetadata(productionPackages) {
  const dependencies = {};
  for (const [name, { manifest }] of productionPackages) {
    dependencies[name] = manifest.version;
  }
  const packageJson = {
    name: packageName,
    version,
    description: "Agent Miki Linux x64 self-contained offline distribution",
    type: "module",
    main: "bin/miki-offline.js",
    bin: {
      miki: "bin/miki-offline.js",
      "agent-miki": "bin/miki-offline.js",
    },
    os: ["linux"],
    cpu: ["x64"],
    engines: { node: ">=20" },
    license: "MIT",
    files: [
      "bin/",
      "runtime/",
      "licenses/",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "README.md",
      "manifest.json",
      "install-offline.sh",
    ],
    dependencies,
    bundledDependencies: Object.keys(dependencies),
  };
  writeText(path.join(stageDir, "package.json"), JSON.stringify(packageJson, null, 2));
}

function writeReadme() {
  const readme = `# Agent Miki ${version}: Linux x64 offline package

This is the **self-contained Linux x64 release artifact** for Agent Miki. It contains the production dashboard, gateway, core, memory package, skills catalog, prebundled production Node dependencies, an embedded Node ${nodeVersion} runtime, the llama.cpp server executable, Whisper.cpp voice recognition, and an FFmpeg-enabled Whisper build for WAV, MP3, M4A, OGG, WebM, and FLAC inputs. No answer-model GGUF is bundled; choose and configure a local model separately or use a configured cloud provider.

The package is intended for Linux x86_64 systems with a compatible glibc and CPU. The embedded native components still use the host kernel and glibc; this is not a virtual machine or a full operating-system image.

## Offline npm installation

Download the matching \`${packageName}-${version}.tgz\` asset, then install it without contacting the registry:

\`\`\`bash
npm install --offline --ignore-scripts --prefix "$HOME/.local/share/miki/npm-install" \\
  ./${packageName}-${version}.tgz
\`\`\`

The archive already contains its production dependencies through npm bundled dependencies. No dependency download is required after the asset is downloaded. The installed command is available at the package’s \`node_modules/.bin/miki\` path; the included launcher is also directly executable.

## Extracted archive installation

The companion \`${releaseName}.tar.gz\` archive can be extracted anywhere and run without npm:

\`\`\`bash
tar -xzf ${releaseName}.tar.gz
cd ${releaseName}
./install-offline.sh
./runtime/node/bin/node ./bin/miki-offline.js doctor
./runtime/node/bin/node ./bin/miki-offline.js start
\`\`\`

On first start the launcher creates user-writable state below \`$XDG_DATA_HOME/miki\` or \`~/.local/share/miki\`, keeps the immutable package tree untouched, enables local Whisper.cpp transcription, and writes a randomly generated dashboard password to \`runtime/data/first-run-credentials.txt\` with mode 600. Save the printed password and delete that file after saving it. To choose a password before first start, set \`MIKI_DASHBOARD_PASSWORD\` to a value of at least eight characters.

The dashboard defaults to \`http://127.0.0.1:18800\`. No answer-model GGUF is pre-installed. To use the bundled llama.cpp executable with a separate local model, set \`MIKI_MODEL_PATH=/absolute/path/to/model.gguf\` before \`start\`; optionally set \`MIKI_LOCAL_MODEL_NAME\` and \`MIKI_MODEL_ID\`. The launcher registers that external model in user state and restricts its model allowlist to the model directory. You can also add a model from the dashboard Models page. If no model is configured, the gateway still starts and the dashboard remains available for cloud-provider or later model configuration.

No cloud API key, online registry, model download, or plugin download is used by the offline start path. Remote channels, cloud providers, external MCP servers, and online skill installation remain optional features that require explicit configuration and network access.

## Diagnostics and limitations

Run \`miki doctor\` or the direct launcher command shown above to verify the archive. The release includes the local inference executable but not an answer-model GGUF; model quality, context length, latency, and RAM use depend on the separately selected model and host CPU/memory. The release was built for Linux x86_64 and is not a Windows build.

The dashboard’s existing conversational chat/Inspector behavior, local/API/Auto web-search controls, memory system, skills, MCP surfaces, and voice transcript routing are included from the source commit used to create this release. External online acquisitions remain approval-gated by the application’s safety controls and are not silently performed by this package.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the complete license files under [licenses/](licenses/). Separately downloaded models retain their own licenses and are not covered by the Agent Miki MIT license.
`;
  writeText(path.join(stageDir, "README.md"), readme);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeManifest() {
  const important = [
    ["runtime/node/bin/node", "Embedded Node.js runtime"],
    ["runtime/native/llama-server", "Bundled llama.cpp server executable"],
    ["runtime/voice/whisper-cli", "Whisper.cpp CLI"],
    ["runtime/voice/ggml-tiny.en.bin", "Whisper tiny.en model"],
    ["bin/miki-offline.js", "Portable launcher"],
    ["runtime/packages/gateway/dist/index.js", "Gateway build"],
    ["runtime/packages/ui/frontend/dist/index.html", "Dashboard build"],
  ];
  const components = important.map(([relative, description]) => {
    const absolute = path.join(stageDir, relative);
    if (!fs.existsSync(absolute)) fail(`Manifest component is missing: ${relative}`);
    return {
      path: relative,
      description,
      bytes: fs.statSync(absolute).size,
      sha256: sha256(absolute),
    };
  });
  writeText(
    path.join(stageDir, "manifest.json"),
    JSON.stringify(
      {
        package: packageName,
        version,
        target: "linux-x64",
        source_commit: runGit(["rev-parse", "HEAD"]),
        built_at: new Date().toISOString(),
        node: { version: nodeVersion, archive: nodeArchiveName },
        whisper_cpp: { source: whisperSourceUrl, commit: whisperCommit },
        ffmpeg: { version: ffmpegVersion, source: ffmpegSourceUrl, license: "LGPL-2.1-or-later" },
        models: {
          answer_model: "not bundled; configure separately",
          whisper: { source: whisperModelSourceUrl, file: "runtime/voice/ggml-tiny.en.bin" },
        },
        components,
      },
      null,
      2,
    ),
  );
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return "unknown";
  return result.stdout.trim();
}

function packageAndArchive() {
  // npm-compatible package archives are simply gzip-compressed tarballs whose
  // root directory is named `package`. Building directly avoids npm pack’s
  // large in-memory file enumeration while preserving bundled node_modules.
  const tgz = path.join(releaseDir, `${packageName}-${version}.tgz`);
  run("tar", ["-czf", tgz, "-C", releaseDir, "package"], { cwd: root });
  if (!fs.existsSync(tgz)) fail(`Expected npm package was not created: ${tgz}`);
  const archive = path.join(releaseDir, `${releaseName}.tar.gz`);
  run("tar", ["-czf", archive, "--transform", `s,^package,${releaseName},`, "-C", releaseDir, "package"], { cwd: root });
  const namedArchive = path.join(releaseDir, `${releaseName}.tar.gz`);
  if (archive !== namedArchive) fs.renameSync(archive, namedArchive);
  const checksumFiles = [tgz, namedArchive];
  const sums = checksumFiles
    .map((file) => `${sha256(file)}  ${path.basename(file)}`)
    .join("\n");
  writeText(path.join(releaseDir, "SHA256SUMS"), sums);
  return { tgz, archive: namedArchive };
}

function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("This builder only creates the Linux x64 artifact.");
  }
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  log(`Building ${packageName}@${version} into ${releaseDir}`);
  run("npm", ["run", "build:all"], { cwd: root });
  stageRuntimeTree();
  writeRuntimeLoader();
  stageNativeAndModels();
  assertAnswerModelNotBundled();
  stageNodeRuntime();
  stageNotices();
  stageLauncher();
  const productionPackages = stageProductionNodeModules();
  writePackageMetadata(productionPackages.packages);
  writeReadme();
  writeManifest();
  const artifacts = packageAndArchive();
  log(`Created ${artifacts.tgz}`);
  log(`Created ${artifacts.archive}`);
  log(`Created ${path.join(releaseDir, "SHA256SUMS")}`);
}

main();
