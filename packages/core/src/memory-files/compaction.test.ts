import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ChatMessage } from "@miki/config";
import { resolveMemoryPaths } from "./paths.js";
import { MemoryFileStore } from "./store.js";
import { MemoryHooks } from "./hooks.js";
import { Summarizer } from "./summarizer.js";
import { MemoryWriter } from "./writer.js";
import { CompactionManager, SUMMARY_SENTINEL } from "./compaction.js";
import { DEFAULT_MEMORY_FILES_CONFIG } from "./config.js";
import type { MemoryFilesConfig } from "./types.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-memcompact-"));
}

function makeManager(root: string, cfg: MemoryFilesConfig) {
  const store = new MemoryFileStore(resolveMemoryPaths(root));
  const hooks = new MemoryHooks();
  const summarizer = new Summarizer({ getMode: () => "heuristic", timeoutMs: 1000 });
  const writer = new MemoryWriter(store, summarizer, hooks, () => cfg);
  const manager = new CompactionManager(() => cfg, writer, hooks, store);
  return { manager, writer, hooks, store };
}

function longMessages(n: number, size = 200): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${i % 2 === 0 ? "Decision: always do thing " : "Done: completed thing "}${i} `.padEnd(
        size,
        "x",
      ),
    } as ChatMessage);
  }
  return out;
}

describe("CompactionManager", () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("does nothing when under the trigger threshold", async () => {
    root = tmpRoot();
    const cfg = DEFAULT_MEMORY_FILES_CONFIG;
    const { manager } = makeManager(root, cfg);
    const messages = longMessages(4, 20);
    const result = await manager.compact("s1", messages, { budgetChars: 100_000 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("compacts older turns into a rolling summary once over budget, keeping recent turns verbatim", async () => {
    root = tmpRoot();
    const cfg: MemoryFilesConfig = {
      ...DEFAULT_MEMORY_FILES_CONFIG,
      compaction: { ...DEFAULT_MEMORY_FILES_CONFIG.compaction, keepRecent: 4, minMessages: 6 },
    };
    const { manager, writer } = makeManager(root, cfg);
    const messages = longMessages(20, 300);
    const result = await manager.compact("s2", messages, { budgetChars: 2000 });
    expect(result.compacted).toBe(true);
    expect(result.archivedCount).toBeGreaterThan(0);
    const summary = result.messages.find(
      (m) => m.role === "system" && String(m.content).startsWith(SUMMARY_SENTINEL),
    );
    expect(summary).toBeTruthy();
    // Last 4 conversational messages survive verbatim.
    const tail = result.messages.slice(-4);
    expect(tail.map((m) => m.content)).toEqual(messages.slice(-4).map((m) => m.content));
    await writer.drain();
    const files = await new MemoryFileStore(resolveMemoryPaths(root)).listFiles();
    expect(files.some((f) => f.rel.includes("compactions/"))).toBe(true);
  });

  it("never separates a tool result from the assistant call that requested it", async () => {
    root = tmpRoot();
    const cfg: MemoryFilesConfig = {
      ...DEFAULT_MEMORY_FILES_CONFIG,
      compaction: { ...DEFAULT_MEMORY_FILES_CONFIG.compaction, keepRecent: 2, minMessages: 4 },
    };
    const { manager } = makeManager(root, cfg);
    const messages: ChatMessage[] = [
      ...longMessages(10, 300),
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "file_read", arguments: "{}" } }] } as ChatMessage,
      { role: "tool", name: "file_read", tool_call_id: "c1", content: "file contents" } as ChatMessage,
    ];
    const result = await manager.compact("s3", messages, { budgetChars: 1500 });
    if (result.compacted) {
      const first = result.messages.find((m) => m.role !== "system");
      // whichever message starts the kept tail, it must not be a bare tool result
      expect(first?.role).not.toBe("tool");
    }
  });

  it("does not throw and returns the original messages if something internal goes wrong", async () => {
    root = tmpRoot();
    const cfg = DEFAULT_MEMORY_FILES_CONFIG;
    const { manager } = makeManager(root, cfg);
    const messages = longMessages(10);
    // budgetChars of 0 forces a degenerate threshold; must not throw.
    const result = await manager.compact("s4", messages, { budgetChars: 0 });
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("forget() clears session state so a later compaction starts fresh", async () => {
    root = tmpRoot();
    const cfg: MemoryFilesConfig = {
      ...DEFAULT_MEMORY_FILES_CONFIG,
      compaction: { ...DEFAULT_MEMORY_FILES_CONFIG.compaction, keepRecent: 4, minMessages: 6 },
    };
    const { manager } = makeManager(root, cfg);
    await manager.compact("s5", longMessages(20, 300), { budgetChars: 2000 });
    expect(manager.stats().sessions).toBeGreaterThan(0);
    manager.forget("s5");
    expect(manager.stats().sessions).toBe(0);
  });
});
