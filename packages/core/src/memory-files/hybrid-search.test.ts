import {
  applyRankingAdjustments,
  chunkMarkdown,
  diversifyWithMmr,
  filenameMatchMultiplier,
  fuseRankedPaths,
  recencyMultiplier,
  retrieveRelevantTurns,
  scoreBm25,
  scoreCosine,
  tokenizeSearchText,
  type SearchDocument,
} from "./hybrid-search.js";

describe("hybrid memory search primitives", () => {
  it("chunks Markdown into 400-token windows with 80-token overlap and source line ranges", () => {
    const markdown = Array.from(
      { length: 1_000 },
      (_, index) => `term${index}`,
    ).join("\n");
    const chunks = chunkMarkdown("memory/long.md", markdown);

    expect(chunks.map((chunk) => chunk.tokenCount)).toEqual([400, 400, 360]);
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 400],
      [321, 720],
      [641, 1_000],
    ]);
    expect(chunks[0]!.path).toBe("memory/long.md");
    expect(tokenizeSearchText(chunks[0]!.text)).toHaveLength(400);
    expect(chunks[0]!.text).toContain("term0");
    expect(chunks[0]!.text).toContain("term399");
    expect(chunks[1]!.text).toContain("term320");
    expect(chunks[1]!.text).toContain("term719");
  });

  it("tokenizes Bengali terms and finds exact Unicode IDs", () => {
    const docs: SearchDocument[] = [
      {
        path: "memory/বাংলা-পরিচয়.md",
        text: "ব্যবহারকারীর নাম মেঘলা এবং ID রবি-৭২৯।",
      },
      { path: "memory/other.md", text: "সাধারণ বাংলা নোট।" },
    ];
    expect(tokenizeSearchText("আমার নাম মিকি")).toEqual([
      "আমার",
      "নাম",
      "মিকি",
    ]);
    expect(scoreBm25("রবি ৭২৯", docs)[0]?.path).toBe("memory/বাংলা-পরিচয়.md");
    expect(
      filenameMatchMultiplier("বাংলা-পরিচয়", docs[0]!.path),
    ).toBeGreaterThan(1);
  });

  it("retrieves relevant prior conversation turns after prompt compaction", () => {
    const turns = [
      { role: "user", content: "Remember project codename Falcon-72." },
      { role: "assistant", content: "I will remember Falcon-72." },
      { role: "user", content: "The weather is sunny today." },
    ];
    expect(retrieveRelevantTurns("What was the project codename Falcon-72?", turns, 2))
      .toEqual(turns.slice(0, 2));
    expect(retrieveRelevantTurns("unmatched zebra token", turns)).toEqual([]);
  });

  it("ranks semantic vector matches by cosine similarity", () => {
    const docs: SearchDocument[] = [
      { path: "semantic.md", text: "unrelated words", vector: [0.8, 0.6] },
      { path: "lexical.md", text: "query terms", vector: [0, 1] },
    ];
    expect(scoreCosine([1, 0], docs)[0]?.path).toBe("semantic.md");
  });

  it("falls back to whichever ranking leg is available", () => {
    const keywordOnly = fuseRankedPaths([{ path: "keyword.md", score: 4 }], []);
    const vectorOnly = fuseRankedPaths([], [{ path: "vector.md", score: 0.9 }]);
    expect(keywordOnly.map((item) => item.path)).toEqual(["keyword.md"]);
    expect(vectorOnly.map((item) => item.path)).toEqual(["vector.md"]);
    expect(
      fuseRankedPaths(
        [{ path: "k.md", score: 1 }],
        [{ path: "v.md", score: 1 }],
        { mode: "normalized" },
      ),
    ).toHaveLength(2);
  });

  it("applies a 30-day recency half-life only to dated memory notes", () => {
    const now = Date.UTC(2026, 0, 31);
    const options = { now, recencyHalfLifeDays: 30 };
    expect(recencyMultiplier("memory/2026-01-01.md", options)).toBeCloseTo(
      0.5,
      2,
    );
    expect(recencyMultiplier("MEMORY.md", options)).toBe(1);
    expect(recencyMultiplier("USER.md", options)).toBe(1);
    expect(recencyMultiplier("memory/undated-notes.md", options)).toBe(1);
  });

  it("keeps missing importance neutral and clamps supplied importance", () => {
    const scores = [
      { path: "neutral.md", score: 1 },
      { path: "important.md", score: 1 },
      { path: "low.md", score: 1 },
    ];
    const docs: SearchDocument[] = [
      { path: "neutral.md", text: "fact" },
      { path: "important.md", text: "fact", importance: 99 },
      { path: "low.md", text: "fact", importance: 0 },
    ];
    const adjusted = applyRankingAdjustments(scores, docs, "fact", {
      now: Date.UTC(2026, 0, 31),
    });
    expect(adjusted.find((item) => item.path === "neutral.md")?.score).toBe(1);
    expect(adjusted.find((item) => item.path === "important.md")?.score).toBe(
      2,
    );
    expect(adjusted.find((item) => item.path === "low.md")?.score).toBe(0.5);
  });

  it("prefers exact path, basename, and extensionless filename matches", () => {
    expect(
      filenameMatchMultiplier("memory/Project-X.md", "memory/Project-X.md"),
    ).toBeGreaterThan(1);
    expect(
      filenameMatchMultiplier("Project-X.md", "memory/Project-X.md"),
    ).toBeGreaterThan(1);
    expect(
      filenameMatchMultiplier("Project-X", "memory/Project-X.md"),
    ).toBeGreaterThan(1);
    expect(filenameMatchMultiplier("project", "memory/Project-X.md")).toBe(1);
    const adjusted = applyRankingAdjustments(
      [
        { path: "memory/Project-X.md", score: 1 },
        { path: "memory/other.md", score: 1 },
      ],
      [
        { path: "memory/Project-X.md", text: "x" },
        { path: "memory/other.md", text: "x" },
      ],
      "Project-X",
      { now: Date.UTC(2026, 0, 31) },
    );
    expect(adjusted[0]?.path).toBe("memory/Project-X.md");
  });

  it("uses MMR with Jaccard overlap to diversify the top results", () => {
    const docs: SearchDocument[] = [
      { path: "first.md", text: "red apple fruit orchard" },
      { path: "near-duplicate.md", text: "red apple fruit orchard harvest" },
      { path: "diverse.md", text: "blue ocean sailing coast" },
    ];
    const ranked = [
      { path: "first.md", score: 1 },
      { path: "near-duplicate.md", score: 0.95 },
      { path: "diverse.md", score: 0.8 },
    ];
    expect(
      diversifyWithMmr(ranked, docs, { limit: 2 }).map((item) => item.path),
    ).toEqual(["first.md", "diverse.md"]);
  });

  it("handles invalid numeric scores without producing non-finite output", () => {
    const fused = fuseRankedPaths(
      [{ path: "bad.md", score: Number.NaN }],
      [{ path: "valid.md", score: 0.5 }],
      { keywordWeight: Number.POSITIVE_INFINITY },
    );
    expect(fused.every((item) => Number.isFinite(item.score))).toBe(true);
  });
});
