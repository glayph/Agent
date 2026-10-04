import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as tar from "tar";
import { createFileManagerRouter } from "./file-manager-router.js";
import { normalizeRuntimePaths } from "../paths.js";

jest.setTimeout(15_000);

async function withServer<T>(
  options: { allowSensitive?: () => boolean },
  run: (base: string, workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miki-prot-")));
  fs.mkdirSync(path.join(workspace, "data"));
  fs.writeFileSync(path.join(workspace, "data", "secret-vault.json"), '{"k":"v"}');
  fs.writeFileSync(path.join(workspace, "data", "notes.txt"), "inside data dir");
  fs.mkdirSync(path.join(workspace, "project"));
  fs.writeFileSync(path.join(workspace, "project", "app.ts"), "export {}");
  fs.writeFileSync(path.join(workspace, "project", ".env"), "KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaa");
  fs.writeFileSync(path.join(workspace, "project", "server.pem"), "pem");
  const app = express();
  app.use(express.json());
  app.use(
    "/files",
    createFileManagerRouter({
      runtimePaths: normalizeRuntimePaths(workspace),
      protectedPaths: [path.join(workspace, "data")],
      allowSensitive: options.allowSensitive,
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    return await run(`http://127.0.0.1:${port}`, workspace);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const q = (p: string) => encodeURIComponent(p);

describe("file manager protected paths", () => {
  it("hides protected and credential files from listings", async () => {
    await withServer({}, async (base, ws) => {
      const root = (await (await fetch(`${base}/files?path=${q(ws)}`)).json()) as { entries: Array<{ name: string }>; total: number };
      expect(root.entries.map((e) => e.name).sort()).toEqual(["project"]);
      expect(root.total).toBe(1);
      const project = (await (await fetch(`${base}/files?path=${q(path.join(ws, "project"))}`)).json()) as { entries: Array<{ name: string }> };
      expect(project.entries.map((e) => e.name)).toEqual(["app.ts"]);
    });
  });

  it("refuses to read, download, preview, write, rename or delete them", async () => {
    await withServer({}, async (base, ws) => {
      const vault = path.join(ws, "data", "secret-vault.json");
      const env = path.join(ws, "project", ".env");
      for (const target of [vault, env, path.join(ws, "data", "notes.txt")]) {
        for (const route of ["read", "download", "preview"]) {
          const response = await fetch(`${base}/files/${route}?path=${q(target)}`);
          expect(response.status).toBe(403);
        }
      }
      const put = await fetch(`${base}/files/write`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: env, content: "x" }) });
      expect(put.status).toBe(403);
      const del = await fetch(`${base}/files`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: vault, recursive: false }) });
      expect(del.status).toBe(403);
      const rename = await fetch(`${base}/files/rename`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: env, newName: "plain.txt" }) });
      expect(rename.status).toBe(403);
      expect(fs.readFileSync(env, "utf8")).toContain("KEY=");
      expect(fs.existsSync(vault)).toBe(true);
    });
  });

  it("will not create a credential file through create/upload names or copy to a plain name", async () => {
    await withServer({}, async (base, ws) => {
      const create = await fetch(`${base}/files/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parentPath: path.join(ws, "project"), name: ".env.local", type: "file", content: "A=1" }) });
      expect(create.status).toBe(403);
      const copy = await fetch(`${base}/files/copy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [path.join(ws, "project", ".env")], destinationPath: path.join(ws, "project") }) });
      expect(copy.status).toBe(403);
    });
  });

  it("leaves protected files out of archives instead of failing", async () => {
    await withServer({}, async (base, ws) => {
      const response = await fetch(`${base}/files/download-archive?paths=${q(path.join(ws, "project"))}&paths=${q(path.join(ws, "data"))}`);
      // The data directory itself is protected, so the request is refused outright.
      expect(response.status).toBe(403);

      const only = await fetch(`${base}/files/download-archive?paths=${q(path.join(ws, "project"))}`);
      expect(only.status).toBe(200);
      const out = path.join(ws, "..", `out-${Date.now()}.tgz`);
      fs.writeFileSync(out, Buffer.from(await only.arrayBuffer()));
      const names: string[] = [];
      await tar.t({ file: out, onReadEntry: (entry) => names.push(entry.path) });
      fs.rmSync(out);
      expect(names).toEqual(expect.arrayContaining(["project/app.ts"]));
      expect(names.some((n) => n.endsWith(".env") || n.endsWith(".pem"))).toBe(false);

      // Archiving the workspace root skips data/ and credential files but keeps the rest.
      const rootArchive = await fetch(`${base}/files/download-archive?paths=${q(ws)}`);
      expect(rootArchive.status).toBe(200);
      const rootOut = path.join(os.tmpdir(), `root-${Date.now()}.tgz`);
      fs.writeFileSync(rootOut, Buffer.from(await rootArchive.arrayBuffer()));
      const rootNames: string[] = [];
      await tar.t({ file: rootOut, onReadEntry: (entry) => rootNames.push(entry.path) });
      fs.rmSync(rootOut);
      expect(rootNames.some((n) => n.includes("secret-vault") || n.includes("data/notes"))).toBe(false);
      expect(rootNames.some((n) => n.endsWith("app.ts"))).toBe(true);
    });
  });

  it("lets an operator opt in to credential-named files, but never the protected data directory", async () => {
    await withServer({ allowSensitive: () => true }, async (base, ws) => {
      const env = await fetch(`${base}/files/read?path=${q(path.join(ws, "project", ".env"))}`);
      expect(env.status).toBe(200);
      const vault = await fetch(`${base}/files/read?path=${q(path.join(ws, "data", "secret-vault.json"))}`);
      expect(vault.status).toBe(403);
    });
  });
});
