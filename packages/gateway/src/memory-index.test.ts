import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { FileMemoryService } from "@miki/core/memory-files";
import { SqliteMemoryIndex } from "./memory-index.js";

function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "miki-sqlite-memory-"));
}

const keywordProvider = {
  name: "hash-offline",
  async embed() {
    throw new Error("hash provider must not be treated as semantic");
  },
};

describe("SqliteMemoryIndex", () => {
  let root = "";
  let db: Database.Database;
  let memory: FileMemoryService;
  let index: SqliteMemoryIndex;

  beforeEach(async () => {
    root = await tempRoot();
    db = new Database(":memory:");
    memory = new FileMemoryService({ identityDir: root });
    index = new SqliteMemoryIndex(db, memory, keywordProvider);
  });

  afterEach(() => {
    memory?.shutdown();
    db?.close();
    if (root) return fs.rm(root, { recursive: true, force: true });
  });

  it("indexes Markdown into durable SQLite chunks and finds exact terms", async () => {
    await memory.note("The workspace codename is Copper Finch and issue MIKI-482.", "long_term");
    const hits = await index.search("MIKI-482", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe("MEMORY.md");
    expect(hits[0]?.snippet).toContain("Copper Finch");
    expect(index.status()).toMatchObject({ mode: "fts_only", chunks: expect.any(Number) });
    expect((index.status().chunks as number)).toBeGreaterThan(0);
  });

  it("reindexes edits and removes stale chunks after a file is deleted", async () => {
    await memory.note("Old Orchid memo", "long_term");
    expect((await index.search("Orchid", 5)).length).toBeGreaterThan(0);
    await fs.writeFile(memory.memoryPaths().memoryMd, "# MEMORY.md\n\nNew Cobalt memo\n", "utf8");
    expect((await index.search("Orchid", 5)).length).toBe(0);
    expect((await index.search("Cobalt", 5)).length).toBeGreaterThan(0);
    await fs.rm(memory.memoryPaths().memoryMd, { force: true });
    expect((await index.search("Cobalt", 5)).length).toBe(0);
  });

  it("does not trust pre-existing files, but permits explicit memory-note writes in bootstrap", async () => {
    await fs.writeFile(memory.memoryPaths().memoryMd, "# Existing\n\nUnreviewed legacy note\n", "utf8");
    expect(await index.bootstrapTrust()).toEqual({ user: false, memory: false });
    memory.setWriteObserver((relPath, provenance) => index.markProvenance(relPath, provenance));
    await memory.note("Owner-confirmed durable preference", "user");
    expect(await index.bootstrapTrust()).toEqual({ user: true, memory: false });
    await memory.note("Curated decision for the project", "long_term");
    expect(await index.bootstrapTrust()).toEqual({ user: true, memory: true });
  });

  it("marks the exact previous stable preference superseded instead of retaining it as active", async () => {
    await memory.note("Prefers concise replies", "user");
    await memory.note("Prefers detailed, step-by-step replies", "user", "Prefers concise replies");
    const text = await memory.store.readUserMd();
    expect(text).toContain("status: superseded] Prefers concise replies");
    expect(text).toContain("status: active] Prefers detailed, step-by-step replies");
  });

  it("imports legacy SQLite memory as untrusted searchable Markdown without deleting source rows", async () => {
    db.exec("CREATE TABLE memory_chunks(id TEXT PRIMARY KEY,region TEXT,content TEXT,summary TEXT,provenance TEXT,confidence REAL,importance REAL,created_at TEXT,updated_at TEXT)");
    db.prepare("INSERT INTO memory_chunks VALUES(?,?,?,?,?,?,?,?,?)").run("legacy-1", "long_term", "A legacy deploy uses violet switchboard", "violet switchboard", "unknown", 0.5, 0.2, "2026-10-01", "2026-10-02");
    const count = await index.importLegacyChunks();
    expect(count).toBe(1);
    const hits = await index.search("violet switchboard", 5);
    expect(hits.some((hit) => hit.path.startsWith("memory/legacy-import/"))).toBe(true);
    expect(hits.some((hit) => hit.snippet.includes("provenance: untrusted"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get()).toEqual({ n: 1 });
    expect(await index.importLegacyChunks()).toBe(0);
  });

  it("uses an explicitly configured semantic provider and stores vectors", async () => {
    const semantic = {
      name: "openai-compatible",
      async embed(text: string) {
        return text.toLowerCase().includes("nebula") ? [1, 0] : [0, 1];
      },
    };
    const semanticIndex = new SqliteMemoryIndex(db, memory, semantic);
    await memory.note("A nebula is the project mascot.", "long_term");
    const hits = await semanticIndex.search("galaxy cloud", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(semanticIndex.status()).toMatchObject({ mode: "hybrid", vectors: expect.any(Number) });
    expect(semanticIndex.status().vectors as number).toBeGreaterThan(0);
  });

  it("indexes missing vectors with bounded concurrency instead of sequential network calls", async () => {
    let active = 0;
    let maxActive = 0;
    const semantic = {
      name: "openai-compatible",
      async embed() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return [1, 0];
      },
    };
    const semanticIndex = new SqliteMemoryIndex(db, memory, semantic);
    const markdown = Array.from({ length: 1_800 }, (_, index) => `memorytoken${index}`).join(" ");
    await fs.writeFile(memory.memoryPaths().memoryMd, `# MEMORY.md\n\n${markdown}\n`, "utf8");

    await semanticIndex.reindex();

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(semanticIndex.status().vectors as number).toBeGreaterThan(1);
  });

  it("falls back to FTS search when the configured semantic provider is unavailable", async () => {
    const unavailable = {
      name: "openai-compatible",
      async embed() { throw new Error("temporary provider timeout"); },
    };
    const degradedIndex = new SqliteMemoryIndex(db, memory, unavailable);
    await memory.note("Quartz lantern is the recovery keyword.", "long_term");
    const hits = await degradedIndex.search("quartz lantern", 5);
    expect(hits.some((hit) => hit.snippet.includes("Quartz lantern"))).toBe(true);
    expect(degradedIndex.status().lastEmbeddingError).toContain("temporary provider timeout");
  });
});
