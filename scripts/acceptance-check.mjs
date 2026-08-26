#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.env.MIKI_SOURCE_ROOT || process.cwd());
const workspace = path.resolve(process.env.MIKI_WORKSPACE_DIR || root);
const live = process.argv.includes("--live");
const results = [];
function check(id, status, message, evidence = {}) {
  results.push({ id, status, message, evidence });
}
function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}
function secretConfigured(name) {
  return Boolean(process.env[name] || process.env[`MIKI_${name}`]);
}

check(
  "runtime.files",
  exists("packages/gateway/dist/index.js") && exists("scripts/miki-24-7.mjs")
    ? "pass"
    : "fail",
  "Runtime entrypoints are present.",
  { root },
);
check(
  "deployment.linux",
  exists("deploy/linux/install-systemd.sh") &&
    exists("deploy/linux/validate-host.sh")
    ? "ready"
    : "fail",
  "Linux deployment assets are present.",
);
check(
  "deployment.windows",
  exists("deploy/windows/install-task.ps1") &&
    exists("deploy/windows/validate-host.ps1")
    ? "ready"
    : "fail",
  "Windows deployment assets are present.",
);
check(
  "monitoring",
  exists("scripts/health-watch.mjs") ? "ready" : "fail",
  "Health watcher is present.",
);
check(
  "stt",
  secretConfigured("MIKI_WHISPER_MODEL_PATH") &&
    exists("packages/core/src/speech-to-text.ts")
    ? "configured"
    : "not_run",
  "STT requires a target-host model path and native runtime validation.",
);
check(
  "channels",
  "not_run",
  "Credentialed channel delivery is intentionally not attempted by this safe acceptance check.",
  {
    supported: [
      "telegram",
      "discord",
      "slack",
      "whatsapp",
      "facebook",
      "youtube",
    ],
  },
);
check(
  "mcp",
  "not_run",
  "External MCP authentication/reconnect/side-effect checks require an approved target server.",
);
check(
  "network",
  process.env.GATEWAY_HOST &&
    process.env.GATEWAY_HOST !== "127.0.0.1" &&
    process.env.MIKI_TLS_TERMINATED !== "true"
    ? "fail"
    : "ready",
  "Non-loopback exposure requires TLS termination or an explicit controlled-lab override.",
);
check(
  "reboot",
  "not_run",
  "Real OS reboot and crash recovery cannot be certified from this process.",
);
check(
  "soak",
  "not_run",
  "Run the soak harness on the target host and attach JSONL evidence.",
);

if (live) {
  const url =
    process.env.MIKI_HEALTH_URL || "http://127.0.0.1:18800/gateway/health";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({}));
    check(
      "gateway.health",
      response.ok && body?.status === "ok" ? "pass" : "fail",
      `Health endpoint returned HTTP ${response.status}.`,
      { url, body },
    );
  } catch (error) {
    check("gateway.health", "fail", "Health endpoint is unreachable.", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
} else {
  check(
    "gateway.health",
    "not_run",
    "Use --live to perform a safe GET health probe.",
  );
}

const summary = {
  checkedAt: new Date().toISOString(),
  root,
  workspace,
  live,
  pass: results.filter((item) => item.status === "pass").length,
  ready: results.filter(
    (item) => item.status === "ready" || item.status === "configured",
  ).length,
  notRun: results.filter((item) => item.status === "not_run").length,
  fail: results.filter((item) => item.status === "fail").length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.fail > 0 ? 1 : 0;
