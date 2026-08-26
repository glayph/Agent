#!/usr/bin/env node
import process from "node:process";
import path from "node:path";

const allowed = new Set([
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
]);
const index = process.argv.indexOf("--name");
const name = index >= 0 ? process.argv[index + 1] : "";
const value = process.env.MIKI_NEW_SECRET || "";
const workspaceDir = path.resolve(
  process.env.MIKI_CONFIG_DIR ||
    process.env.MIKI_WORKSPACE_DIR ||
    path.resolve("config"),
);
if (!allowed.has(name)) {
  console.error(
    `Unsupported secret name. Allowed names: ${Array.from(allowed).join(", ")}`,
  );
  process.exit(2);
}
if (!value.trim()) {
  console.error(
    "Set MIKI_NEW_SECRET in the environment; never pass the secret as a command-line argument.",
  );
  process.exit(2);
}
const config = await import("../packages/config/dist/index.js");
config.setEnvSecret(name, value.trim(), workspaceDir);
console.log(
  JSON.stringify({ ok: true, secret: name, workspaceDir, value: "[redacted]" }),
);
