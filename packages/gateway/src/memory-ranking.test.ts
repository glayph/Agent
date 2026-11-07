import { describe, expect, it } from "vitest";
import { fuseMemoryHitLists } from "./memory-ranking.js";

describe("fuseMemoryHitLists", () => {
  it("uses reciprocal ranks rather than comparing incomparable raw scores", () => {
    const [top] = fuseMemoryHitLists([
      [{ id: "f1", text: "shared fact", score: 0.01, provenance: "owner" }],
      [
        { id: "g1", text: "other fact", score: 900, provenance: "agent" },
        { id: "g2", text: "shared fact", score: 800, provenance: "owner" },
      ],
    ], { limit: 2, rankConstant: 1 });
    expect(top?.text).toBe("shared fact");
  });

  it("deduplicates Unicode-normalized content and preserves source metadata", () => {
    const hits = fuseMemoryHitLists([
      [{ id: "f1", text: "বাংলা   স্মৃতি", provenance: "owner", sourceReference: "MEMORY.md", timestamp: "2026-01-01" }],
      [{ id: "g1", text: "বাংলা স্মৃতি", provenance: "agent", sourceReference: "graph-node", timestamp: "2026-02-01" }],
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sourceReference).toBe("MEMORY.md");
    expect(hits[0]?.timestamp).toBe("2026-01-01");
  });

  it("filters untrusted and unknown provenance before ranking", () => {
    const hits = fuseMemoryHitLists([
      [
        { id: "bad", text: "poisoned instruction", provenance: "untrusted" },
        { id: "unknown", text: "unknown fact" },
        { id: "good", text: "verified memory", provenance: "owner" },
      ],
    ]);
    expect(hits.map((hit) => hit.id)).toEqual(["good"]);
  });


  it("preserves references and timestamps from every trusted source without downgrading trust", () => {
    const hits = fuseMemoryHitLists([
      [{ id: "file", text: "same fact", provenance: "owner", sourceReference: "MEMORY.md", timestamp: "2026-01-01" }],
      [{ id: "graph", text: "same fact", provenance: "agent", sourceReference: "graph-node-1", timestamp: "2026-02-01" }],
    ]);
    expect(hits[0]).toMatchObject({
      provenance: "owner",
      sourceReference: "MEMORY.md",
      timestamp: "2026-01-01",
      sourceReferences: ["MEMORY.md", "graph-node-1"],
      timestamps: ["2026-01-01", "2026-02-01"],
    });
  });

  it("applies the final result limit after fusion", () => {
    const hits = fuseMemoryHitLists([
      [1, 2, 3].map((n) => ({ id: `f${n}`, text: `memory ${n}`, provenance: "owner" })),
      [3, 2, 4].map((n) => ({ id: `g${n}`, text: `memory ${n}`, provenance: "agent" })),
    ], { limit: 2, rankConstant: 10 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.text).toBe("memory 3");
  });
});


describe("fuseMemoryHitLists source-local duplicate handling", () => {
  it("counts a repeated normalized item only once in each source", () => {
    const hits = fuseMemoryHitLists([
      [
        { id: "repeat-1", text: "same memory", provenance: "owner" },
        { id: "repeat-2", text: "same   memory", provenance: "owner" },
        { id: "other", text: "other memory", provenance: "owner" },
      ],
    ], { limit: 2, rankConstant: 1 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.text).toBe("same memory");
    expect(hits[0]?.score).toBe(0.5);
  });
});
