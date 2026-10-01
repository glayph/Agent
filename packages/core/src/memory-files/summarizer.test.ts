import {
  extractDoc,
  mergeDocs,
  renderDoc,
  extractDurableFacts,
  buildTranscript,
  Summarizer,
} from "./summarizer.js";
import type { TurnLike } from "./types.js";

describe("extractDoc (heuristic summarisation)", () => {
  it("pulls topics from user turns and outcomes from assistant turns", () => {
    const turns: TurnLike[] = [
      { role: "user", content: "Please refactor the login form to use hooks." },
      { role: "assistant", content: "Done — the login form now uses useState and useEffect." },
    ];
    const doc = extractDoc(turns);
    expect(doc.topics.some((t) => /refactor the login form/i.test(t))).toBe(true);
    expect(doc.outcomes.some((o) => /login form now uses/i.test(o))).toBe(true);
    expect(doc.turns).toBe(2);
  });

  it("recognises decision/preference language in English and Bengali", () => {
    const turns: TurnLike[] = [
      { role: "user", content: "Remember that I always prefer TypeScript over JavaScript." },
      { role: "user", content: "আমার নাম মিকি, এবং আমি সবসময় বাংলায় উত্তর পছন্দ করি।" },
    ];
    const doc = extractDoc(turns);
    expect(doc.decisions.some((d) => /prefer TypeScript/i.test(d))).toBe(true);
    expect(doc.decisions.some((d) => /বাংলায়/.test(d))).toBe(true);
  });

  it("counts tool calls and marks failures from the following tool result", () => {
    const turns: TurnLike[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", function: { name: "file_write", arguments: '{"path":"a.ts"}' } },
        ],
      },
      { role: "tool", name: "file_write", tool_call_id: "c1", content: "Error: permission denied" },
    ];
    const doc = extractDoc(turns);
    expect(doc.tools["file_write"]).toEqual({ n: 1, failed: 1 });
    expect(doc.files).toContain("a.ts");
  });

  it("ignores is_error turns and system turns", () => {
    const turns: TurnLike[] = [
      { role: "system", content: "system stuff" },
      { role: "user", content: "hello", is_error: true },
      { role: "user", content: "real question about the deploy pipeline" },
    ];
    const doc = extractDoc(turns);
    expect(doc.topics.some((t) => /system stuff/.test(t))).toBe(false);
    expect(doc.topics.some((t) => /hello/.test(t))).toBe(false);
    expect(doc.topics.some((t) => /deploy pipeline/.test(t))).toBe(true);
  });

  it("caps list sizes and keeps the doc bounded even with huge input", () => {
    const turns: TurnLike[] = [];
    for (let i = 0; i < 200; i++) {
      turns.push({ role: "user", content: `unique topic number ${i} about widgets` });
      turns.push({ role: "assistant", content: `outcome number ${i} resolved successfully` });
    }
    const doc = extractDoc(turns);
    expect(doc.topics.length).toBeLessThanOrEqual(8);
    expect(doc.outcomes.length).toBeLessThanOrEqual(8);
  });
});

describe("mergeDocs", () => {
  it("combines tool counts and de-duplicates topics/decisions", () => {
    const a = extractDoc([{ role: "user", content: "Use pnpm for this repo, always." }]);
    const b = extractDoc([
      { role: "user", content: "Use pnpm for this repo, always." },
      { role: "user", content: "We will always enable strict mode in tsconfig." },
    ]);
    const merged = mergeDocs(a, b);
    expect(merged.decisions.filter((d) => /pnpm/i.test(d))).toHaveLength(1);
    expect(merged.decisions.some((d) => /strict mode/i.test(d))).toBe(true);
    expect(merged.turns).toBe(a.turns + b.turns);
  });
});

describe("renderDoc", () => {
  it("never exceeds the requested character budget", () => {
    const turns: TurnLike[] = [];
    for (let i = 0; i < 50; i++) {
      turns.push({
        role: "user",
        content: `Decision: always use approach number ${i} for this kind of problem, it must be followed`,
      });
    }
    const doc = extractDoc(turns);
    const rendered = renderDoc(doc, 300);
    expect(rendered.length).toBeLessThanOrEqual(300);
  });

  it("produces empty string for an empty doc", () => {
    expect(renderDoc({ topics: [], decisions: [], outcomes: [], tools: {}, files: [], turns: 0 }, 500)).toBe("");
  });
});

describe("extractDurableFacts", () => {
  it("returns only decision-like lines, capped at 10", () => {
    const turns: TurnLike[] = [
      { role: "user", content: "Just chatting about the weather today." },
      { role: "user", content: "Decided: we will ship on Fridays from now on." },
    ];
    const facts = extractDurableFacts(turns);
    expect(facts.some((f) => /ship on Fridays/i.test(f))).toBe(true);
    expect(facts.some((f) => /weather/i.test(f))).toBe(false);
  });
});

describe("buildTranscript", () => {
  it("keeps the most recent turns within the char budget and redacts secrets", () => {
    const turns: TurnLike[] = [
      { role: "user", content: "old message ".repeat(50) },
      { role: "user", content: "my token is sk-ABCDEFGHIJKLMNOPQR1234567890" },
    ];
    const t = buildTranscript(turns, 200);
    expect(t.length).toBeLessThanOrEqual(200);
    expect(t).not.toContain("sk-ABCDEFGHIJKLMNOPQR1234567890");
  });
});

describe("Summarizer", () => {
  it("falls back to heuristic when mode is heuristic even if an llm fn is provided", async () => {
    const llm = jest.fn(async () => "TITLE: x\nshould not be used");
    const s = new Summarizer({ getMode: () => "heuristic", llm, timeoutMs: 1000 });
    const turns: TurnLike[] = [{ role: "user", content: "Prefer dark mode always." }];
    const result = await s.summarizeSession(turns, 500);
    expect(result.via).toBe("heuristic");
    expect(llm).not.toHaveBeenCalled();
  });

  it("uses the llm in llm mode, and parses TITLE + body", async () => {
    const llm = jest.fn(async () => "TITLE: Dark mode preference\nUser wants dark mode always.");
    const s = new Summarizer({ getMode: () => "llm", llm, timeoutMs: 1000 });
    const turns: TurnLike[] = [{ role: "user", content: "Please always use dark mode." }];
    const result = await s.summarizeSession(turns, 500);
    expect(result.via).toBe("llm");
    expect(result.title).toBe("Dark mode preference");
    expect(result.summary).toContain("dark mode always");
  });

  it("falls back to heuristic when the llm throws", async () => {
    const llm = jest.fn(async () => {
      throw new Error("provider down");
    });
    const s = new Summarizer({ getMode: () => "llm", llm, timeoutMs: 1000 });
    const turns: TurnLike[] = [{ role: "user", content: "Remember to use pnpm always." }];
    const result = await s.summarizeSession(turns, 500);
    expect(result.via).toBe("heuristic");
  });

  it("falls back to heuristic when the llm times out", async () => {
    const llm = jest.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("TITLE: late\nlate"), 200)),
    );
    const s = new Summarizer({ getMode: () => "llm", llm, timeoutMs: 20 });
    const turns: TurnLike[] = [{ role: "user", content: "Remember to use pnpm always." }];
    const result = await s.summarizeSession(turns, 500);
    expect(result.via).toBe("heuristic");
  });

  it("in auto mode, respects llmAllowed()", async () => {
    const llm = jest.fn(async () => "TITLE: t\nbody");
    const s = new Summarizer({ getMode: () => "auto", llm, llmAllowed: () => false, timeoutMs: 1000 });
    const turns: TurnLike[] = [{ role: "user", content: "Remember to use pnpm always." }];
    const result = await s.summarizeSession(turns, 500);
    expect(result.via).toBe("heuristic");
    expect(llm).not.toHaveBeenCalled();
  });

  it("extractFlushNotes returns NO_REPLY as an empty, non-throwing result", async () => {
    const llm = jest.fn(async () => "NO_REPLY");
    const s = new Summarizer({ getMode: () => "llm", llm, timeoutMs: 1000 });
    const r = await s.extractFlushNotes([{ role: "user", content: "just chatting" }]);
    expect(r.notes).toEqual([]);
    expect(r.via).toBe("llm");
  });
});
