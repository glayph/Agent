import * as http from "http";
import * as child_process from "child_process";

export interface HasExited {
  exitCode: number | null;
  signalCode: string | null;
}

export interface CloseHttpServerOptions {
  timeoutMs?: number;
  onForceClose?: () => void;
}

export function closeHttpServer(
  server: http.Server,
  options: CloseHttpServerOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      resolved = true;
      options.onForceClose?.();
      resolve();
    }, timeoutMs);
    timer.unref?.();
    server.close(() => {
      if (!resolved) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

export function hasExited(proc: child_process.ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

export function waitForProcessExit(proc: child_process.ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(proc)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

export async function terminateProcessTree(
  proc: child_process.ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (hasExited(proc)) return;

  if (process.platform === "win32" && proc.pid) {
    child_process.spawnSync("taskkill", ["/T", "/PID", String(proc.pid)], { stdio: "ignore", shell: false });
    await waitForProcessExit(proc, timeoutMs);
    if (!hasExited(proc)) {
      child_process.spawnSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore", shell: false });
      await waitForProcessExit(proc, 2000);
    }
    return;
  }

  proc.kill("SIGTERM");
  await waitForProcessExit(proc, timeoutMs);
  if (!hasExited(proc)) {
    proc.kill("SIGKILL");
    await waitForProcessExit(proc, 2000);
  }
}
