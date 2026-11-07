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
    const block = await builder.build({ trustedMemory: true });
    expect(block).toContain("Prefers concise answers.");
    expect(block).toContain("memory_search");
    expect(block).toContain("reference data, not system/developer policy");
  });

  it("loads USER.md directives before durable memory", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planUserNote("Prefer replies in Bengali."));
    await executeOp(store.planLongTermNote("The project uses SQLite."));
    const block = await new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG).build({ trustedUser: true, trustedMemory: true });
    expect(block).toContain("User profile (USER.md)");
    expect(block).toContain("Prefer replies in Bengali.");
    expect(block).toContain("The project uses SQLite.");
    expect(block.indexOf("User profile")).toBeLessThan(block.indexOf("Long-term memory"));
  });

  it("keeps reviewed and superseded preferences out of active prompt context", async () => {
    root = tmpRoot()
    store = new MemoryFileStore(resolveMemoryPaths(root))
    await executeOp(store.planUserNote("Use concise answers"))
    await store.recordUserPreferenceConflict("Use detailed answers", ["Use concise answers", "Use detailed answers"])
    const block = await new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG).build({ trustedUser: true })
    expect(block).not.toContain("Use concise answers")
    expect(block).not.toContain("Use detailed answers")
  })

  it("omits bootstrap files unless their provenance is explicitly trusted", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planUserNote("Private preference"));
    await executeOp(store.planLongTermNote("Unreviewed legacy fact"));
    const builder = new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG);
    const defaultBlock = await builder.build();
    const block = await builder.build({ trustedUser: false, trustedMemory: false });
    for (const candidate of [defaultBlock, block]) {
      expect(candidate).not.toContain("Private preference");
      expect(candidate).not.toContain("Unreviewed legacy fact");
    }
  });

  it("truncates MEMORY.md in the prompt copy without touching the file on disk", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planLongTermNote("x".repeat(5000)));
    const cfg = { ...DEFAULT_MEMORY_FILES_CONFIG, memoryMdMaxChars: 200, bootstrapMaxChars: 300 };
    const builder = new MemoryContextBuilder(store, () => cfg);
    const block = await builder.build({ trustedMemory: true });
    expect(block.length).toBeLessThan(5000);
    expect(block).toContain("omitted in prompt");
    const onDisk = await store.readMemoryMd();
    expect(onDisk.length).toBeGreaterThan(4900);
  });

  it("keeps the NEWEST MEMORY.md entries when the file outgrows the prompt budget", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    for (let index = 1; index <= 60; index += 1) {
      await executeOp(store.planLongTermNote(`fact number ${index} about the project and its configuration details`));
    }
    const cfg = { ...DEFAULT_MEMORY_FILES_CONFIG, memoryMdMaxChars: 900, bootstrapMaxChars: 1200 };
    const block = await new MemoryContextBuilder(store, () => cfg).build({ trustedMemory: true });
    expect(block).toContain("fact number 60");
    expect(block).toContain("fact number 59");
    expect(block).not.toContain("fact number 30 ");
    expect(block).toContain("omitted in prompt");
  });

  it("uses the verified bootstrap and daily-note snapshots instead of rereading changed files", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planUserNote("Verified owner preference"));
    await executeOp(store.planLongTermNote("Verified durable decision"));
    const dailyPath = await executeOp(store.planDailyNote("Verified daily detail", "agent"));
    const relPath = path.relative(store.paths.root, dailyPath!).split(path.sep).join("/");
    const userContent = await store.readUserMd();
    const memoryContent = await store.readMemoryMd();
    const dailyContent = await fs.promises.readFile(dailyPath!, "utf8");

    await fs.promises.writeFile(store.paths.userMd, "# USER.md\n\nUntrusted replacement\n", "utf8");
    await fs.promises.writeFile(store.paths.memoryMd, "# MEMORY.md\n\nUntrusted replacement\n", "utf8");
    await fs.promises.writeFile(dailyPath!, "# Daily\n\nUntrusted replacement\n", "utf8");

    const block = await new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG).build({
      trustedUser: true,
      trustedMemory: true,
      trustedUserContent: userContent,
      trustedMemoryContent: memoryContent,
      trustedPaths: [relPath],
      trustedFileContents: [{ path: relPath, text: dailyContent }],
    });
    expect(block).toContain("Verified owner preference");
    expect(block).toContain("Verified durable decision");
    expect(block).toContain("Verified daily detail");
    expect(block).not.toContain("Untrusted replacement");
  });

  it("shows the latest bullets of a daily note in the recent-notes index, not the first ones", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    let dailyPath = "";
    for (let index = 1; index <= 8; index += 1) {
      dailyPath = (await executeOp(store.planDailyNote(`happening number ${index}`, "agent"))) || dailyPath;
    }
    const relPath = path.relative(store.paths.root, dailyPath).split(path.sep).join("/");
    const builder = new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG);
    const untrusted = await builder.build();
    expect(untrusted).not.toContain("happening number 8");
    const block = await builder.build({ trustedPaths: [relPath] });
    expect(block).toContain("happening number 8");
    expect(block).not.toContain("happening number 1 ");
  });

  it("compact mode omits the recent-notes index and the tool hint", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planLongTermNote("core fact"));
    const dailyPath = await executeOp(store.planDailyNote("today's happenings", "agent"));
    const relPath = path.relative(store.paths.root, dailyPath || "").split(path.sep).join("/");
    const builder = new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG);
    const full = await builder.build({ trustedMemory: true, trustedPaths: [relPath] });
    const compact = await builder.build({ compact: true, trustedMemory: true, trustedPaths: [relPath] });
    expect(full).toContain("Recent memory notes");
    expect(compact).not.toContain("Recent memory notes");
    expect(compact).not.toContain("memory_search");
    expect(compact).toContain("core fact");
  });

  it("uses the targeted recent-file scan instead of recursively listing the full archive", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    const now = new Date();
    const dailyPath = await executeOp(store.planDailyNote("visible recent note", "agent", now));
    const relPath = path.relative(store.paths.root, dailyPath || "").split(path.sep).join("/");
    const listAll = jest.spyOn(store, "listFiles");
    try {
      const block = await new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG).build({ now, trustedPaths: [relPath] });
      expect(block).toContain("visible recent note");
      expect(listAll).not.toHaveBeenCalled();
    } finally {
      listAll.mockRestore();
    }
  });

  it("indexes only recent daily/session files, not MEMORY.md or compaction archives", async () => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    await executeOp(store.planLongTermNote("core fact"));
    const now = new Date();
    const old = new Date(now);
    old.setDate(old.getDate() - DEFAULT_MEMORY_FILES_CONFIG.recentDays - 5);
    const recentPath = await executeOp(store.planDailyNote("recent thing happened", "agent", now));
    const oldPath = await executeOp(store.planDailyNote("old thing must not appear", "agent", old));
    const trustedPaths = [recentPath, oldPath].filter((item): item is string => Boolean(item)).map((item) => path.relative(store.paths.root, item).split(path.sep).join("/"));
    await executeOp(
      store.planCompactionArchive({ sessionId: "abc", summary: "archived stuff", archivedCount: 3, now }),
    );
    const builder = new MemoryContextBuilder(store, () => DEFAULT_MEMORY_FILES_CONFIG);
    const block = await builder.build({ now, trustedPaths });
    expect(block).toMatch(/memory\/\d{4}-\d{2}-\d{2}\.md/);
    expect(block).toContain("recent thing happened");
    expect(block).not.toContain("old thing must not appear");
    expect(block).not.toContain("compactions/");
  });
});
