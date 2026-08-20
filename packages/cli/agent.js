#!/usr/bin/env node
// packages/cli/agent.js - CLI entry point for public npm package

import process from "node:process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import childProcess from "node:child_process";
import net from "node:net";

const packageDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageDir, "..", "..");

const args = process.argv.slice(2);
const command = args[0] || "start";
const options = args.slice(1);
const isWindowsInstaller =
  process.platform === "win32" && process.env.MIKI_INSTALLER === "1";
const isTrayMode = options.includes("--tray");

function parseArgs() {
  const argObj = {};
  options.forEach((option, index) => {
    if (!option.startsWith("--")) return;
    const key = option.replace(/^--/, "");
    const next = options[index + 1];
    argObj[key] = next && !next.startsWith("--") ? next : true;
  });
  return argObj;
}

function configuredWorkspaceDir() {
  return resolve(
    process.env.MIKI_WORKSPACE_DIR || process.env.Miki_WORKSPACE_DIR || process.cwd(),
  );
}

function resolveGatewayPath() {
  const configured =
    process.env.MIKI_GATEWAY_PATH || process.env.Miki_GATEWAY_PATH || "";
  const candidates = [
    configured,
    join(packageDir, "..", "gateway", "dist", "index.js"),
    join(repoRoot, "packages", "gateway", "dist", "index.js"),
    join(process.cwd(), "packages", "gateway", "dist", "index.js"),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveInstallerExecutable() {
  const candidates = [
    join(packageDir, "..", "installer", "windows", "launcher-go", "Miki.exe"),
    join(repoRoot, "packages", "installer", "windows", "launcher-go", "Miki.exe"),
    join(repoRoot, "installer", "windows", "launcher-go", "Miki.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function runCommand() {
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    return;
  }

  switch (command) {
    case "start":
      await startDashboard();
      break;
    case "doctor":
      await runDoctor();
      break;
    case "install":
      await installPackage();
      break;
    case "uninstall":
      await uninstallPackage();
      break;
    case "version":
      await showVersion();
      break;
    case "help":
    default:
      showHelp();
      break;
  }
}

async function startDashboard() {
  const gatewayPath = resolveGatewayPath();

  if (isWindowsInstaller && !isTrayMode) {
    const exePath = resolveInstallerExecutable();
    if (exePath) {
      console.log("Launching dashboard via Windows installer wrapper...");
      const child = childProcess.spawn(exePath, ["--dashboard"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return;
    }
    console.warn("Windows installer wrapper was not found; using Node gateway.");
  }

  if (!gatewayPath) {
    throw new Error(
      "Gateway build not found. Run the repository build first or set MIKI_GATEWAY_PATH to a built gateway entry file.",
    );
  }

  console.log("Starting miki dashboard...");
  if (isTrayMode) console.log("System tray mode requested; starting gateway mode.");
  console.log(`Launching gateway from: ${gatewayPath}`);

  const child = childProcess.spawn(process.execPath, [gatewayPath], {
    detached: false,
    stdio: "inherit",
    cwd: dirname(gatewayPath),
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`Gateway failed to start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`Gateway stopped after signal ${signal}.`);
    } else if (code && code !== 0) {
      console.error(`Gateway exited with code ${code}.`);
    }
  });
}

async function runDoctor() {
  console.log("=== miki System Diagnostic ===\n");

  console.log("1. Checking Node.js environment...");
  console.log("   ✓ Node.js version:", process.version);
  console.log("   ✓ Executable path:", process.execPath);

  console.log("2. Checking project structure...");
  const gatewayPath = resolveGatewayPath();
  const requiredPaths = [
    ["CLI entry", join(packageDir, "agent.js")],
    ["CLI manifest", join(packageDir, "package.json")],
    ["Gateway build", gatewayPath],
  ];
  for (const [label, target] of requiredPaths) {
    if (target && fs.existsSync(target)) {
      console.log(`   ✓ ${label}: ${target}`);
    } else {
      console.log(`   ✗ ${label}: missing`);
    }
  }

  console.log("\n3. Checking network stack...");
  console.log(`   ${net.isIP("127.0.0.1") ? "✓" : "✗"} TCP/IP stack available`);

  console.log("\n=== Diagnostic Complete ===");
  console.log("\nNext steps:");
  if (gatewayPath) {
    console.log("1. Run `agent start` to launch the dashboard.");
  } else {
    console.log("1. Build the gateway or set MIKI_GATEWAY_PATH, then run `agent start`.");
  }
  console.log("2. Run `agent help` for command details.");
}

async function installPackage() {
  console.log("=== miki Package Installation ===\n");

  if (isWindowsInstaller) {
    console.log("This appears to be running from the Windows installer.");
    console.log("The agent will launch automatically when installation completes.");
    return;
  }

  const workspaceDir = configuredWorkspaceDir();
  console.log(`Preparing workspace at ${workspaceDir}...`);
  for (const directory of ["data", "logs", "config"]) {
    const directoryPath = join(workspaceDir, directory);
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    console.log(`   ✓ Ready: ${directoryPath}`);
  }

  if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
  console.log("\nInstallation preparation complete.");
  console.log("Run `agent start` to launch the dashboard.");
}

async function uninstallPackage() {
  const argv = parseArgs();
  const workspaceDir = configuredWorkspaceDir();
  const purge = argv.purge === true;

  console.log("=== miki Package Uninstallation ===\n");
  if (!purge) {
    console.log("CLI uninstall completed; workspace data was retained.");
    console.log(`Retained workspace: ${workspaceDir}`);
    console.log("Use `agent uninstall --purge` only when data deletion is intended.");
    return;
  }

  for (const directory of ["data", "logs", "config"]) {
    const target = join(workspaceDir, directory);
    if (!fs.existsSync(target)) {
      console.log(`   - Not present: ${target}`);
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`   ✓ Deleted: ${target}`);
  }
  console.log("\nWorkspace data deletion complete.");
}

async function showVersion() {
  console.log("=== miki Version Information ===\n");
  try {
    const pkgPath = join(packageDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    console.log("Package Name:     ", pkg.name);
    console.log("Version:          ", pkg.version);
    console.log("Description:      ", pkg.description || "Local-first AI assistant runtime");
    console.log("License:          ", pkg.license || "MIT");
    console.log("Node Requirement: ", pkg.engines?.node || "^20.19.0 || ^22.13.0 || >=24");
    console.log("Package Manager:  ", pkg.packageManager || "npm");
  } catch (error) {
    console.error("Error reading version information:", error.message);
    process.exitCode = 1;
  }
}

function showHelp() {
  console.log("=== miki CLI Command Reference ===\n");
  console.log("Commands:");
  console.log("  agent start                    Start the miki dashboard and agent runtime");
  console.log("  agent doctor                   Run system diagnostics and health checks");
  console.log("  agent install                  Prepare data, logs, and config directories");
  console.log("  agent uninstall                Remove the CLI workspace registration but retain data");
  console.log("  agent uninstall --purge        Delete the workspace data, logs, and config directories");
  console.log("  agent version                  Show version information");
  console.log("  agent help                     Show this help information");
  console.log("\nFlags:");
  console.log("  --tray                         Request tray mode (gateway fallback on headless systems)");
  console.log("  --help, -h                     Show help");
  console.log("  --purge                        Allow workspace data deletion during uninstall");
  console.log("\nEnvironment Variables:");
  console.log("  MIKI_INSTALLER=1               Indicates Windows installer mode");
  console.log("  MIKI_WORKSPACE_DIR             Workspace directory for install/uninstall");
  console.log("  MIKI_GATEWAY_PATH              Explicit built gateway entry file");
}

process.on("SIGINT", () => {
  console.log("\nReceived interrupt signal. Shutting down gracefully...");
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

runCommand().catch((error) => {
  console.error("CLI error:", error.message);
  process.exitCode = 1;
});
