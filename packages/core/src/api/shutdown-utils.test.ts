import * as http from "http";
import { WebSocketServer } from "ws";
import { closeHttpServer, closeWebSocketServer } from "./shutdown-utils.js";

describe("shutdown utilities", () => {
  test("closeHttpServer resolves after the server closes", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, resolve));

    await expect(closeHttpServer(server)).resolves.toBeUndefined();
  });

  test("closeHttpServer treats an already closed server as closed", async () => {
    const server = http.createServer();

    await expect(closeHttpServer(server)).resolves.toBeUndefined();
  });

  test("closeWebSocketServer resolves after closing the server", async () => {
    const server = new WebSocketServer({ noServer: true });

    await expect(closeWebSocketServer(server)).resolves.toBeUndefined();
  });
});
