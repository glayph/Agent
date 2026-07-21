import { WebSocket as WSWebSocket, WebSocketServer } from "ws";
import type * as http from "http";
import type { Duplex } from "stream";

const MAX_PAYLOAD = 5 * 1024 * 1024;
const MAX_EARLY_MESSAGES = 100;

export function createRelayWebSocketServer() {
  return new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
}

export function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

export function rejectWsUpgrade(socket: Duplex, statusCode: 401 | 403, reason: string): void {
  const body = JSON.stringify({ error: reason });
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "\r\n" + body,
  );
  socket.destroy();
}

export function hasWsAuthMaterial(request: http.IncomingMessage): boolean {
  return Boolean(
    firstHeaderValue(request.headers.cookie) ||
    firstHeaderValue(request.headers.authorization) ||
    firstHeaderValue(request.headers["x-api-key"]),
  );
}

function forwardedWsHeaders(request: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of ["cookie", "authorization", "x-api-key", "origin"]) {
    const value = firstHeaderValue(request.headers[key]);
    if (value) headers[key] = value;
  }
  return headers;
}

export function relayWs(
  clientWs: WSWebSocket,
  coreUrl: string,
  request: http.IncomingMessage,
  activeConnections: Set<WSWebSocket>,
): void {
  const coreWs = new WSWebSocket(coreUrl, { headers: forwardedWsHeaders(request) });
  const earlyMessages: Buffer[] = [];
  activeConnections.add(clientWs);

  const cleanup = () => {
    activeConnections.delete(clientWs);
    try { coreWs.close(); } catch { /* ignore */ }
  };

  clientWs.on("message", (data) => {
    if (coreWs.readyState === WSWebSocket.OPEN) {
      coreWs.send(data);
    } else if (earlyMessages.length < MAX_EARLY_MESSAGES) {
      if (Buffer.isBuffer(data)) earlyMessages.push(data);
      else if (data instanceof ArrayBuffer) earlyMessages.push(Buffer.from(data));
      else earlyMessages.push(Buffer.from(data.toString()));
    }
  });

  coreWs.on("open", () => {
    for (const msg of earlyMessages) {
      if (coreWs.readyState === WSWebSocket.OPEN) coreWs.send(msg);
    }
    earlyMessages.length = 0;
    coreWs.on("message", (data) => {
      if (clientWs.readyState === WSWebSocket.OPEN) clientWs.send(data);
    });
  });

  clientWs.on("close", cleanup);
  clientWs.on("error", cleanup);
  coreWs.on("close", () => activeConnections.delete(clientWs));
  coreWs.on("error", () => activeConnections.delete(clientWs));
}

export function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    for (const ws of wss.clients) {
      try { ws.close(1001, "Server shutdown"); } catch { /* ignore */ }
    }
    wss.close(() => resolve());
  });
}
