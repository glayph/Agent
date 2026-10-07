import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveMemoryPaths } from "./paths.js";
import { MemoryFileStore, executeOp } from "./store.js";
import { MemoryContextBuilder } from "./context.js";
import { DEFAULT_MEMORY_FILES_CONFIG } from "./config.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-memctx-"));
}

describe("MemoryContextBuilder", () => {
  let root: string;
  let store: MemoryFileStore;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty string when memory is disabled", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planLongTermNote("some fact"));
    const builder = new MemoryContextBuilder(store, () => ({
      ...DEFAULT_MEMORY_FILES_CONFIG,
      enabled: false,
    }));
    expect(await builder.build()).toBe("");
  });

  it("returns an empty string with no memory files yet", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    const builder = new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG);
    expect(await builder.build()).toBe("");
  });

  it("includes MEMORY.md content and a tool hint", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planLongTermNote("Prefers concise answers."));
    const builder = new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG);
    const block = await builder.build();
    expect(block).toContain("Prefers concise answers.");
    expect(block).toContain("memory_search");
  });

  it("loads USER.md directives before durable memory", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planUserNote("Prefer replies in Bengali."));
    await executeOp(store.planLongTermNote("The project uses SQLite."));
    const block = await new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG).build();
    expect(block).toContain("User profile (USER.md)");
    expect(block).toContain("Prefer replies in Bengali.");
    expect(block).toContain("The project uses SQLite.");
    expect(block.indexOf("User profile")).toBeLessThan(block.indexOf("Long-term memory"));
  });

  it("omits bootstrap files when their provenance is not trusted", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planUserNote("Private preference"));
    await executeOp(store.planLongTermNote("Unreviewed legacy fact"));
    const block = await new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG).build({
      trustedUser: false,
      trustedMemory: false,
    });
    expect(block).not.toContain("Private preference");
    expect(block).not.toContain("Unreviewed legacy fact");
  });

  it("truncates MEMORY.md in the prompt copy without touching the file on disk", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planLongTermNote("x".repeat(5000)));
    const cfg = { ...DEFAULT_MEMORY_FILES_CONFIG, memoryMdMaxChars: 200, bootstrapMaxChars: 300 };
    const builder = new MemoryContextBuilder(store, () => cfg);
    const block = await builder.build();
    expect(block.length).toBeLessThan(5000);
    expect(block).toContain("truncated in prompt");
    const onDisk = await store.readMemoryMd();
    expect(onDisk.length).toBeGreaterThan(4900);
  });

  it("compact mode omits the recent-notes index and the tool hint", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planLongTermNote("core fact"));
    await executeOp(store.planDailyNote("today's happenings", "agent"));
    const builder = new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG);
    const full = await builder.build();
    const compact = await builder.build({ compact: true });
    expect(full).toContain("Recent memory notes");
    expect(compact).not.toContain("Recent memory notes");
    expect(compact).not.toContain("memory_search");
    expect(compact).toContain("core fact");
  });

  it("indexes only recent daily/session files, not MEMORY.md or compaction archives", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planLongTermNote("core fact"));
    const now = new Date();
    await executeOp(store.planDailyNote("recent thing happened", "agent", now));
    await executeOp(
      store.planCompactionArchive({ sessionId: "abc", summary: "archived stuff", archivedCount: 3, now }),
    );
    const builder = new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG);
    const block = await builder.build();
    expect(block).toMatch(/memory\/\d{4}-\d{2}-\d{2}\.md/);
    expect(block).not.toContain("compactions/");
  });
});
