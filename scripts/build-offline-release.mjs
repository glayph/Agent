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
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";
const isX64 = process.arch === "x64";
const platformKey = `${process.platform}-${process.arch}`;
const artifactPlatform = isWindows ? "windows-x64" : "linux-x64";
const packageName = `agent-miki-${artifactPlatform}-offline`;
const releaseName = `${packageName}-${version}`;
const llamaExecutableName = isWindows ? "llama-server.exe" : "llama-server";
const releaseDir = path.resolve(
  process.env.MIKI_RELEASE_DIR || path.join(os.tmpdir(), releaseName),
);
const stageDir = path.join(releaseDir, "package");
const runtimeDir = path.join(stageDir, "runtime");
const nodeVersion = "v22.23.2";
const nodeArchiveName = isWindows
  ? `node-${nodeVersion}-win-x64.zip`
  : `node-${nodeVersion}-linux-x64.tar.xz`;
const nodeArchiveUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName}`;
const npmCommand = isWindows ? "npm.cmd" : "npm";

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
      copyRecursive(
        path.join(source, entry.name),
        path.join(destination, entry.name),
        {
          skipMaps,
        },
      );
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
  if (!isWindows) fs.chmodSync(file, 0o755);
}

function download(url, destination) {
  if (fs.existsSync(destination)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  run(
    "curl",
    ["-fL", "--retry", "3", "--retry-delay", "2", url, "-o", destination],
    {
      cwd: root,
    },
  );
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
    for (const [dependency, spec] of Object.entries(
      manifest.dependencies || {},
    )) {
      if (
        String(spec).startsWith("workspace:") ||
        String(spec).startsWith("file:")
      ) {
        const localName = dependency;
        const localDir = path.join(
          root,
          "packages",
          localName.replace(/^@miki\//, ""),
        );
        queue.push({
          name: localName,
          dir: localDir,
          local: true,
          optional: false,
        });
      } else {
        queue.push({
          name: dependency,
          fromDir: source,
          local: false,
          optional: false,
        });
      }
    }
    for (const [dependency, spec] of Object.entries(
      manifest.optionalDependencies || {},
    )) {
      if (
        String(spec).startsWith("workspace:") ||
        String(spec).startsWith("file:")
      ) {
        const localName = dependency;
        const localDir = path.join(
          root,
          "packages",
          localName.replace(/^@miki\//, ""),
        );
        queue.push({
          name: localName,
          dir: localDir,
          local: true,
          optional: true,
        });
      } else {
        queue.push({
          name: dependency,
          fromDir: source,
          local: false,
          optional: true,
        });
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
  const packageNames = [
    "config",
    "installer",
    "skills",
    "memory",
    "core",
    "gateway",
  ];
  for (const name of packageNames) {
    const source = path.join(root, "packages", name);
    const destination = path.join(runtimeDir, "packages", name);
    if (name === "memory") {
      copyRequired(
        path.join(source, "src"),
        path.join(destination, "src"),
        "memory source",
      );
    } else {
      copyRequired(
        path.join(source, "dist"),
        path.join(destination, "dist"),
        `${name} dist`,
      );
    }
    copyRequired(
      path.join(source, "package.json"),
      path.join(destination, "package.json"),
      `${name} package.json`,
    );
    if (name === "skills")
      copyRequired(
        path.join(source, "src"),
        path.join(destination, "src"),
        "skills catalog",
      );
  }
  copyRequired(
    path.join(root, "packages", "ui", "frontend", "dist"),
    path.join(runtimeDir, "packages", "ui", "frontend", "dist"),
    "frontend build",
  );
  for (const name of ["agent.yaml", "tools.yaml"]) {
    copyRequired(
      path.join(root, "config", name),
      path.join(runtimeDir, "config", name),
      `${name} template`,
    );
  }
  copyRequired(
    path.join(root, "config", ".env.example"),
    path.join(runtimeDir, "config", ".env.example"),
    "safe environment template",
  );
  copyRequired(
    path.join(root, "LICENSE"),
    path.join(stageDir, "LICENSE"),
    "Agent Miki license",
  );
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
  const llamaSource =
    process.env.MIKI_LLAMA_SERVER_BIN ||
    path.join(
      root,
      "packages",
      "core",
      "src",
      "llm",
      "local",
      "native",
      platformKey,
      llamaExecutableName,
    );
  const llamaDestination = path.join(runtimeDir, "native", llamaExecutableName);
  copyRequired(llamaSource, llamaDestination, `${platformKey} llama-server`);
  chmodExecutable(llamaDestination);
}

function assertNoBundledVoiceAssets() {
  const voiceDirectory = path.join(runtimeDir, "voice");
  if (fs.existsSync(voiceDirectory)) {
    fail(`Voice runtime/model assets must not be bundled: ${voiceDirectory}`);
  }
  const forbidden = [];
  function scan(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(target);
      else if (/whisper|ggml-(tiny|base|small)/i.test(entry.name)) {
        forbidden.push(target);
      }
    }
  }
  scan(runtimeDir);
  if (forbidden.length > 0) {
    fail(
      `Voice runtime/model artifacts must not be bundled: ${forbidden.join(", ")}`,
    );
  }
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
      else if (entry.name.toLowerCase().endsWith(".gguf"))
        bundledGgufs.push(target);
    }
  }
  scan(runtimeDir);
  if (bundledGgufs.length > 0) {
    fail(`Answer-model GGUF must not be bundled: ${bundledGgufs.join(", ")}`);
  }
}

function stageNodeRuntime() {
  const archive =
    process.env.MIKI_NODE_TARBALL || path.join(releaseDir, nodeArchiveName);
  download(nodeArchiveUrl, archive);
  const extracted = path.join(releaseDir, "node-extracted");
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted, { recursive: true });
  if (isWindows) {
    const archivePath = path.resolve(archive);
    const escapedArchive = archivePath.replaceAll("'", "''");
    const escapedDestination = extracted.replaceAll("'", "''");
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
      ],
      { cwd: root },
    );
  } else {
    run("tar", ["-xJf", archive, "--strip-components=1", "-C", extracted], {
      cwd: root,
    });
  }
  const nodeRoot = isWindows
    ? path.join(extracted, `node-${nodeVersion}-win-x64`)
    : extracted;
  const nodeName = isWindows ? "node.exe" : "node";
  const nodeDestination = path.join(runtimeDir, "node", "bin", nodeName);
  const nodeSource = isWindows
    ? path.join(nodeRoot, nodeName)
    : path.join(nodeRoot, "bin", nodeName);
  copyRequired(nodeSource, nodeDestination, `${platformKey} Node binary`);
  copyRequired(
    path.join(nodeRoot, "LICENSE"),
    path.join(runtimeDir, "node", "LICENSE"),
    "Node license",
  );
  copyRequired(
    path.join(nodeRoot, "README.md"),
    path.join(runtimeDir, "node", "README.md"),
    "Node notice",
  );
  chmodExecutable(nodeDestination);
}

function stageNotices() {
  const licensesDir = path.join(stageDir, "licenses");
  copyRequired(
    path.join(
      root,
      "packages",
      "core",
      "src",
      "llm",
      "local",
      "miki-native-runtime (keep it Always for windows build)",
      "LICENSE",
    ),
    path.join(licensesDir, "LLAMA_CPP_AND_GGML_LICENSE"),
    "llama.cpp/GGML license",
  );
  const notices = `# Agent Miki ${isWindows ? "Windows x64" : "Linux x64"} offline release notices

This package ships the following third-party artifacts. Their licenses are included in the \`licenses/\` directory and remain separate from the Agent Miki MIT license.

| Component | Shipped artifact | License/notice | Official source |
| --- | --- | --- | --- |
| Node.js | \`runtime/node/bin/${isWindows ? "node.exe" : "node"}\` (${nodeVersion}) | Node.js license and bundled-runtime notice | https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName} |
| llama.cpp / GGML | \`runtime/native/${llamaExecutableName}\` | MIT license | https://github.com/ggml-org/llama.cpp |
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
  if (isWindows) {
    const installScript = `$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeBin = Join-Path $ScriptDir "runtime\\node\\bin\\node.exe"
if (-not (Test-Path $NodeBin)) { throw "Embedded Node runtime is missing: $NodeBin" }
& $NodeBin (Join-Path $ScriptDir "bin\\miki-offline.js") install @args
exit $LASTEXITCODE
`;
    writeText(path.join(stageDir, "install-offline.ps1"), installScript);
  } else {
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
}

function writePackageMetadata(productionPackages) {
  const dependencies = {};
  for (const [name, { manifest }] of productionPackages) {
    dependencies[name] = manifest.version;
  }
  const packageJson = {
    name: packageName,
    version,
    description: `Agent Miki ${platformKey} self-contained offline distribution`,
    type: "module",
    main: "bin/miki-offline.js",
    bin: {
      miki: "bin/miki-offline.js",
      "agent-miki": "bin/miki-offline.js",
    },
    os: [process.platform],
    cpu: [process.arch],
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
      isWindows ? "install-offline.ps1" : "install-offline.sh",
    ],
    dependencies,
    bundledDependencies: Object.keys(dependencies),
  };
  writeText(
    path.join(stageDir, "package.json"),
    JSON.stringify(packageJson, null, 2),
  );
}

function writeReadme() {
  const platformLabel = isWindows ? "Windows x64" : "Linux x64";
  const extractedInstallMessage = isWindows
    ? "Extract the archive with Windows Explorer or 7-Zip, open PowerShell in the extracted directory, and run the embedded Node launcher directly."
    : `The companion ${releaseName}.tar.gz archive can be extracted anywhere and run without npm.`;
  const extractedCommands = isWindows
    ? `& .\\\\install-offline.ps1
& .\\\\runtime\\\\node\\\\bin\\\\node.exe .\\\\bin\\\\miki-offline.js doctor
& .\\\\runtime\\\\node\\\\bin\\\\node.exe .\\\\bin\\\\miki-offline.js start`
    : `tar -xzf ${releaseName}.tar.gz
cd ${releaseName}
./install-offline.sh
./runtime/node/bin/node ./bin/miki-offline.js doctor
./runtime/node/bin/node ./bin/miki-offline.js start`;
  const npmInstallCommands = isWindows
    ? `npm install --offline --ignore-scripts --prefix "$env:LOCALAPPDATA\\\\Miki\\\\npm-install" .\\\\${packageName}-${version}.tgz`
    : `npm install --offline --ignore-scripts --prefix "$HOME/.local/share/miki/npm-install" \\\n  ./${packageName}-${version}.tgz`;
  const readme = `# Agent Miki ${version}: ${platformLabel} offline package

This is the **self-contained ${platformLabel} release artifact** for Agent Miki. It contains the production dashboard, gateway, core, memory package, skills catalog, prebundled production Node dependencies, an embedded Node ${nodeVersion} runtime, and the llama.cpp server executable. No answer-model GGUF or voice-to-text runtime/model is bundled; configure a compatible local runtime/model separately or use an approved audio-capable cloud model.

The package is intended for ${isWindows ? "Windows x64" : "Linux x86_64"} systems. The embedded native components still use the host operating system; this is not a virtual machine or a full operating-system image.

## Offline npm installation

Download the matching \`${packageName}-${version}.tgz\` asset, then install it without contacting the registry:

\`\`\`${isWindows ? "powershell" : "bash"}
${npmInstallCommands}
\`\`\`

The archive already contains its production dependencies through npm bundled dependencies. No dependency download is required after the asset is downloaded. The installed command is available at the package’s \`node_modules/.bin/miki\` path; the included launcher is also directly executable.

## Extracted archive installation

${extractedInstallMessage}

\`\`\`${isWindows ? "powershell" : "bash"}
${extractedCommands}
\`\`\`

On first start the launcher creates user-writable state below \`$XDG_DATA_HOME/miki\` or \`~/.local/share/miki\`, keeps the immutable package tree untouched, leaves local voice-to-text Off until a user-provided or approval-gated runtime/model passes health checks, and writes a randomly generated dashboard password to \`runtime/data/first-run-credentials.txt\` with mode 600. Save the printed password and delete that file after saving it. To choose a password before first start, set \`MIKI_DASHBOARD_PASSWORD\` to a value of at least eight characters.

The dashboard defaults to \`http://127.0.0.1:18800\`. No answer-model GGUF is pre-installed. To use the bundled llama.cpp executable with a separate local model, set \`MIKI_MODEL_PATH=/absolute/path/to/model.gguf\` before \`start\`; optionally set \`MIKI_LOCAL_MODEL_NAME\` and \`MIKI_MODEL_ID\`. The launcher registers that external model in user state and restricts its model allowlist to the model directory. You can also add a model from the dashboard Models page. If no model is configured, the gateway still starts and the dashboard remains available for cloud-provider or later model configuration.

No cloud API key, online registry, model download, or plugin download is used by the offline start path. Remote channels, cloud providers, external MCP servers, and online skill installation remain optional features that require explicit configuration and network access.

## Diagnostics and limitations

Run \`miki doctor\` or the direct launcher command shown above to verify the archive. The release includes the local inference executable but not an answer-model GGUF or voice-to-text assets; model quality, context length, latency, and RAM use depend on separately selected models and host CPU/memory. This archive targets ${platformLabel}.

The dashboard’s existing conversational chat/Inspector behavior, local/API/Auto web-search controls, memory system, skills, MCP surfaces, and voice transcript routing are included from the source commit used to create this release. External online acquisitions remain approval-gated by the application’s safety controls and are not silently performed by this package.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the complete license files under [licenses/](licenses/). Separately downloaded models retain their own licenses and are not covered by the Agent Miki MIT license.
`;
  writeText(path.join(stageDir, "README.md"), readme);
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function writeManifest() {
  const important = [
    [
      `runtime/node/bin/${isWindows ? "node.exe" : "node"}`,
      "Embedded Node.js runtime",
    ],
    [
      `runtime/native/${llamaExecutableName}`,
      "Bundled llama.cpp server executable",
    ],
    ["bin/miki-offline.js", "Portable launcher"],
    ["runtime/packages/gateway/dist/index.js", "Gateway build"],
    ["runtime/packages/ui/frontend/dist/index.html", "Dashboard build"],
  ];
  const components = important.map(([relative, description]) => {
    const absolute = path.join(stageDir, relative);
    if (!fs.existsSync(absolute))
      fail(`Manifest component is missing: ${relative}`);
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
        target: platformKey,
        source_commit: runGit(["rev-parse", "HEAD"]),
        built_at: new Date().toISOString(),
        node: { version: nodeVersion, archive: nodeArchiveName },
        models: {
          answer_model: "not bundled; configure separately",
          voice_to_text:
            "not bundled; configure a user-provided or approved local runtime/model",
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

function assertZipArchive(file) {
  const header = fs.readFileSync(file).subarray(0, 4).toString("hex");
  if (!["504b0304", "504b0506", "504b0708"].includes(header)) {
    fail(
      `Windows companion archive is not a ZIP file: ${file} (header ${header})`,
    );
  }
}

function packageAndArchive() {
  // The npm-compatible .tgz always has a `package` root. The companion
  // archive uses tar.gz on Linux and zip on Windows.
  const tgz = path.join(releaseDir, `${packageName}-${version}.tgz`);
  if (isWindows) {
    run("tar", ["-czf", path.basename(tgz), "-C", ".", "package"], {
      cwd: releaseDir,
    });
  } else {
    run("tar", ["-czf", tgz, "-C", releaseDir, "package"], { cwd: root });
  }
  if (!fs.existsSync(tgz)) fail(`Expected npm package was not created: ${tgz}`);
  const archiveExtension = isWindows ? "zip" : "tar.gz";
  const namedArchive = path.join(
    releaseDir,
    `${releaseName}.${archiveExtension}`,
  );
  if (isWindows) {
    const destination = namedArchive.replace(/'/g, "''");
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; " +
          `Compress-Archive -Path 'package' -DestinationPath '${destination}' -CompressionLevel Optimal -Force`,
      ],
      { cwd: releaseDir },
    );
    assertZipArchive(namedArchive);
  } else {
    run(
      "tar",
      [
        "-czf",
        namedArchive,
        "--transform",
        `s,^package,${releaseName},`,
        "-C",
        releaseDir,
        "package",
      ],
      { cwd: root },
    );
  }
  if (!fs.existsSync(namedArchive))
    fail(`Expected archive was not created: ${namedArchive}`);
  const checksumFiles = [tgz, namedArchive];
  const sums = checksumFiles
    .map((file) => `${sha256(file)}  ${path.basename(file)}`)
    .join("\n");
  writeText(path.join(releaseDir, "SHA256SUMS"), sums);
  return { tgz, archive: namedArchive };
}

function main() {
  if ((!isLinux && !isWindows) || !isX64) {
    fail("This builder only creates Linux x64 or Windows x64 artifacts.");
  }
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  log(`Building ${packageName}@${version} into ${releaseDir}`);
  run(npmCommand, ["run", "build:all"], { cwd: root, shell: isWindows });
  stageRuntimeTree();
  writeRuntimeLoader();
  stageNativeAndModels();
  assertAnswerModelNotBundled();
  assertNoBundledVoiceAssets();
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
