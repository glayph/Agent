import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createFileManagerRouter, FileManagerError } from "./file-manager-router.js";
import { normalizeRuntimePaths } from "../paths.js";
import { runWorkspaceFile, FileRunError, summarizeRun } from "../engine/file-runner.js";

jest.setTimeout(20_000);

async function withServer<T>(
  options: { allowRun?: () => boolean; withRunner?: boolean },
  run: (base: string, workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miki-frun-")));
  const app = express();
  app.use(express.json());
  app.use(
    "/files",
    createFileManagerRouter({
      runtimePaths: normalizeRuntimePaths(workspace),
      allowRun: options.allowRun,
      runFile:
        options.withRunner === false
          ? undefined
          : async (target) => {
              try {
                const result = await runWorkspaceFile({ root: workspace, file: target });
                return { ok: result.status === "ok", message: summarizeRun(result), result };
              } catch (error) {
                if (error instanceof FileRunError) throw new FileManagerError(error.status, error.message);
                throw error;
              }
            },
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    return await run(`http://127.0.0.1:${address.port}`, workspace);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const post = (base: string, target: string) =>
  fetch(`${base}/files/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target }) });

describe("file manager /run, /preview and /roots", () => {
  it("runs a script and returns its output", async () => {
    await withServer({}, async (base, workspace) => {
      const script = path.join(workspace, "hi.js");
      fs.writeFileSync(script, 'console.log("ran")');
      const response = await post(base, script);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; result: { stdout: string; exitCode: number } };
      expect(body.status).toBe("ok");
      expect(body.result.stdout.trim()).toBe("ran");
      expect(body.result.exitCode).toBe(0);
    });
  });

  it("answers a failing script with 422 and the error line", async () => {
    await withServer({}, async (base, workspace) => {
      const script = path.join(workspace, "bad.js");
      fs.writeFileSync(script, 'console.error("it broke");process.exit(2)');
      const response = await post(base, script);
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: string; result: { exitCode: number } };
      expect(body.error).toContain("code 2");
      expect(body.error).toContain("it broke");
      expect(body.result.exitCode).toBe(2);
    });
  });

  it("maps runner errors to HTTP statuses (unsupported type, outside the workspace, missing)", async () => {
    await withServer({}, async (base, workspace) => {
      const text = path.join(workspace, "notes.txt");
      fs.writeFileSync(text, "x");
      expect((await post(base, text)).status).toBe(400);
      expect((await post(base, path.join(workspace, "missing.js"))).status).toBeGreaterThanOrEqual(400);
      expect((await post(base, "/etc/hostname")).status).toBe(403);
      expect((await post(base, "relative.js")).status).toBe(400);
      expect((await post(base, workspace)).status).toBe(400);
    });
  });

  it("honours the execution kill switch for /run and /roots", async () => {
    let enabled = true;
    await withServer({ allowRun: () => enabled }, async (base, workspace) => {
      const script = path.join(workspace, "hi.js");
      fs.writeFileSync(script, "console.log(1)");
      const rootsOn = (await (await fetch(`${base}/files/roots`)).json()) as { roots: Array<{ canRun: boolean }> };
      expect(rootsOn.roots[0].canRun).toBe(true);
      enabled = false;
      const rootsOff = (await (await fetch(`${base}/files/roots`)).json()) as { roots: Array<{ canRun: boolean }> };
      expect(rootsOff.roots[0].canRun).toBe(false);
      const response = await post(base, script);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toContain("disabled");
    });
  });

  it("previews images inline with the right type and supports byte ranges", async () => {
    await withServer({}, async (base, workspace) => {
      const png = path.join(workspace, "pic.png");
      fs.writeFileSync(png, Buffer.from("0123456789"));
      const full = await fetch(`${base}/files/preview?path=${encodeURIComponent(png)}`);
      expect(full.status).toBe(200);
      expect(full.headers.get("content-type")).toBe("image/png");
      expect(full.headers.get("content-disposition")).toContain("inline");
      const part = await fetch(`${base}/files/preview?path=${encodeURIComponent(png)}`, { headers: { Range: "bytes=2-5" } });
      expect(part.status).toBe(206);
      expect(await part.text()).toBe("2345");
      expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
      const text = path.join(workspace, "a.txt");
      fs.writeFileSync(text, "x");
      expect((await fetch(`${base}/files/preview?path=${encodeURIComponent(text)}`)).status).toBe(415);
    });
  });

  it("serves downloads as attachments", async () => {
    await withServer({}, async (base, workspace) => {
      const file = path.join(workspace, "data.txt");
      fs.writeFileSync(file, "payload");
      const response = await fetch(`${base}/files/download?path=${encodeURIComponent(file)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain("attachment");
      expect(await response.text()).toBe("payload");
      expect((await fetch(`${base}/files/download?path=${encodeURIComponent("/etc/hostname")}`)).status).toBe(403);
    });
  });
});
