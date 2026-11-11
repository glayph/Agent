import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveMemoryPaths } from "./paths.js";
import { MemoryFileStore, executeOp } from "./store.js";
import { MemoryHooks } from "./hooks.js";
import { Summarizer, extractDurableFacts } from "./summarizer.js";
import { MemoryWriter } from "./writer.js";
import { DEFAULT_MEMORY_FILES_CONFIG } from "./config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "miki-memaudit-"));

describe("memory audit regressions", () => {
  it("#11 scopes never share a root and cannot escape the base", () => {
    const root = tmp();
    const a = resolveMemoryPaths(root, undefined, "agent-a");
    const b = resolveMemoryPaths(root, undefined, "agent-b");
    expect(a.root).not.toBe(b.root);
    expect(resolveMemoryPaths(root, undefined, "../../x").root.startsWith(root)).toBe(true);
  });

  it("#7 normalized duplicate long-term notes are skipped", async () => {
    const store = new MemoryFileStore(resolveMemoryPaths(tmp()));
    await executeOp(store.planLongTermNote("User prefers  Dark Mode"));
    expect(await executeOp(store.planLongTermNote("user prefers dark mode"))).toBeNull();
  });

  it("#6 assistant-only facts are tagged tentative", () => {
    const facts = extractDurableFacts([
      { role: "user", content: "Remember I prefer tabs over spaces." },
      { role: "assistant", content: "Noted: we decided to always deploy on Fridays." },
    ]);
    expect(facts[0]).not.toMatch(/^\[TENTATIVE\]/);
    expect(facts[1]).toMatch(/^\[TENTATIVE\]/);
  });

  it("#12 unfinished journal entries are replayed on startup", () => {
    const paths = resolveMemoryPaths(tmp());
    fs.mkdirSync(path.join(paths.root, ".wal"), { recursive: true });
    fs.writeFileSync(
      path.join(paths.root, ".wal", "memory-writer.jsonl"),
      JSON.stringify({ id: "j1", job: { type: "daily_note", text: "crash survivor", source: "t" }, done: false, ts: 1 }) + "\n",
    );
    new MemoryWriter(
      new MemoryFileStore(paths),
      new Summarizer({ getMode: () => "heuristic", timeoutMs: 1000 }),
      new MemoryHooks(),
      () => DEFAULT_MEMORY_FILES_CONFIG,
    );
    const text = fs.readdirSync(paths.dailyDir).map((f) => fs.readFileSync(path.join(paths.dailyDir, f), "utf-8")).join("");
    expect(text).toContain("crash survivor");
  });
});
