#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = path.join(PROJECT_ROOT, "dist", "runtime");

process.env.Hiro_RUNTIME_ROOT = process.env.Hiro_RUNTIME_ROOT || RUNTIME_ROOT;
process.env.Hiro_WORKSPACE_DIR = process.env.Hiro_WORKSPACE_DIR || PROJECT_ROOT;
process.env.Hiro_RUNTIME_LOADER = path.join(RUNTIME_ROOT, "runtime-loader.mjs");
process.env.Hiro_NODE = process.execPath;

const loaderPath = pathToFileURL(process.env.Hiro_RUNTIME_LOADER).href;
register(loaderPath, pathToFileURL(PROJECT_ROOT + "/"));

const gatewayPath = pathToFileURL(path.join(PROJECT_ROOT, "dist", "runtime", "packages", "gateway", "dist", "index.js")).href;

(async () => {
  try {
    await import(gatewayPath);
  } catch (err) {
    console.error("Failed to start gateway:", err);
    process.exit(1);
  }
})();
