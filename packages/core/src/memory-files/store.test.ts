import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveMemoryPaths } from "./paths.js";
import { MemoryFileStore, executeOp, executeOpSync } from "./store.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-memfiles-"));
}

describe("MemoryFileStore", () => {
  let root: string;
  let store: MemoryFileStore;

  beforeEach(() => {
    root = tmpRoot();
    store = new MemoryFileStore(resolveMemoryPaths(root));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates MEMORY.md with a header on first note, then appends without repeating it", async () => {
    await executeOp(store.planLongTermNote("Prefers Bengali-English mixed replies"));
    await executeOp(store.planLongTermNote("Uses TypeScript for the core package"));
    const content = await store.readMemoryMd();
    expect(content).toMatch(/^# MEMORY\.md/);
    expect(content.match(/# MEMORY\.md/g)).toHaveLength(1);
    expect(content).toContain("Prefers Bengali-English mixed replies");
    expect(content).toContain("Uses TypeScript for the core package");
  });

  it("skips an exact-duplicate long-term note instead of appending it again", async () => {
    await executeOp(store.planLongTermNote("Never store plaintext passwords"));
    const before = await store.readMemoryMd();
    await executeOp(store.planLongTermNote("Never store plaintext passwords"));
    const after = await store.readMemoryMd();
    expect(after).toBe(before);
  });

  it("redacts secrets before they ever reach disk", async () => {
    await executeOp(
      store.planLongTermNote("api_key: sk-abcdEFGH1234567890xyz should stay out"),
    );
    const content = await store.readMemoryMd();
    expect(content).not.toContain("sk-abcdEFGH1234567890xyz");
    expect(content).toContain("[REDACTED:api-key]");
  });

  it("writes daily notes under memory/YYYY-MM-DD.md", async () => {
    const now = new Date(2026, 8, 29, 10, 15);
    await executeOp(store.planDailyNote("Fixed the CI pipeline", "agent", now));
    const files = await store.listFiles();
    const rel = files.map((f) => f.rel).sort();
    expect(rel).toContain("memory/2026-09-29.md");
  });

  it("session-summary files never collide or overwrite an existing one", async () => {
    const now = new Date(2026, 8, 29, 9, 0);
    const op1 = store.planSessionSummary({
      sessionId: "s1",
      title: "same title",
      summary: "first",
      reason: "idle",
      via: "heuristic",
      now,
    });
    const op2 = store.planSessionSummary({
      sessionId: "s2",
      title: "same title",
      summary: "second",
      reason: "idle",
      via: "heuristic",
      now,
    });
    const p1 = await executeOp(op1);
    const p2 = await executeOp(op2);
    expect(p1).not.toBe(p2);
    expect(fs.readFileSync(p1!, "utf-8")).toContain("first");
    expect(fs.readFileSync(p2!, "utf-8")).toContain("second");
  });

  it("executeOpSync writes synchronously (shutdown path)", () => {
    const op = store.planDailyNote("sync write", "shutdown");
    const written = executeOpSync(op);
    expect(fs.readFileSync(written!, "utf-8")).toContain("sync write");
  });

  it("listFiles finds MEMORY.md and every memory/**.md file, recursively", async () => {
    await executeOp(store.planLongTermNote("fact one"));
    await executeOp(store.planDailyNote("today's note"));
    await executeOp(
      store.planCompactionArchive({
        sessionId: "abc",
        summary: "compacted stuff",
        archivedCount: 5,
      }),
    );
    const rels = (await store.listFiles()).map((f) => f.rel).sort();
    expect(rels).toContain("MEMORY.md");
    expect(rels.some((r) => r.startsWith("memory/") && r.endsWith(".md"))).toBe(true);
    expect(rels.some((r) => r.startsWith("memory/compactions/"))).toBe(true);
  });
});
