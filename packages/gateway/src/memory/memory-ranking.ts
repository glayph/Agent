/**
 * Rank File Memory and Graph Memory on one comparable scale.
 *
 * Raw BM25, cosine and graph-activation values are not calibrated against one
 * another. Reciprocal Rank Fusion uses only each source's within-list order,
 * while provenance is filtered before a candidate can receive any rank.
 */
export interface UnifiedMemoryHit {
  id: string;
  text: string;
  region?: string;
  score?: number;
  provenance?: string;
  sourceReference?: string;
  timestamp?: string;
  source?: "file" | "graph" | string;
  [key: string]: unknown;
}

export interface MemoryRankingOptions {
  limit?: number;
  rankConstant?: number;
  sourceWeights?: readonly number[];
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/[\u200c\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function trusted(hit: UnifiedMemoryHit): boolean {
  return hit.provenance === "owner" || hit.provenance === "agent";
}

/** Apply trust filtering, deduplicate, RRF-fuse all source lists, then limit. */
export function fuseMemoryHitLists(
  lists: readonly (readonly UnifiedMemoryHit[])[],
  options: MemoryRankingOptions = {},
): UnifiedMemoryHit[] {
  const limit = Math.max(1, Math.min(20, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 8));
  const k = Math.max(1, Number.isFinite(options.rankConstant) ? Math.floor(options.rankConstant!) : 60);
  const byText = new Map<string, { hit: UnifiedMemoryHit; score: number; bestRank: number }>();

  lists.forEach((list, sourceIndex) => {
    const weight = Math.max(0, Number(options.sourceWeights?.[sourceIndex] ?? 1) || 0);
    if (!weight) return;
    const seenInSource = new Set<string>();
    const eligible = list.filter((hit) => typeof hit?.text === "string" && hit.text.trim() && trusted(hit));
    let eligibleRank = 0;
    for (const hit of eligible) {
      const key = normalizeText(hit.text);
      if (!key || seenInSource.has(key)) continue;
      seenInSource.add(key);
      eligibleRank += 1;
      const rank = eligibleRank;
      const contribution = weight / (k + rank);
      const existing = byText.get(key);
      if (existing) {
        existing.score += contribution;
        const betterRecord = rank < existing.bestRank ||
          (rank === existing.bestRank && hit.provenance === "owner" && existing.hit.provenance !== "owner");
        const preferred = betterRecord ? { ...existing.hit, ...hit } : existing.hit;
        const references = [...new Set([
          ...(Array.isArray(existing.hit.sourceReferences) ? existing.hit.sourceReferences.filter((value): value is string => typeof value === "string") : []),
          ...(typeof existing.hit.sourceReference === "string" ? [existing.hit.sourceReference] : []),
          ...(Array.isArray(hit.sourceReferences) ? hit.sourceReferences.filter((value): value is string => typeof value === "string") : []),
          ...(typeof hit.sourceReference === "string" ? [hit.sourceReference] : []),
        ])];
        const timestamps = [...new Set([
          ...(Array.isArray(existing.hit.timestamps) ? existing.hit.timestamps.filter((value): value is string => typeof value === "string") : []),
          ...(typeof existing.hit.timestamp === "string" ? [existing.hit.timestamp] : []),
          ...(Array.isArray(hit.timestamps) ? hit.timestamps.filter((value): value is string => typeof value === "string") : []),
          ...(typeof hit.timestamp === "string" ? [hit.timestamp] : []),
        ])];
        // Keep every source reference/time when the same fact occurs in both
        // stores. Trust is the strongest verified level across eligible copies;
        // a weaker duplicate must not downgrade an owner-approved record.
        const provenance = existing.hit.provenance === "owner" || hit.provenance === "owner" ? "owner" : "agent";
        byText.set(key, {
          hit: {
            ...preferred,
            provenance,
            sourceReference: preferred.sourceReference ?? existing.hit.sourceReference ?? hit.sourceReference,
            timestamp: preferred.timestamp ?? existing.hit.timestamp ?? hit.timestamp,
            sourceReferences: references,
            timestamps,
          },
          score: existing.score,
          bestRank: betterRecord ? rank : existing.bestRank,
        });
      } else {
        byText.set(key, { hit: { ...hit }, score: contribution, bestRank: rank });
      }
    }
  });

  return [...byText.values()]
    .sort((a, b) => b.score - a.score || a.bestRank - b.bestRank || a.hit.id.localeCompare(b.hit.id))
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score: Number(score.toFixed(8)) }));
}
