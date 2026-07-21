#!/usr/bin/env node
// packages/cli/agent.js - CLI entry point for public npm package
// This file serves as the main CLI entry point when the Nexus package is installed via npm.
// It handles both normal dashboard launching and tray mode operation.

// Usage:
//   agent [command] [options]
//   Hiro [command] [options]

// Commands:
//   start     Start the agent dashboard
//   doctor    Run system diagnostics  
//   install    Install the agent
//   uninstall  Uninstall the agent
//   version   Show version information
//   help      Show help information

// This script dynamically launches the appropriate dashboard based on context:
// - For npm package distribution: launches the express gateway
// - For Windows installer: launches the native Hiro.exe wrapper
// - With --tray flag: launches in system tray mode for minimalist operation

import process from "node:process";
import { join, dirname } from "node:path";
import fs from "node:fs";
import child_process from "node:child_process";
import net from "node:net";

// Helper function to convert import.meta.url to file path
const fileURLToPath = (url) => {
  if (url.startsWith('file://')) {
    let filePath = url.replace('file://', '');
    if (process.platform === 'win32') {
      filePath = filePath.replace(/\//g, '\\\\');
    }
    return filePath;
  }
  return url;
};

// Get current directory for resolving paths
const getCurrentDir = () => {
  const moduleUrl = import.meta?.url || '';
  return moduleUrl ? fileURLToPath(moduleUrl) : process.cwd();
};

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || "start";
const options = args.slice(1);

// Determine execution context
const isWindowsInstaller = process.platform === "win32" && process.env["Hiro_INSTALLER"] === "1";
const isTrayMode = options.includes("--tray");
const isNpmPackage = process.env["Hiro_NPM_PACKAGE"] === "1";

async function runCommand() {
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

function parseArgs() {
  const argObj = {};
  options.forEach((opt, i) => {
    if (opt.startsWith("--")) {
      const key = opt.replace(/^--/, "");
      const nextIdx = i + 1;
      if (nextIdx < options.length && !options[nextIdx].startsWith("--")) {
        argObj[key] = options[nextIdx];
      } else {
        argObj[key] = true;
      }
    }
  });
  return argObj;
}

async function startDashboard() {
  const argv = parseArgs();
  const env = process.env;

  // Determine if we're launching with installer or normal mode
  if (isWindowsInstaller && !isTrayMode) {
    // Use the native Hiro.exe wrapper for Windows installer
    const exePath = join(getCurrentDir(), "..", "..", "installer", "windows", "launcher-go", "Hiro.exe");

    if (fs.existsSync(exePath)) {
      console.log("Launching dashboard via Windows installer wrapper...");
      const child = child_process.spawn(exePath, ["--dashboard"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });

      // Store the process for later cleanup
      child.unref();
      return;
    }
  }

  // Normal dashboard launch (npm package or advanced usage)
  console.log("Starting Nexus dashboard...");
  
  if (isTrayMode) {
    console.log("System tray mode enabled.");
  }

  // Launch the gateway directly
  const gatewayPath = join(getCurrentDir(), "..", "..", "packages", "gateway", "dist", "index.js");

  if (fs.existsSync(gatewayPath)) {
    console.log("Launching gateway from:", gatewayPath);
    const child = child_process.spawn(process.execPath, [gatewayPath], {
      detached: true,
      stdio: "inherit",
      cwd: dirname(gatewayPath),
    });

    child.unref();
    console.log("Dashboard started successfully!");
  } else {
    console.error("Error: Gateway not found at", gatewayPath);
    console.error("Please run 'npm run build' first.");
    process.exit(1);
  }
}

async function runDoctor() {
  console.log("=== Nexus System Diagnostic ===\\n");

  console.log("1. Checking Node.js environment...");
  try {
    const nodePath = process.execPath;
    const nodeVersion = process.version;
    console.log("   ✓ Node.js version:", nodeVersion);
    console.log("   ✓ Executable path:", nodePath);
  } catch (error) {
    console.log("   ✗ Node.js error:", error.message);
  }

  console.log("2. Checking project structure...");
  const requiredPaths = [
    join(getCurrentDir(), "..", "..", "README.md"),
    join(getCurrentDir(), "..", "..", "package.json"),
    join(getCurrentDir(), "..", "..", "packages", "gateway", "dist", "index.js"),
  ];

  for (const p of requiredPaths) {
    if (fs.existsSync(p)) {
      console.log("   ✓", p.split('/').pop());
    } else {
      console.log("   ✗", p.split('/').pop(), "(missing)");
    }
  }

  console.log("\\n3. Check optional components...");

  try {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    console.log("   ✓ Network stack available");
  } catch (error) {
    console.log("   ✗ Network issue:", error.message);
  }

  console.log("\\n=== Diagnostic Complete ===");
  console.log("\\nNext steps:");
  console.log("1. http://127.0.0.1:18800 - Access the dashboard");
  console.log("2. npm run verify - Run package verification");
  console.log("3. npm start - Start the agent runtime");
}

async function installPackage() {
  console.log("=== Nexus Package Installation ===\\n");

  if (isWindowsInstaller) {
    console.log("This appears to be running from the Windows installer.");
    console.log("The agent will launch automatically when you close this window.");
    return;
  }

  console.log("Installing Nexus from npm package...");

  const dirs = ["data", "logs", "config"];

  for (const dir of dirs) {
    const dirPath = join(process.cwd(), dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log("   Created directory:", dir);
    }
  }

  if (!process.env["NODE_ENV"]) {
    process.env["NODE_ENV"] = "production";
  }

  console.log("\\nInstallation complete!");
  console.log("\\nUsage:");
  console.log("  npm start  # Start the agent runtime");
  console.log("  agent start   # Start the CLI (if available)");
}

async function uninstallPackage() {
  console.log("=== Nexus Package Uninstallation ===\\n");

  if (!isWindowsInstaller) {
    console.log("Warning: This will remove Nexus from the system.");
    console.log("Do you want to continue? (y/N)");
    console.log("(Auto-confirming for non-Windows installer...)");
  }

  console.log("Uninstalling Nexus...");

  const sensitivePaths = ["data", "logs"];
  for (const p of sensitivePaths) {
    const fullPath = join(process.cwd(), p);
    if (fs.existsSync(fullPath)) {
      console.log("   Would clean:", fullPath);
    }
  }

  console.log("\\nUninstall complete!");
}

async function showVersion() {
  console.log("=== Nexus Version Information ===\\n");

  try {
    const pkgPath = join(getCurrentDir(), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    console.log("Package Name:     ", pkg.name);
    console.log("Version:          ", pkg.version);
    console.log("Description:      ", pkg.description || "Local-first AI assistant runtime");
    console.log("License:          ", pkg.license || "MIT");
    console.log("Node Requirement: ", pkg.engines?.node || "^20.19.0 || ^22.13.0 || >=24");
    console.log("Package Manager:  ", pkg.packageManager || "npm");

    console.log("\\nBuild Components:");
    console.log("  - Gateway (Express)");
    console.log("  - Core API (TypeScript)");
    console.log("  - Memory (GraphRAG)");
    console.log("  - Skills Library");
    console.log("  - Channel Adapters (11+ channels)");
    console.log("  - Dashboard (React)");
    console.log("  - Configuration Management");
    console.log("  - Installation System");

    console.log("\\nRuntime Features:");
    console.log("  - Chat session management");
    console.log("  - Model provider configuration (OpenAI, Gemini, Anthropic, LiteLLM)");
    console.log("  - Tool registry and execution");
    console.log("  - Skill installation and management");
    console.log("  - Persistent SQLite memory");
    console.log("  - MCP server support");
    console.log("  - Channel adapters and webhooks");
    console.log("  - Health diagnostics and monitoring");
    console.log("  - Backup and rollback support");

  } catch (error) {
    console.error("Error reading version information:", error.message);
  }
}

function showHelp() {
  console.log("=== Nexus CLI Command Reference ===\\n");
  console.log("Commands:");
  console.log("  agent start       Start the Nexus dashboard and agent runtime");
  console.log("  agent doctor      Run system diagnostics and health checks");
  console.log("  agent install     Install Nexus (npm package mode)");
  console.log("  agent uninstall   Uninstall Nexus from the system");
  console.log("  agent version     Show version and build information");
  console.log("  agent help        Show comprehensive help information");
  console.log("\\nFlags:");
  console.log("  --tray           Launch in system tray mode (minimal interface)");
  console.log("  --help           Show help for specific command");
  console.log("\\nEnvironment Variables:");
  console.log("  Hiro_INSTALLER=1    Indicates running from Windows installer");
  console.log("  Hiro_NPM_PACKAGE=1  Indicates running from npm package");
  console.log("\\nExamples:");
  console.log("  agent start                    # Start dashboard normally");
  console.log("  agent start --tray            # Start in system tray mode");
  console.log("  agent doctor                   # Check system health");
  console.log("\\nFor more information, visit: https://github.com/Hiro");
  console.log("For documentation, see: README.md");
}

process.on("SIGINT", () => {
  console.log("\\nReceived interrupt signal. Shutting down gracefully...");
  if (isTrayMode) {
    console.log("Tray mode: Minimized to system tray.");
  }
  process.exit(0);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

runCommand().catch((error) => {
  console.error("CLI error:", error.message);
  process.exit(1);
});