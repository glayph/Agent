import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveMemoryPaths, isMemoryFile } from "./paths.js";
import { MemoryFileStore, executeOp } from "./store.js";
import { MemorySearchIndex, readMemoryRange, tokenize } from "./search.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-memsearch-"));
}

describe("tokenize", () => {
  it("tokenizes both Latin and Bengali text", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
    expect(tokenize("আমার নাম মিকি")).toEqual(["আমার", "নাম", "মিকি"]);
  });
});

describe("MemorySearchIndex", () => {
  let root: string;
  let store: MemoryFileStore;
  let index: MemorySearchIndex;

  beforeEach(async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    index = new MemorySearchIndex(store);
    await executeOp(store.planLongTermNote("The user's favourite editor is Neovim with LazyVim."));
    await executeOp(
      store.planDailyNote("Deployed the pixel-water-engine renderer fix to staging.", "agent"),
    );
    await executeOp(
      store.planDailyNote("সিদ্ধান্ত হয়েছে: মেমরি সিস্টেম ফাইল-ভিত্তিক হবে।", "agent"),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds a note by keyword and returns a line range + snippet", async () => {
    const hits = await index.search("Neovim editor");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe("MEMORY.md");
    expect(hits[0]!.snippet).toMatch(/Neovim/);
    expect(hits[0]!.startLine).toBeGreaterThanOrEqual(1);
  });

  it("finds Bengali-language notes", async () => {
    const hits = await index.search("মেমরি সিস্টেম");
    expect(hits.some((h) => h.snippet.includes("মেমরি সিস্টেম"))).toBe(true);
  });

  it("ranks MEMORY.md slightly higher on an equal-strength match (boost)", async () => {
    await executeOp(store.planLongTermNote("Uses a hydroponic tomato setup on the balcony."));
    await executeOp(
      store.planDailyNote("Uses a hydroponic tomato setup on the balcony.", "agent"),
    );
    const hits = await index.search("hydroponic tomato setup");
    expect(hits[0]!.path).toBe("MEMORY.md");
  });

  it("returns nothing for a query with no matches", async () => {
    const hits = await index.search("completely unrelated quantum toaster");
    expect(hits).toEqual([]);
  });

  it("picks up a newly written file without re-instantiation (mtime-based refresh)", async () => {
    await executeOp(store.planLongTermNote("Owns a mechanical keyboard with brown switches."));
    const hits = await index.search("mechanical keyboard");
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("readMemoryRange / isMemoryFile", () => {
  let root: string;
  let store: MemoryFileStore;

  beforeEach(async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planLongTermNote("line one fact"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads MEMORY.md in full when no range is given", async () => {
    const r = await readMemoryRange(resolveMemoryPaths(root), "MEMORY.md");
    expect(r.text).toContain("line one fact");
    expect(r.error).toBeUndefined();
  });

  it("returns empty text (not an error) for a memory file that does not exist yet", async () => {
    const r = await readMemoryRange(resolveMemoryPaths(root), "memory/2099-01-01.md");
    expect(r.text).toBe("");
    expect(r.error).toBeUndefined();
  });

  it("refuses to read a file outside the memory root", async () => {
    const outside = path.join(root, "..", "secrets.txt");
    const r = await readMemoryRange(resolveMemoryPaths(root), outside);
    expect(r.error).toMatch(/memory_get only reads/);
  });

  it("refuses a path-traversal attempt", async () => {
    const r = await readMemoryRange(resolveMemoryPaths(root), "../../etc/passwd");
    expect(r.error).toBeDefined();
  });

  it("isMemoryFile accepts MEMORY.md and memory/**.md, rejects everything else", () => {
    const paths = resolveMemoryPaths(root);
    expect(isMemoryFile(paths, paths.memoryMd)).toBe(true);
    expect(isMemoryFile(paths, path.join(paths.dailyDir, "2026-09-29.md"))).toBe(true);
    expect(isMemoryFile(paths, path.join(root, "SOUL.md"))).toBe(false);
    expect(isMemoryFile(paths, path.join(root, "..", "outside.md"))).toBe(false);
  });
});
