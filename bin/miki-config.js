#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Prefer the packaged runtime under dist/runtime when it exists (built
// release / offline install layout). Fall back to running directly against
// the source checkout when it doesn't — mirroring bin/miki.js's
// resolveRuntimeRoot(), which already handles both layouts. Previously this
// hard-coded dist/runtime unconditionally and called register() on a loader
// file that only exists in the packaged layout, so any command (even
// read-only ones like `config get`) crashed immediately in a source
// checkout with no dist/runtime directory.
const PACKAGED_RUNTIME_ROOT = path.join(PROJECT_ROOT, "dist", "runtime");
const PACKAGED_LOADER = path.join(PACKAGED_RUNTIME_ROOT, "runtime-loader.mjs");
const usingPackagedRuntime = fs.existsSync(PACKAGED_LOADER);
const RUNTIME_ROOT = usingPackagedRuntime ? PACKAGED_RUNTIME_ROOT : PROJECT_ROOT;

process.env.Miki_RUNTIME_ROOT = process.env.Miki_RUNTIME_ROOT || RUNTIME_ROOT;
process.env.Miki_WORKSPACE_DIR = process.env.Miki_WORKSPACE_DIR || PROJECT_ROOT;
process.env.Miki_NODE = process.execPath;

let gatewayPath;
if (usingPackagedRuntime) {
  process.env.Miki_RUNTIME_LOADER = PACKAGED_LOADER;
  register(pathToFileURL(PACKAGED_LOADER).href, pathToFileURL(PROJECT_ROOT + "/"));
  gatewayPath = pathToFileURL(
    path.join(PACKAGED_RUNTIME_ROOT, "packages", "gateway", "dist", "index.js"),
  ).href;
} else {
  gatewayPath = pathToFileURL(
    path.join(PROJECT_ROOT, "packages", "gateway", "dist", "index.js"),
  ).href;
}

const argv = process.argv.slice(2);

async function readSecretFromPrompt(label) {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(`${label}: `)).trim();
  } finally {
    rl.close();
  }
}

async function runConfigCommand() {
  const { resolveConfiguredSecret, setConfiguredSecret, userConfigDir } =
    await import("@miki/config");
  const [command, subcommand, keyArg, valueArg] = argv;

  if (command === "setup") {
    const key = (subcommand || process.env.GEMINI_API_KEY || "").trim() ||
      (await readSecretFromPrompt("Paste your Gemini API key"));
    if (!key) {
      console.error("No Gemini API key provided.");
      process.exit(1);
    }
    setConfiguredSecret("GEMINI_API_KEY", key);
    console.log(`Gemini API key saved to your Miki user config at ${userConfigDir()}.`);
    console.log("Start Miki again and send a chat message to test it.");
    return true;
  }

  if (command === "config" && subcommand === "set") {
    const name = String(keyArg || "").trim().toUpperCase();
    const value = String(valueArg || "").trim() ||
      (await readSecretFromPrompt(`Paste value for ${name || "the key"}`));
    if (!name || !/^[A-Z0-9_]+$/.test(name)) {
      console.error("Usage: miki config set GEMINI_API_KEY <value>");
      process.exit(1);
    }
    if (!value) {
      console.error(`No value provided for ${name}.`);
      process.exit(1);
    }
    setConfiguredSecret(name, value);
    console.log(`${name} saved to your Miki user config at ${userConfigDir()}.`);
    return true;
  }

  if (command === "config" && subcommand === "path") {
    console.log(userConfigDir());
    return true;
  }

  if (command === "config" && subcommand === "get") {
    const name = String(keyArg || "").trim().toUpperCase();
    if (!name) {
      console.error("Usage: miki config get GEMINI_API_KEY");
      process.exit(1);
    }
    const value = resolveConfiguredSecret(name, PROJECT_ROOT);
    console.log(value ? `${name} is configured.` : `${name} is not configured.`);
    return true;
  }

  return false;
}

(async () => {
  try {
    if (await runConfigCommand()) return;
    await import(gatewayPath);
  } catch (err) {
    console.error("Failed to start gateway:", err);
    process.exit(1);
  }
})();
