import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizeRuntimePaths } from "../paths.js";
import { SystemIndexer } from "./indexer.js";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-system-index-"));
}

describe("SystemIndexer", () => {
  test("indexes filenames and text content while skipping sensitive files", async () => {
    const workspace = makeWorkspace();
    const root = path.join(workspace, "root");
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "notes", "alpha.txt"),
      "alpha project launch notes",
      "utf-8",
    );
    fs.writeFileSync(path.join(root, ".env"), "API_KEY=secret-value", "utf-8");

    const indexer = new SystemIndexer(
      normalizeRuntimePaths(workspace),
      path.join(workspace, "data", "test-index.db"),
    );
    try {
      await indexer.rebuild(
        {
          roots: [root],
          realtime: false,
          includeSystemRoots: false,
        },
        { wait: true },
      );

      expect(indexer.status().stats.indexedFiles).toBe(1);
      expect(indexer.search("alpha", 10)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "alpha.txt",
            contentIndexed: true,
          }),
        ]),
      );
      expect(indexer.search("API_KEY", 10)).toHaveLength(0);
    } finally {
      indexer.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("updates and removes individual paths", async () => {
    const workspace = makeWorkspace();
    const root = path.join(workspace, "root");
    const filePath = path.join(root, "delta.md");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filePath, "delta first content", "utf-8");

    const indexer = new SystemIndexer(
      normalizeRuntimePaths(workspace),
      path.join(workspace, "data", "test-index.db"),
      { startWatchers: false },
    );
    try {
      await indexer.rebuild(
        { roots: [root], realtime: false, includeSystemRoots: false },
        { wait: true },
      );
      expect(indexer.search("first", 10)).toHaveLength(1);

      fs.writeFileSync(filePath, "delta second content", "utf-8");
      await indexer.indexPath(filePath);
      expect(indexer.search("second", 10)).toHaveLength(1);

      fs.rmSync(filePath);
      await indexer.indexPath(filePath);
      expect(indexer.search("second", 10)).toHaveLength(0);
    } finally {
      indexer.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects manual path indexing outside configured roots", async () => {
    const workspace = makeWorkspace();
    const root = path.join(workspace, "root");
    const outsideRoot = path.join(workspace, "outside");
    const outsideFile = path.join(outsideRoot, "secret-note.txt");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.writeFileSync(outsideFile, "outside-root-token", "utf-8");

    const indexer = new SystemIndexer(
      normalizeRuntimePaths(workspace),
      path.join(workspace, "data", "test-index.db"),
      { startWatchers: false },
    );
    try {
      await indexer.rebuild(
        { roots: [root], realtime: false, includeSystemRoots: false },
        { wait: true },
      );
      await indexer.indexPath(outsideFile);

      expect(indexer.search("outside-root-token", 10)).toHaveLength(0);
      expect(indexer.status().lastErrors[0]).toContain(
        "outside configured index roots",
      );
      expect((await indexer.stop()).state).toBe("idle");
    } finally {
      indexer.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
