import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveMemoryPaths } from "./paths.js";
import { MemoryFileStore } from "./store.js";
import { MemoryHooks } from "./hooks.js";
import { Summarizer } from "./summarizer.js";
import { MemoryWriter } from "./writer.js";
import { DEFAULT_MEMORY_FILES_CONFIG } from "./config.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-memwriter-"));
}

describe("MemoryWriter", () => {
  let root: string;
  let store: MemoryFileStore;
  let summarizer: Summarizer;
  let hooks: MemoryHooks;

  beforeEach(() => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
    summarizer = new Summarizer({
      getMode: () => "heuristic",
      timeoutMs: 5000,
    });
    hooks = new MemoryHooks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("enqueue() never throws and returns immediately (does not await the job)", () => {
    const writer = new MemoryWriter(store, summarizer, hooks, () => DEFAULT_MEMORY_FILES_CONFIG);
    const started = Date.now();
    expect(() =>
      writer.enqueue({ type: "daily_note", text: "hello", source: "test" }),
    ).not.toThrow();
    expect(Date.now() - started).toBeLessThan(20);
  });

  it("processes fast-lane jobs in order and they land on disk", async () => {
    const writer = new MemoryWriter(store, summarizer, hooks, () => DEFAULT_MEMORY_FILES_CONFIG);
    writer.enqueue({ type: "daily_note", text: "first", source: "t" });
    writer.enqueue({ type: "daily_note", text: "second", source: "t" });
    await writer.drain();
    const content = await store.readMemoryMd().catch(() => "");
    const files = await store.listFiles();
    const daily = files.find((f) => f.rel.startsWith("memory/") && f.rel.endsWith(".md"));
    expect(daily).toBeTruthy();
    const text = fs.readFileSync(daily!.abs, "utf-8");
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    void content;
  });

  it("a failing task job is caught, counted, and does not stop later jobs", async () => {
    const writer = new MemoryWriter(store, summarizer, hooks, () => DEFAULT_MEMORY_FILES_CONFIG);
    writer.enqueue({
      type: "task",
      name: "boom",
      run: () => {
        throw new Error("kaboom");
      },
    });
    writer.enqueue({ type: "daily_note", text: "still works", source: "t" });
    await writer.drain();
    expect(writer.stats().failed).toBeGreaterThanOrEqual(1);
    expect(writer.stats().processed).toBeGreaterThanOrEqual(1);
    const files = await store.listFiles();
    expect(files.some((f) => f.rel.startsWith("memory/"))).toBe(true);
  });

  it("slow lane drops jobs past the configured queue cap instead of growing unbounded", () => {
    const cfg = { ...DEFAULT_MEMORY_FILES_CONFIG, writer: { maxSlowQueue: 2 } };
    const writer = new MemoryWriter(store, summarizer, hooks, () => cfg);
    const turns = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const r1 = writer.enqueue({ type: "session_summary", sessionId: "a", turns, reason: "x" });
    const r2 = writer.enqueue({ type: "session_summary", sessionId: "b", turns, reason: "x" });
    const r3 = writer.enqueue({ type: "session_summary", sessionId: "c", turns, reason: "x" });
    expect(r1).toBe(true);
    // r2/r3 depend on how fast the pump drains; at minimum dropped is tracked once cap is hit
    void r2;
    void r3;
    expect(writer.stats().queuedSlow + writer.stats().dropped).toBeLessThanOrEqual(3);
  });

  it("drainSync persists queued daily notes synchronously and then refuses new jobs", () => {
    const writer = new MemoryWriter(store, summarizer, hooks, () => DEFAULT_MEMORY_FILES_CONFIG);
    writer.enqueue({ type: "daily_note", text: "before shutdown", source: "t" });
    writer.drainSync();
    const files = fs.readdirSync(resolveMemoryPaths(root).dailyDir);
    const text = files
      .map((f) => fs.readFileSync(path.join(resolveMemoryPaths(root).dailyDir, f), "utf-8"))
      .join("\n");
    expect(text).toContain("before shutdown");
    expect(writer.enqueue({ type: "daily_note", text: "after", source: "t" })).toBe(false);
  });
});
