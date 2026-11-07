import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { MEDIA_ROUTE, stageChatFile } from "./chat-attachments.js";
import { createChatMediaHandler } from "./chat-media-route.js";

describe("chat media route", () => {
  let workspace: string;
  let dataRoot: string;
  let outside: string;
  let server: http.Server;
  let base: string;
  const ctx = () => ({ workspaceRoot: workspace, dataRoot });

  beforeAll(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-route-"));
    workspace = path.join(root, "workspace");
    dataRoot = path.join(root, "data");
    outside = path.join(root, "outside");
    for (const dir of [workspace, path.join(dataRoot, "screenshots"), outside]) fs.mkdirSync(dir, { recursive: true });
    const app = express();
    app.get(MEDIA_ROUTE, createChatMediaHandler(ctx));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves a video from a dot-folder with Range support so players can seek", async () => {
    const dir = path.join(workspace, ".miki-chat-uploads");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "clip.mp4");
    fs.writeFileSync(file, Buffer.from("0123456789"));
    const url = `${base}${MEDIA_ROUTE}?path=${encodeURIComponent(file)}`;
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toContain("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const part = await fetch(url, { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("2345");
  });

  it("delivers an outbox file as a download that keeps its original (Bengali) name", async () => {
    const source = path.join(outside, "রিপোর্ট.apk");
    fs.writeFileSync(source, "apk-bytes");
    const staged = await stageChatFile(source, ctx(), { allowOutsideWorkspace: true });
    const response = await fetch(`${base}${staged.attachment.url}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("রিপোর্ট.apk")}`);
    expect(await response.text()).toBe("apk-bytes");
  });

  it("returns 404 for files outside the served roots and for secrets", async () => {
    const stray = path.join(outside, "photo.png");
    fs.writeFileSync(stray, "png");
    fs.writeFileSync(path.join(workspace, ".env"), "KEY=1");
    for (const target of [stray, path.join(workspace, ".env"), "../outside/photo.png"]) {
      const response = await fetch(`${base}${MEDIA_ROUTE}?path=${encodeURIComponent(target)}`);
      expect(response.status).toBe(404);
    }
  });
});
