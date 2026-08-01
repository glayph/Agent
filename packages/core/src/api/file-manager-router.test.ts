import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as tar from "tar";
import { createFileManagerRouter } from "./file-manager-router.js";
import { normalizeRuntimePaths } from "../paths.js";

jest.setTimeout(15_000);

interface JsonResponse {
  error?: string;
  roots?: Array<{
    path: string;
    kind: string;
    storage?: { totalBytes: number; freeBytes: number; usedBytes: number };
  }>;
  entries?: Array<{ name: string; path: string; type: string }>;
  parentPath?: string | null;
  content?: string;
  modifiedAt?: string;
  entry?: { name: string; path: string; type: string };
  status?: string;
}

async function withFileServer<T>(
  run: (baseUrl: string, workspaceDir: string, filesDir: string) => Promise<T>,
  options: { allowSystemWrite?: boolean | (() => boolean) } = {},
): Promise<T> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-files-"));
  const filesDir = path.join(workspaceDir, "files");
  fs.mkdirSync(filesDir, { recursive: true });

  const app = express();
  app.use(express.json({ limit: "30mb" }));
  app.use(
    "/files",
    createFileManagerRouter({
      runtimePaths: normalizeRuntimePaths(workspaceDir),
      allowSystemWrite: options.allowSystemWrite,
    }),
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind file manager test server");
  }

  try {
    return await run(
      `http://127.0.0.1:${address.port}`,
      workspaceDir,
      filesDir,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

async function jsonFetch(
  baseUrl: string,
  pathName: string,
  init?: RequestInit,
): Promise<{ response: Response; body: JsonResponse }> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers,
  });
  return {
    response,
    body: (await response.json()) as JsonResponse,
  };
}

describe("file manager router", () => {
  it("lists, reads, writes, renames, downloads, and deletes files", async () => {
    await withFileServer(async (baseUrl, workspaceDir, filesDir) => {
      const notePath = path.join(filesDir, "note.txt");
      fs.writeFileSync(notePath, "hello", "utf8");

      const roots = await jsonFetch(baseUrl, "/files/roots");
      expect(roots.response.status).toBe(200);
      expect(roots.body.roots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "workspace",
            path: workspaceDir,
            protected: true,
          }),
          expect.objectContaining({
            path: path.resolve(os.homedir()),
          }),
          expect.objectContaining({
            path: path.resolve(path.parse(workspaceDir).root),
            protected: true,
          }),
        ]),
      );
      expect(roots.body.roots?.length).toBeGreaterThan(1);
      expect(
        roots.body.roots?.some(
          (root) =>
            (root.kind === "drive" || root.kind === "root") &&
            root.storage &&
            root.storage.totalBytes > 0 &&
            root.storage.freeBytes >= 0 &&
            root.storage.usedBytes >= 0,
        ),
      ).toBe(true);

      const workspaceListing = await jsonFetch(
        baseUrl,
        `/files?path=${encodeURIComponent(workspaceDir)}`,
      );
      expect(workspaceListing.response.status).toBe(200);
      expect(workspaceListing.body.parentPath).toBe(path.dirname(workspaceDir));

      const listing = await jsonFetch(
        baseUrl,
        `/files?path=${encodeURIComponent(filesDir)}`,
      );
      expect(listing.response.status).toBe(200);
      expect(listing.body.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "note.txt", type: "file" }),
        ]),
      );

      const read = await jsonFetch(
        baseUrl,
        `/files/read?path=${encodeURIComponent(notePath)}`,
      );
      expect(read.response.status).toBe(200);
      expect(read.body.content).toBe("hello");
      expect(read.body.modifiedAt).toBeTruthy();

      const conflict = await jsonFetch(baseUrl, "/files/write", {
        method: "PUT",
        body: JSON.stringify({
          path: notePath,
          content: "stale",
          expectedModifiedAt: "2000-01-01T00:00:00.000Z",
        }),
      });
      expect(conflict.response.status).toBe(409);

      const write = await jsonFetch(baseUrl, "/files/write", {
        method: "PUT",
        body: JSON.stringify({ path: notePath, content: "updated" }),
      });
      expect(write.response.status).toBe(200);
      expect(fs.readFileSync(notePath, "utf8")).toBe("updated");

      const rename = await jsonFetch(baseUrl, "/files/rename", {
        method: "PATCH",
        body: JSON.stringify({ path: notePath, newName: "renamed.txt" }),
      });
      expect(rename.response.status).toBe(200);
      expect(rename.body.entry?.name).toBe("renamed.txt");

      const renamedPath = path.join(filesDir, "renamed.txt");
      const download = await fetch(
        `${baseUrl}/files/download?path=${encodeURIComponent(renamedPath)}`,
      );
      expect(download.status).toBe(200);
      expect(await download.text()).toBe("updated");

      const imagePath = path.join(filesDir, "pixel.png");
      fs.writeFileSync(
        imagePath,
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00,
          0x0d,
        ]),
      );
      const preview = await fetch(
        `${baseUrl}/files/preview?path=${encodeURIComponent(imagePath)}`,
      );
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toContain("image/png");
      expect(preview.headers.get("content-disposition")).toContain("inline");

      const rangedPreview = await fetch(
        `${baseUrl}/files/preview?path=${encodeURIComponent(imagePath)}`,
        { headers: { Range: "bytes=0-3" } },
      );
      expect(rangedPreview.status).toBe(206);
      expect(rangedPreview.headers.get("content-range")).toBe("bytes 0-3/12");
      expect((await rangedPreview.arrayBuffer()).byteLength).toBe(4);

      const remove = await jsonFetch(baseUrl, "/files", {
        method: "DELETE",
        body: JSON.stringify({ path: renamedPath, recursive: false }),
      });
      expect(remove.response.status).toBe(200);
      expect(fs.existsSync(renamedPath)).toBe(false);
    });
  });

  it("creates folders, uploads files, and rejects unsafe operations", async () => {
    await withFileServer(async (baseUrl, workspaceDir, filesDir) => {
      const createDir = await jsonFetch(baseUrl, "/files/create", {
        method: "POST",
        body: JSON.stringify({
          parentPath: filesDir,
          name: "nested",
          type: "directory",
        }),
      });
      expect(createDir.response.status).toBe(201);
      const nestedDir = path.join(filesDir, "nested");

      const createFile = await jsonFetch(baseUrl, "/files/create", {
        method: "POST",
        body: JSON.stringify({
          parentPath: nestedDir,
          name: "draft.md",
          type: "file",
          content: "# Draft",
        }),
      });
      expect(createFile.response.status).toBe(201);

      const invalidRename = await jsonFetch(baseUrl, "/files/rename", {
        method: "PATCH",
        body: JSON.stringify({
          path: path.join(nestedDir, "draft.md"),
          newName: "bad/name.md",
        }),
      });
      expect(invalidRename.response.status).toBe(400);

      const rootDelete = await jsonFetch(baseUrl, "/files", {
        method: "DELETE",
        body: JSON.stringify({ path: workspaceDir, recursive: true }),
      });
      expect(rootDelete.response.status).toBe(403);

      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside", "utf8");
      try {
        const outsideRead = await jsonFetch(
          baseUrl,
          `/files/read?path=${encodeURIComponent(outsideFile)}`,
        );
        expect(outsideRead.response.status).toBe(200);
        expect(outsideRead.body.content).toBe("outside");

        const outsideWrite = await jsonFetch(baseUrl, "/files/write", {
          method: "PUT",
          body: JSON.stringify({
            path: outsideFile,
            content: "outside updated",
          }),
        });
        expect(outsideWrite.response.status).toBe(403);
        expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside");

        const outsideCreate = await jsonFetch(baseUrl, "/files/create", {
          method: "POST",
          body: JSON.stringify({
            parentPath: outsideDir,
            name: "blocked.txt",
            type: "file",
          }),
        });
        expect(outsideCreate.response.status).toBe(403);
        expect(fs.existsSync(path.join(outsideDir, "blocked.txt"))).toBe(false);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }

      const filesystemRootDelete = await jsonFetch(baseUrl, "/files", {
        method: "DELETE",
        body: JSON.stringify({
          path: path.parse(workspaceDir).root,
          recursive: true,
        }),
      });
      expect(filesystemRootDelete.response.status).toBe(403);

      const binaryPath = path.join(nestedDir, "binary.bin");
      fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));
      const binaryRead = await jsonFetch(
        baseUrl,
        `/files/read?path=${encodeURIComponent(binaryPath)}`,
      );
      expect(binaryRead.response.status).toBe(415);

      const upload = new FormData();
      upload.set("parentPath", nestedDir);
      upload.set("file", new Blob(["uploaded text"]), "upload.txt");
      const uploadResponse = await fetch(`${baseUrl}/files/upload`, {
        method: "POST",
        body: upload,
      });
      expect(uploadResponse.status).toBe(201);
      expect(fs.readFileSync(path.join(nestedDir, "upload.txt"), "utf8")).toBe(
        "uploaded text",
      );

      const nonRecursiveDelete = await jsonFetch(baseUrl, "/files", {
        method: "DELETE",
        body: JSON.stringify({ path: nestedDir, recursive: false }),
      });
      expect(nonRecursiveDelete.response.status).toBe(400);

      const recursiveDelete = await jsonFetch(baseUrl, "/files", {
        method: "DELETE",
        body: JSON.stringify({ path: nestedDir, recursive: true }),
      });
      expect(recursiveDelete.response.status).toBe(200);
      expect(fs.existsSync(nestedDir)).toBe(false);
    });
  });

  it("allows explicit system-wide writes when the file manager override is enabled", async () => {
    await withFileServer(
      async (baseUrl) => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
        const outsideFile = path.join(outsideDir, "outside.txt");
        fs.writeFileSync(outsideFile, "outside", "utf8");
        try {
          const outsideWrite = await jsonFetch(baseUrl, "/files/write", {
            method: "PUT",
            body: JSON.stringify({
              path: outsideFile,
              content: "outside updated",
            }),
          });
          expect(outsideWrite.response.status).toBe(200);
          expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside updated");

          const outsideCreate = await jsonFetch(baseUrl, "/files/create", {
            method: "POST",
            body: JSON.stringify({
              parentPath: outsideDir,
              name: "allowed.txt",
              type: "file",
            }),
          });
          expect(outsideCreate.response.status).toBe(201);
          expect(fs.existsSync(path.join(outsideDir, "allowed.txt"))).toBe(
            true,
          );
        } finally {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        }
      },
      { allowSystemWrite: true },
    );
  });

  it("follows dynamic system-wide write policy changes", async () => {
    let allowSystemWrite = false;

    await withFileServer(
      async (baseUrl, workspaceDir) => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
        const outsideFile = path.join(outsideDir, "outside.txt");
        fs.writeFileSync(outsideFile, "outside", "utf8");
        try {
          const blockedWrite = await jsonFetch(baseUrl, "/files/write", {
            method: "PUT",
            body: JSON.stringify({
              path: outsideFile,
              content: "blocked",
            }),
          });
          expect(blockedWrite.response.status).toBe(403);
          expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside");

          allowSystemWrite = true;

          const allowedWrite = await jsonFetch(baseUrl, "/files/write", {
            method: "PUT",
            body: JSON.stringify({
              path: outsideFile,
              content: "outside updated",
            }),
          });
          expect(allowedWrite.response.status).toBe(200);
          expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside updated");

          const protectedDelete = await jsonFetch(baseUrl, "/files", {
            method: "DELETE",
            body: JSON.stringify({ path: workspaceDir, recursive: true }),
          });
          expect(protectedDelete.response.status).toBe(403);
        } finally {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        }
      },
      { allowSystemWrite: () => allowSystemWrite },
    );
  });

  it("copies and moves files and folders", async () => {
    await withFileServer(async (baseUrl, _workspaceDir, filesDir) => {
      const sourceDir = path.join(filesDir, "source");
      const destinationDir = path.join(filesDir, "destination");
      fs.mkdirSync(sourceDir);
      fs.mkdirSync(destinationDir);
      fs.writeFileSync(path.join(sourceDir, "copy-me.txt"), "copy", "utf8");

      const copyFile = await jsonFetch(baseUrl, "/files/copy", {
        method: "POST",
        body: JSON.stringify({
          paths: [path.join(sourceDir, "copy-me.txt")],
          destinationPath: destinationDir,
        }),
      });
      expect(copyFile.response.status).toBe(201);
      expect(
        fs.readFileSync(path.join(destinationDir, "copy-me.txt"), "utf8"),
      ).toBe("copy");

      fs.mkdirSync(path.join(sourceDir, "folder"));
      fs.writeFileSync(path.join(sourceDir, "folder", "nested.txt"), "nested");
      const copyFolder = await jsonFetch(baseUrl, "/files/copy", {
        method: "POST",
        body: JSON.stringify({
          paths: [path.join(sourceDir, "folder")],
          destinationPath: destinationDir,
        }),
      });
      expect(copyFolder.response.status).toBe(201);
      expect(
        fs.readFileSync(
          path.join(destinationDir, "folder", "nested.txt"),
          "utf8",
        ),
      ).toBe("nested");

      const moveFile = await jsonFetch(baseUrl, "/files/move", {
        method: "POST",
        body: JSON.stringify({
          paths: [path.join(sourceDir, "copy-me.txt")],
          destinationPath: destinationDir,
        }),
      });
      expect(moveFile.response.status).toBe(409);

      const movablePath = path.join(sourceDir, "move-me.txt");
      fs.writeFileSync(movablePath, "move", "utf8");
      const moveUniqueFile = await jsonFetch(baseUrl, "/files/move", {
        method: "POST",
        body: JSON.stringify({
          paths: [movablePath],
          destinationPath: destinationDir,
        }),
      });
      expect(moveUniqueFile.response.status).toBe(200);
      expect(fs.existsSync(movablePath)).toBe(false);
      expect(
        fs.readFileSync(path.join(destinationDir, "move-me.txt"), "utf8"),
      ).toBe("move");
    });
  });

  it("downloads folders and selected items as an archive", async () => {
    await withFileServer(async (baseUrl, _workspaceDir, filesDir) => {
      const folderPath = path.join(filesDir, "folder-download");
      const selectedFolderPath = path.join(filesDir, "selected-folder");
      const selectedFilePath = path.join(filesDir, "selected.txt");
      fs.mkdirSync(path.join(folderPath, "nested"), { recursive: true });
      fs.mkdirSync(selectedFolderPath);
      fs.writeFileSync(
        path.join(folderPath, "nested", "inside.txt"),
        "inside",
        "utf8",
      );
      fs.writeFileSync(
        path.join(selectedFolderPath, "child.txt"),
        "child",
        "utf8",
      );
      fs.writeFileSync(selectedFilePath, "selected", "utf8");

      const folderDownload = await fetch(
        `${baseUrl}/files/download-archive?paths=${encodeURIComponent(folderPath)}`,
      );
      expect(folderDownload.status).toBe(200);
      expect(folderDownload.headers.get("content-disposition")).toContain(
        "folder-download.tar.gz",
      );

      const folderArchive = path.join(filesDir, "folder-download.tar.gz");
      const folderExtractDir = path.join(filesDir, "folder-extract");
      fs.writeFileSync(
        folderArchive,
        Buffer.from(await folderDownload.arrayBuffer()),
      );
      fs.mkdirSync(folderExtractDir);
      await tar.x({ file: folderArchive, cwd: folderExtractDir });
      expect(
        fs.readFileSync(
          path.join(
            folderExtractDir,
            "folder-download",
            "nested",
            "inside.txt",
          ),
          "utf8",
        ),
      ).toBe("inside");

      const params = new URLSearchParams();
      params.append("paths", selectedFolderPath);
      params.append("paths", selectedFilePath);
      const selectedDownload = await fetch(
        `${baseUrl}/files/download-archive?${params.toString()}`,
      );
      expect(selectedDownload.status).toBe(200);

      const selectedArchive = path.join(filesDir, "selection.tar.gz");
      const selectedExtractDir = path.join(filesDir, "selected-extract");
      fs.writeFileSync(
        selectedArchive,
        Buffer.from(await selectedDownload.arrayBuffer()),
      );
      fs.mkdirSync(selectedExtractDir);
      await tar.x({ file: selectedArchive, cwd: selectedExtractDir });
      expect(
        fs.readFileSync(
          path.join(selectedExtractDir, "selected-folder", "child.txt"),
          "utf8",
        ),
      ).toBe("child");
      expect(
        fs.readFileSync(path.join(selectedExtractDir, "selected.txt"), "utf8"),
      ).toBe("selected");
    });
  });

  it("rejects copying a folder that contains a symlink descendant", async () => {
    await withFileServer(async (baseUrl, _workspaceDir, filesDir) => {
      const sourceDir = path.join(filesDir, "link-source");
      const nestedDir = path.join(sourceDir, "nested");
      const destinationDir = path.join(filesDir, "link-destination");
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "outside-link-"),
      );
      fs.writeFileSync(path.join(outsideDir, "outside.txt"), "outside", "utf8");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.mkdirSync(destinationDir);
      try {
        const linkPath = path.join(nestedDir, "escape-link");
        // Create a link descendant inside the selected source tree that points
        // outside of it. fsp.cp({ recursive: true }) would otherwise follow it
        // and copy external content into the workspace. Use a Windows junction
        // (no elevation needed) on win32, and a POSIX symlink elsewhere.
        if (process.platform === "win32") {
          fs.symlinkSync(outsideDir, linkPath, "junction");
        } else {
          fs.symlinkSync(outsideDir, linkPath);
        }

        const copyWithLink = await jsonFetch(baseUrl, "/files/copy", {
          method: "POST",
          body: JSON.stringify({
            paths: [sourceDir],
            destinationPath: destinationDir,
          }),
        });
        // The copy should be rejected — either 400 (preflight caught the
        // symlink/junction) or 500 (unhandled error in the walk).
        expect(copyWithLink.response.status).toBeGreaterThanOrEqual(400);
        expect(copyWithLink.response.status).toBeLessThan(600);
        // The external file must not have been copied into the destination.
        expect(
          fs.existsSync(
            path.join(destinationDir, "link-source", "nested", "escape-link"),
          ),
        ).toBe(false);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });
});
