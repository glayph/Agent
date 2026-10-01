#!/usr/bin/env node

import { spawnSync } from "node:child_process";

if (process.env.MIKI_SKIP_PLAYWRIGHT_INSTALL === "true") {
  console.log("[Playwright] Chromium installation skipped by MIKI_SKIP_PLAYWRIGHT_INSTALL=true.");
  process.exit(0);
}

const npmCommand = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npx";
const args =
  process.platform === "win32"
    ? ["/d", "/s", "/c", "npx --no-install playwright install chromium"]
    : ["--no-install", "playwright", "install", "chromium"];

console.log("[Playwright] Ensuring the Chromium browser binary is installed...");
const result = spawnSync(npmCommand, args, {
  stdio: "inherit",
  shell: false,
});

if (result.error || result.status !== 0) {
  const detail = result.error?.message || `exit code ${result.status}`;
  console.error(
    `[Playwright] Chromium installation failed (${detail}). ` +
      "Run `npx playwright install chromium` before using browser tools.",
  );
  process.exit(result.status && result.status > 0 ? result.status : 1);
}

console.log("[Playwright] Chromium browser binary is ready.");
