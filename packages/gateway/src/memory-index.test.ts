import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
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
    memory.setWriteObserver((relPath, provenance, hadExistingContent) => index.markProvenance(relPath, provenance, hadExistingContent));
  });

  afterEach(() => {
    memory?.shutdown();
    db?.close();
    if (root) return fs.rm(root, { recursive: true, force: true });
  });

  it("rejects oversized search queries and invalid result limits instead of silently coercing them", async () => {
    await expect(index.search("x".repeat(2_001), 5)).rejects.toThrow("2000 characters");
    await expect(index.search("valid query", 0)).rejects.toThrow("between 1 and 20");
    await expect(index.search("valid query", 21)).rejects.toThrow("between 1 and 20");
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

  it("demotes a trusted daily file when untrusted content is appended", async () => {
    await memory.note("Owner-approved daily detail", "daily", undefined, "owner");
    expect((await index.search("Owner-approved daily detail", 5)).length).toBeGreaterThan(0);

    await memory.note("Untrusted imported daily text", "daily", undefined, "untrusted");
    expect(await index.search("Owner-approved daily detail", 5)).toEqual([]);
    expect((await index.trustedPaths()).some((memoryPath) => memoryPath.startsWith("memory/"))).toBe(false);
  });

  it("does not promote earlier untrusted daily content when an owner appends later", async () => {
    await memory.note("External imported fact must remain untrusted", "daily", undefined, "untrusted");
    await memory.note("Owner approved a separate daily detail", "daily", undefined, "owner");

    expect(await index.search("External imported fact", 5)).toEqual([]);
    expect(await index.search("Owner approved separate daily", 5)).toEqual([]);
    expect((await index.trustedPaths()).some((memoryPath) => memoryPath.startsWith("memory/"))).toBe(false);
  });

  it("keeps owner appends to a pre-existing unknown daily file untrusted", async () => {
    const op = memory.store.planDailyNote("Pre-existing external text", "import");
    await fs.mkdir(path.dirname(op.path), { recursive: true });
    await fs.writeFile(op.path, "# Imported file\n\nUnreviewed content from outside Miki.\n", "utf8");

    await memory.note("Owner-added note must not bless imported content", "daily", undefined, "owner");
    expect(await index.search("Unreviewed content outside", 5)).toEqual([]);
    expect(await index.search("Owner added note", 5)).toEqual([]);
    expect((await index.trustedPaths()).some((memoryPath) => memoryPath.startsWith("memory/"))).toBe(false);
  });

  it("trusts a newly created owner-only daily file", async () => {
    await memory.note("Owner-created daily memory record", "daily", undefined, "owner");
    expect((await index.search("Owner-created daily memory", 5)).length).toBeGreaterThan(0);
    expect((await index.trustedPaths()).some((memoryPath) => memoryPath.startsWith("memory/"))).toBe(true);
  });

  it("revalidates memory_get provenance against current file bytes", async () => {
    await memory.note("Stable owner-approved preference", "user");
    const original = await index.readTrustedFile("USER.md");
    expect(original.text).toContain("Stable owner-approved preference");

    const target = memory.memoryPaths().userMd;
    const stat = await fs.stat(target);
    const injected = "# USER.md\n\nExternal content was inserted.\n".padEnd(original.text.length, " ");
    await fs.writeFile(target, injected, "utf8");
    await fs.utimes(target, stat.atime, stat.mtime);

    const denied = await index.readTrustedFile("USER.md");
    expect(denied.text).toBe("");
    expect(denied.error).toContain("not trusted");
    expect(await index.trustedPaths()).not.toContain("USER.md");
  });

  it("revokes bootstrap trust when bytes change without mtime or size changing", async () => {
    await memory.note("Owner-approved bootstrap preference", "long_term", undefined, "owner");
    expect(await index.bootstrapTrust()).toMatchObject({ memory: true });

    const target = memory.memoryPaths().memoryMd;
    const before = await fs.stat(target);
    const original = await fs.readFile(target, "utf8");
    const replacement = original.replace("Owner-approved bootstrap preference", "External imported memory").padEnd(original.length, " ");
    expect(replacement).toHaveLength(original.length);
    await fs.writeFile(target, replacement, "utf8");
    await fs.utimes(target, before.atime, before.mtime);

    expect(await index.bootstrapTrust()).toMatchObject({ memory: false });
    expect(await index.search("Imported untrusted bootstrap content", 5)).toEqual([]);
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

  it("does not promote pre-existing unknown files when an owner note is appended", async () => {
    await fs.writeFile(memory.memoryPaths().memoryMd, "# Existing\n\nUnreviewed legacy note\n", "utf8");
    expect(await index.bootstrapTrust()).toEqual({ user: false, memory: false });
    memory.setWriteObserver((relPath, provenance, hadExistingContent) => index.markProvenance(relPath, provenance, hadExistingContent));
    await memory.note("Owner-confirmed durable preference", "user");
    expect(await index.bootstrapTrust()).toEqual({ user: true, memory: false });
    await memory.note("Curated decision for the project", "long_term", undefined, "owner");
    expect(await index.bootstrapTrust()).toEqual({ user: true, memory: false });
  });

  it("avoids rescanning daily memory files when trust-bearing files are unchanged", async () => {
    memory.setWriteObserver((relPath, provenance, hadExistingContent) => index.markProvenance(relPath, provenance, hadExistingContent));
    await memory.note("Owner-confirmed fast response preference", "user");
    expect(await index.bootstrapTrust()).toEqual({ user: true, memory: false });

    const fullListing = jest.spyOn(memory.store, "listFiles");
    expect(await index.bootstrapTrust()).toEqual({ user: true, memory: false });
    expect(fullListing).not.toHaveBeenCalled();

    await memory.note("Durable context speed preference", "long_term");
    expect(await index.bootstrapTrust()).toEqual({ user: true, memory: true });
    expect(fullListing).toHaveBeenCalledTimes(1);

    await fs.rm(memory.memoryPaths().memoryMd, { force: true });
    expect(await index.bootstrapTrust()).toEqual({ user: true, memory: false });
  });

  it("marks the exact previous stable preference superseded instead of retaining it as active", async () => {
    await memory.note("Prefers concise replies", "user");
    await memory.note("Prefers detailed, step-by-step replies", "user", "Prefers concise replies");
    const text = await memory.store.readUserMd();
    expect(text).toContain("status: superseded] Prefers concise replies");
    expect(text).toContain("status: active] Prefers detailed, step-by-step replies");
  });

  it("preserves legacy SQLite rows as untrusted audit-only Markdown", async () => {
    db.exec("CREATE TABLE memory_chunks(id TEXT PRIMARY KEY,region TEXT,content TEXT,summary TEXT,provenance TEXT,confidence REAL,importance REAL,created_at TEXT,updated_at TEXT)");
    db.prepare("INSERT INTO memory_chunks VALUES(?,?,?,?,?,?,?,?,?)").run("legacy-1", "long_term", "A legacy deploy uses violet switchboard", "violet switchboard", "unknown", 0.5, 0.2, "2026-10-01", "2026-10-02");
    const count = await index.importLegacyChunks();
    expect(count).toBe(1);
    const hits = await index.search("violet switchboard", 5);
    expect(hits.some((hit) => hit.path.startsWith("memory/legacy-import/"))).toBe(false);
    const importedPath = path.join(root, "memory", "legacy-import", `${createHash("sha256").update("legacy-1").digest("hex").slice(0, 32)}.md`);
    const importedText = await fs.readFile(importedPath, "utf8");
    expect(importedText).toContain("provenance: untrusted");
    expect(importedText).toContain("violet switchboard");
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get()).toEqual({ n: 1 });
    expect(await index.importLegacyChunks()).toBe(0);
  });

  it("keeps legacy deletions tombstoned across future imports and reindexing", async () => {
    db.exec("CREATE TABLE memory_chunks(id TEXT PRIMARY KEY,region TEXT,content TEXT,summary TEXT,provenance TEXT,confidence REAL,importance REAL,created_at TEXT,updated_at TEXT)");
    db.prepare("INSERT INTO memory_chunks VALUES(?,?,?,?,?,?,?,?,?)").run("legacy-delete", "long_term", "A deleted amber archive must stay deleted", "amber archive", "owner", 0.9, 0.8, "2026-10-01", "2026-10-02");
    expect(await index.importLegacyChunks()).toBe(1);
    const importedPath = path.join(root, "memory", "legacy-import", `${createHash("sha256").update("legacy-delete").digest("hex").slice(0, 32)}.md`);
    expect(await fs.access(importedPath).then(() => true, () => false)).toBe(true);

    expect(await index.forgetLegacyChunk("legacy-delete")).toBe(true);
    expect(await index.forgetLegacyChunk("legacy-delete")).toBe(false);
    expect(await fs.access(importedPath).then(() => true, () => false)).toBe(false);
    expect(await index.importLegacyChunks()).toBe(0);
    expect(await index.search("amber archive", 5)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_file_deletions WHERE legacy_id=?").get("legacy-delete")).toEqual({ n: 1 });
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
