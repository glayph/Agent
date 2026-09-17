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
      // `server.close()` stops accepting new connections but, on a busy
      // gateway, can otherwise wait indefinitely on keep-alive/request
      // sockets. Node 18+ exposes this explicit force-close operation.
      server.closeAllConnections?.();
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

export function waitForProcessExit(
  proc: child_process.ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (hasExited(proc)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function descendantPids(rootPid: number): number[] {
  const descendants: number[] = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parentPid = pending.shift()!;
    try {
      const output = child_process.execFileSync(
        "pgrep",
        ["-P", String(parentPid)],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const children = String(output)
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      descendants.push(...children);
      pending.push(...children);
    } catch {
      // `pgrep` returns status 1 when there are no children and may be absent
      // on minimal systems; the direct child is still terminated below.
    }
  }
  return descendants.reverse();
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function terminateProcessTree(
  proc: child_process.ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (hasExited(proc)) return;

  if (process.platform === "win32" && proc.pid) {
    child_process.spawnSync("taskkill", ["/T", "/PID", String(proc.pid)], {
      stdio: "ignore",
      shell: false,
    });
    await waitForProcessExit(proc, timeoutMs);
    if (!hasExited(proc)) {
      child_process.spawnSync(
        "taskkill",
        ["/F", "/T", "/PID", String(proc.pid)],
        { stdio: "ignore", shell: false },
      );
      await waitForProcessExit(proc, 2000);
    }
    return;
  }

  const descendants = proc.pid ? descendantPids(proc.pid) : [];
  for (const pid of descendants) signalPid(pid, "SIGTERM");
  proc.kill("SIGTERM");
  await waitForProcessExit(proc, timeoutMs);
  for (const pid of descendants) signalPid(pid, "SIGKILL");
  if (!hasExited(proc)) {
    proc.kill("SIGKILL");
    await waitForProcessExit(proc, 2000);
  }
}
