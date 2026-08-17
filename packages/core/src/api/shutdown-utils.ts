import type { Server } from "http";
import type { WebSocketServer } from "ws";

export interface CloseServerOptions {
  timeoutMs?: number;
  onForceClose?: () => void;
}

export function closeHttpServer(
  server: Server,
  options: CloseServerOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let forceCloseTimer: NodeJS.Timeout;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceCloseTimer);
      const errorCode =
        error && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (errorCode === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    forceCloseTimer = setTimeout(() => {
      options.onForceClose?.();
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
    }, timeoutMs);
    forceCloseTimer.unref?.();

    server.close(finish);
    server.closeIdleConnections?.();
  });
}

export function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.close(1001, "Server shutdown");
  }

  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
