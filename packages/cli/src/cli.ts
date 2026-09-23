#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..", "..");
const VERSION = readVersion();
const STATES = ["stopped", "starting", "running", "stopping", "error"] as const;
type State = (typeof STATES)[number];

type Config = {
  command: string;
  workspaceDir: string;
  runtimeRoot: string;
  gatewayEntry: string;
  runtimeLoader: string;
  nodePath: string;
  host: string;
  port: number;
  corePort: number;
  liteLLMPort: number;
  debug: boolean;
  plain: boolean;
};

function readVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: string };
    return process.env.MIKI_PACKAGE_VERSION || packageJson.version || "1.0.0";
  } catch {
    return process.env.MIKI_PACKAGE_VERSION || "1.0.0";
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => Boolean(value?.trim()))?.trim() || "";
}

function numberEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid port: ${value}`);
  return port;
}

function discoverWorkspace(): string {
  let current = process.cwd();
  while (true) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "bin", "miki.js"))) return current;
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function parseConfig(args: string[]): Config {
  const workspaceDir = resolve(firstNonEmpty(process.env.MIKI_WORKSPACE_DIR, process.env.Miki_WORKSPACE_DIR, discoverWorkspace()));
  const candidateRuntime = resolve(workspaceDir, "dist", "runtime");
  const runtimeRoot = resolve(firstNonEmpty(process.env.MIKI_RUNTIME_ROOT, process.env.Miki_RUNTIME_ROOT, existsSync(join(candidateRuntime, "packages", "gateway", "dist", "index.js")) ? candidateRuntime : workspaceDir));
  const config: Config = {
    command: "start",
    workspaceDir,
    runtimeRoot,
    gatewayEntry: firstNonEmpty(process.env.MIKI_GATEWAY_ENTRY, process.env.Miki_GATEWAY_ENTRY, join(runtimeRoot, "packages", "gateway", "dist", "index.js")),
    runtimeLoader: firstNonEmpty(process.env.MIKI_RUNTIME_LOADER, process.env.Miki_RUNTIME_LOADER, join(runtimeRoot, "runtime-loader.mjs")),
    nodePath: firstNonEmpty(process.env.MIKI_NODE, process.env.Miki_NODE, process.execPath),
    host: firstNonEmpty(process.env.GATEWAY_HOST, "127.0.0.1"),
    port: numberEnv("GATEWAY_PORT", 18800),
    corePort: numberEnv("CORE_PORT", 8000),
    liteLLMPort: numberEnv("LITELLM_PORT", 4000),
    debug: false,
    plain: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]?.trim() || "";
    if (!arg || arg === "start") config.command = "start";
    else if (["help", "-h", "--help"].includes(arg)) config.command = "help";
    else if (["version", "-v", "--version"].includes(arg)) config.command = "version";
    else if (["doctor", "install", "uninstall"].includes(arg)) config.command = arg;
    else if (arg === "weke") config.command = "weke";
    else if (arg === "--debug" || arg === "-d") config.debug = true;
    else if (arg === "--plain") config.plain = true;
    else if (arg === "--host" || arg === "--port") {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value`);
      if (arg === "--host") config.host = value;
      else config.port = parsePort(value);
    } else if (arg.startsWith("--host=")) config.host = arg.slice(7).trim();
    else if (arg.startsWith("--port=")) config.port = parsePort(arg.slice(7));
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!config.host) config.host = "127.0.0.1";
  if (config.port <= 0 || config.port > 65535) throw new Error(`invalid gateway port: ${config.port}`);
  return config;
}

class Runtime {
  private child: ChildProcess | null = null;
  private state: State = "stopped";
  private error = "";
  private startedAt = 0;
  private readonly logs: string[] = [];
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(line: string) => void>();
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly config: Config) {}
  get currentState(): State { return this.state; }
  get lastError(): string { return this.error; }
  get pid(): number { return this.child?.pid || 0; }
  get uptime(): number { return this.startedAt ? Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)) : 0; }
  get dashboardUrl(): string { return `http://${this.config.host}:${this.config.port}`; }
  get recentLogs(): string[] { return [...this.logs]; }
  onLog(listener: (line: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async start(): Promise<void> { return this.queue(async () => {
    if (this.child || ["starting", "stopping"].includes(this.state)) return;
    this.state = "starting"; this.error = ""; this.startedAt = Date.now(); this.logs.length = 0; this.log("Starting Miki runtime...");
    if (!existsSync(this.config.gatewayEntry)) return this.fail(`gateway entrypoint not found: ${this.config.gatewayEntry}`);
    for (const [name, port] of [["gateway", this.config.port], ["core", this.config.corePort], ["LiteLLM", this.config.liteLLMPort]] as const) {
      if (port > 0 && !(await portAvailable(this.config.host, port))) return this.fail(`${name}: port ${port} is already in use on ${this.config.host}; stop the existing process or choose another --port`);
    }
    const args = loaderArgs(this.config.runtimeLoader);
    args.push(this.config.gatewayEntry);
    const env = { ...process.env, MIKI_RUNTIME_ROOT: this.config.runtimeRoot, Miki_RUNTIME_ROOT: this.config.runtimeRoot, MIKI_WORKSPACE_DIR: this.config.workspaceDir, Miki_WORKSPACE_DIR: this.config.workspaceDir, GATEWAY_HOST: this.config.host, GATEWAY_PORT: String(this.config.port), CORE_PORT: String(this.config.corePort), LITELLM_PORT: String(this.config.liteLLMPort), ...(this.config.debug ? { LOG_LEVEL: "debug" } : {}) };
    mkdirSync(join(this.config.workspaceDir, "data"), { recursive: true });
    const child = spawn(this.config.nodePath, args, { cwd: this.config.workspaceDir, env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child; writeFileSync(join(this.config.workspaceDir, "data", "gateway.pid"), String(child.pid)); this.log(`Runtime PID: ${child.pid}`);
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8"); child.stdout?.on("data", (chunk: string) => this.consume(chunk)); child.stderr?.on("data", (chunk: string) => this.consume(chunk));
    child.once("error", (err) => this.fail(`runtime failed: ${err.message}`));
    child.once("exit", (code, signal) => { this.child = null; if (this.healthTimer) clearInterval(this.healthTimer); this.healthTimer = null; if (this.state !== "stopping") { this.state = code === 0 ? "stopped" : "error"; if (code !== 0) this.error = `runtime exited with code ${code ?? signal ?? "unknown"}`; this.log(this.error || "Runtime stopped."); } });
    this.healthTimer = setInterval(() => void this.pollHealth(), 900);
    await this.pollHealth();
  }); }

  async stop(): Promise<void> { return this.queue(async () => {
    if (!this.child) { this.state = "stopped"; return; }
    this.state = "stopping"; this.log("Stopping Miki runtime..."); const child = this.child; child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => { const timer = setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); resolvePromise(); }, 4000); child.once("exit", () => { clearTimeout(timer); resolvePromise(); }); });
    this.state = "stopped"; this.child = null; try { rmSync(join(this.config.workspaceDir, "data", "gateway.pid")); } catch { /* already removed */ }
  }); }

  async restart(): Promise<void> { await this.stop(); await new Promise((resolvePromise) => setTimeout(resolvePromise, 350)); await this.start(); }
  private async queue(action: () => Promise<void>): Promise<void> { const next = this.operation.then(action, action); this.operation = next.catch(() => undefined); return next; }
  private fail(message: string): void { this.state = "error"; this.error = message; this.log(`Start failed: ${message}`); }
  private log(line: string): void { const clean = line.replace(/[\r\n]+$/, ""); if (!clean) return; this.logs.push(clean); if (this.logs.length > 1200) this.logs.shift(); for (const listener of this.listeners) listener(clean); }
  private consume(chunk: string): void { chunk.split(/\r?\n/).forEach((line) => this.log(line)); }
  private async pollHealth(): Promise<void> { if (!this.child) return; try { const response = await fetch(`${this.dashboardUrl}/gateway/health`, { signal: AbortSignal.timeout(1200) }); if (response.ok) { if (this.state === "starting") this.log("Gateway is healthy."); this.state = "running"; this.error = ""; } } catch { /* startup can take a moment */ } }
}

function portAvailable(host: string, port: number): Promise<boolean> { return new Promise((resolvePromise) => { const server = createServer(); server.once("error", () => resolvePromise(false)); server.listen(port, host, () => server.close(() => resolvePromise(true))); }); }
function loaderArgs(loader: string): string[] { if (!loader || !existsSync(loader)) return []; const code = `import { register } from "node:module"; register(${JSON.stringify(pathToFileURL(loader).href)}, pathToFileURL("./"));`; return ["--import", `data:text/javascript,${encodeURIComponent(code)}`]; }
function formatUptime(seconds: number): string { if (seconds < 60) return `${seconds}s`; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ${seconds % 60}s`; return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }

async function runPlain(config: Config): Promise<number> { const runtime = new Runtime(config); if (!process.stdout.isTTY) runtime.onLog((line) => process.stdout.write(`${line}\n`)); try { await runtime.start(); } catch (error) { console.error(`Miki: ${error instanceof Error ? error.message : String(error)}`); return 1; } console.log(`Miki\n  Dashboard  ${runtime.dashboardUrl}\n  Stop       Ctrl+C\n`); if (process.stdout.isTTY) runtime.onLog((line) => console.log(line)); return new Promise((resolvePromise) => { const shutdown = async () => { process.off("SIGINT", shutdown); await runtime.stop(); resolvePromise(runtime.currentState === "error" ? 1 : 0); }; process.once("SIGINT", shutdown); runtime.onLog(() => { if (runtime.currentState === "error") void shutdown(); }); }); }

async function runDashboard(config: Config): Promise<number> { const runtime = new Runtime(config); await runtime.start(); if (runtime.currentState === "error") { console.error(`Miki: ${runtime.lastError}`); return 1; } if (!process.stdin.isTTY || !process.stdout.isTTY) return runPlain(config); const stdin = process.stdin; stdin.setRawMode?.(true); stdin.resume(); stdin.setEncoding("utf8"); let selected = 0; let logsFocused = false; let confirmQuit = false; const actions = ["Start / Stop", "Restart", "Logs", "Shutdown"]; const render = () => { process.stdout.write("\x1b[2J\x1b[H"); const state = runtime.currentState.toUpperCase(); console.log(` MIKI  [${state}]  ${runtime.dashboardUrl}  uptime ${formatUptime(runtime.uptime)}`); console.log("─".repeat(Math.max(40, process.stdout.columns || 80))); actions.forEach((action, index) => console.log(`${!logsFocused && selected === index ? "❯" : " "} ${action}`)); console.log("\n Live logs"); console.log(runtime.recentLogs.slice(-12).join("\n") || "Waiting for runtime output..."); console.log(`\n ${confirmQuit ? "Shutdown Miki? Enter confirms, Esc cancels" : logsFocused ? "Tab menu · PgUp/PgDown/Home/End scroll · Q quit" : "Up/Down navigate · Enter action · Tab logs · Q quit"}`); }; const draw = () => render(); const onLog = () => draw(); runtime.onLog(onLog); const onData = async (key: string) => { if (confirmQuit) { if (["\r", " ", "y", "q", "\u0003"].includes(key)) { stdin.off("data", onData); stdin.setRawMode?.(false); await runtime.stop(); process.stdout.write("\n"); process.exit(0); } if (key === "\u001b") confirmQuit = false; draw(); return; } if (key === "q" || key === "\u0003" || key === "\u001b") confirmQuit = true; else if (key === "\t") logsFocused = !logsFocused; else if (!logsFocused && key === "\u001b[A") selected = Math.max(0, selected - 1); else if (!logsFocused && key === "\u001b[B") selected = Math.min(actions.length - 1, selected + 1); else if (key === "\r" || key === " ") { if (selected === 0) await (runtime.currentState === "running" || runtime.currentState === "starting" ? runtime.stop() : runtime.start()); else if (selected === 1) await runtime.restart(); else if (selected === 3) confirmQuit = true; } draw(); }; stdin.on("data", onData); const timer = setInterval(draw, 1000); draw(); return new Promise((resolvePromise) => process.once("exit", () => { clearInterval(timer); stdin.setRawMode?.(false); resolvePromise(0); })); }

function printHelp(): void { console.log(`Miki — modern TypeScript runtime CLI\n\nUsage:\n  miki [start] [options]    Start the dashboard and managed gateway\n  miki doctor                Inspect the local runtime\n  miki install               Prepare workspace directories\n  miki uninstall             Remove registration (keeps data)\n  miki version               Print version\n  miki weke                  Show readiness status\n\nOptions:\n  --host <host>              Gateway bind host\n  --port <port>              Gateway port\n  --debug                    Enable debug logging\n  --plain                    Disable the interactive terminal dashboard\n  -h, --help                 Show this help\n\nInteractive keys: ↑/↓ select, Enter activate, Tab logs, q quit.`); }

async function main(): Promise<number> { try { const config = parseConfig(process.argv.slice(2)); if (config.command === "help") { printHelp(); return 0; } if (config.command === "version") { console.log(VERSION); return 0; } if (config.command === "weke") { console.log("miki weke: ready (runtime services are not started by this command)"); return 0; } if (config.command === "doctor") { console.log(`Miki doctor\n  Node     ${process.version}\n  Gateway  ${existsSync(config.gatewayEntry) ? "found" : "missing"}\n  Runtime  ${config.runtimeRoot}\n  Host     ${config.host}:${config.port}`); return existsSync(config.gatewayEntry) ? 0 : 1; } if (config.command === "install") { ["data", "logs", "config"].forEach((dir) => mkdirSync(join(config.workspaceDir, dir), { recursive: true, mode: 0o700 })); console.log(`Workspace ready: ${config.workspaceDir}`); return 0; } if (config.command === "uninstall") { console.log("Miki uninstall: workspace data retained. Use a separate explicit cleanup command to delete it."); return 0; } return config.plain || !process.stdout.isTTY ? runPlain(config) : runDashboard(config); } catch (error) { console.error(`Miki: ${error instanceof Error ? error.message : String(error)}`); console.error("Run `miki help` for usage."); return 1; } }

process.exitCode = await main();
