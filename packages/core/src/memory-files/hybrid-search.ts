/**
 * Deterministic, provider-free primitives for hybrid memory retrieval.
 * The functions here are intentionally pure so gateway adapters can supply
 * SQLite rows and locally-computed vectors without coupling this module to IO.
 */

const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;
const DEFAULT_TARGET_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 80;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MarkdownChunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tokenCount: number;
}

export interface ChunkMarkdownOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

interface LocatedToken {
  value: string;
  start: number;
  end: number;
}

/** Unicode-property tokenization keeps combining marks and Bengali words intact. */
export function tokenizeSearchText(text: string): string[] {
  return [...text.normalize("NFKC").toLocaleLowerCase().matchAll(WORD_RE)].map(
    (match) => match[0],
  );
}

/**
 * Split Markdown into token windows (400 tokens by default), with a shared
 * 80-token tail between adjacent chunks. Line numbers are 1-based and inclusive.
 */
export function chunkMarkdown(
  sourcePath: string,
  markdown: string,
  options: ChunkMarkdownOptions = {},
): MarkdownChunk[] {
  const target = positiveInteger(options.targetTokens, DEFAULT_TARGET_TOKENS);
  const overlap = Math.min(
    target - 1,
    nonNegativeInteger(options.overlapTokens, DEFAULT_OVERLAP_TOKENS),
  );
  const step = Math.max(1, target - overlap);
  const tokens: LocatedToken[] = [];
  for (const match of markdown.matchAll(WORD_RE)) {
    tokens.push({
      value: match[0],
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  if (tokens.length === 0) return [];

  const lineStarts = [0];
  for (let i = 0; i < markdown.length; i++)
    if (markdown[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (lineStarts[mid]! <= offset) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  const chunks: MarkdownChunk[] = [];
  for (let first = 0; first < tokens.length; first += step) {
    const last = Math.min(tokens.length - 1, first + target - 1);
    const firstToken = tokens[first]!;
    const lastToken = tokens[last]!;
    const text = markdown.slice(firstToken.start, lastToken.end).trim();
    if (text) {
      chunks.push({
        path: sourcePath,
        startLine: lineAt(firstToken.start),
        endLine: lineAt(lastToken.end),
        text,
        tokenCount: last - first + 1,
      });
    }
    if (last === tokens.length - 1) break;
  }
  return chunks;
}

export interface SearchDocument {
  /** Unique chunk key; path remains the human-readable source file path. */
  id?: string;
  path: string;
  text: string;
  /** Optional semantic embedding associated with this path. */
  vector?: readonly number[];
  /** Optional importance multiplier. Missing or invalid values are neutral. */
  importance?: number;
}

function documentKey(document: SearchDocument): string {
  return document.id || document.path;
}

export interface PathScore {
  path: string;
  score: number;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 1 ? Math.floor(value!) : fallback;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : fallback;
}

function termCounts(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** Return per-document BM25 scores (k1=1.2, b=0.75), stably sorted by score/path. */
export function scoreBm25(
  query: string,
  documents: readonly SearchDocument[],
): PathScore[] {
  const queryTerms = [...new Set(tokenizeSearchText(query))];
  if (queryTerms.length === 0 || documents.length === 0) return [];
  const indexed = documents.map((document) => {
    const counts = termCounts(tokenizeSearchText(document.text));
    return {
      document,
      counts,
      length: [...counts.values()].reduce((sum, count) => sum + count, 0),
    };
  });
  const avgLength =
    indexed.reduce((sum, item) => sum + item.length, 0) / indexed.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      indexed.reduce((sum, item) => sum + (item.counts.has(term) ? 1 : 0), 0),
    );
  }
  const k1 = 1.2;
  const b = 0.75;
  const scores = indexed.map(({ document, counts, length }) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = counts.get(term) ?? 0;
      if (!tf) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (indexed.length - df + 0.5) / (df + 0.5));
      score +=
        idf *
        ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / avgLength)));
    }
    return { path: documentKey(document), score: finite(score) };
  });
  return scores.filter((item) => item.score > 0).sort(comparePathScores);
}

/** Retrieve matching historical user/assistant turns after their raw context is compacted. */
export function retrieveRelevantTurns<T extends { role: string; content: string }>(
  query: string,
  turns: readonly T[],
  limit = 3,
): T[] {
  const stopwords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for",
    "from", "how", "i", "in", "is", "it", "me", "my", "of", "on",
    "or", "our", "the", "this", "to", "was", "we", "what", "when",
    "where", "which", "who", "with", "you", "your",
  ]);
  const queryTerms = tokenizeSearchText(query).filter((term) => !stopwords.has(term));
  if (queryTerms.length === 0) return [];
  const documents = turns.flatMap((turn, index) =>
    (turn.role === "user" || turn.role === "assistant") && turn.content.trim()
      ? [{ path: String(index), text: turn.content }]
      : [],
  );
  const byIndex = new Map(
    turns.map((turn, index) => [String(index), turn] as const),
  );
  return scoreBm25(queryTerms.join(" "), documents)
    .slice(0, Math.max(0, Math.floor(limit)))
    .flatMap(({ path }) => {
      const turn = byIndex.get(path);
      return turn ? [turn] : [];
    });
}

/** Cosine similarity between a query vector and each document vector. */
export function scoreCosine(
  queryVector: readonly number[],
  documents: readonly SearchDocument[],
): PathScore[] {
  const query = queryVector.map((value) => finite(value));
  const queryNorm = Math.sqrt(
    query.reduce((sum, value) => sum + value * value, 0),
  );
  if (!queryNorm) return [];
  const scores: PathScore[] = [];
  for (const document of documents) {
    if (!document.vector || document.vector.length !== query.length) continue;
    let dot = 0;
    let docSquared = 0;
    for (let i = 0; i < query.length; i++) {
      const value = finite(document.vector[i]!);
      dot += query[i]! * value;
      docSquared += value * value;
    }
    const denominator = queryNorm * Math.sqrt(docSquared);
    if (denominator > 0)
      scores.push({ path: documentKey(document), score: finite(dot / denominator) });
  }
  return scores.sort(comparePathScores);
}

function comparePathScores(a: PathScore, b: PathScore): number {
  return b.score - a.score || a.path.localeCompare(b.path);
}

export type FusionMode = "rrf" | "normalized";

export interface FusionOptions {
  mode?: FusionMode;
  keywordWeight?: number;
  vectorWeight?: number;
  /** Reciprocal-rank offset; 60 is a standard conservative default. */
  rankConstant?: number;
}

export interface FusedPathScore extends PathScore {
  keywordScore?: number;
  vectorScore?: number;
}

/**
 * Weighted reciprocal-rank fusion by default, or weighted min-max score fusion.
 * Empty/unavailable legs contribute nothing; a sole available leg still works.
 */
export function fuseRankedPaths(
  keywordScores: readonly PathScore[],
  vectorScores: readonly PathScore[],
  options: FusionOptions = {},
): FusedPathScore[] {
  const keywordWeight = nonNegative(finite(options.keywordWeight ?? 1, 1));
  const vectorWeight = nonNegative(finite(options.vectorWeight ?? 1, 1));
  const rankConstant = Math.max(0, finite(options.rankConstant ?? 60, 60));
  const keywordRanks = new Map(
    keywordScores.map((item, index) => [item.path, index + 1]),
  );
  const vectorRanks = new Map(
    vectorScores.map((item, index) => [item.path, index + 1]),
  );
  const keywordByPath = new Map(
    keywordScores.map((item) => [item.path, finite(item.score)]),
  );
  const vectorByPath = new Map(
    vectorScores.map((item) => [item.path, finite(item.score)]),
  );
  const paths = new Set([...keywordRanks.keys(), ...vectorRanks.keys()]);
  const normalize = (scores: readonly PathScore[]): Map<string, number> => {
    const vals = scores.map((item) => finite(item.score));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return new Map(
      scores.map((item) => [
        item.path,
        max > min ? (finite(item.score) - min) / (max - min) : 1,
      ]),
    );
  };
  const keywordNorm = normalize(keywordScores);
  const vectorNorm = normalize(vectorScores);
  const mode = options.mode ?? "rrf";
  return [...paths]
    .map((path) => {
      const keywordRank = keywordRanks.get(path);
      const vectorRank = vectorRanks.get(path);
      let score = 0;
      if (mode === "normalized") {
        const availableWeight =
          (keywordRank === undefined ? 0 : keywordWeight) +
          (vectorRank === undefined ? 0 : vectorWeight);
        if (availableWeight > 0) {
          score =
            ((keywordRank === undefined
              ? 0
              : keywordNorm.get(path)! * keywordWeight) +
              (vectorRank === undefined
                ? 0
                : vectorNorm.get(path)! * vectorWeight)) /
            availableWeight;
        }
      } else {
        if (keywordRank !== undefined)
          score += keywordWeight / (rankConstant + keywordRank);
        if (vectorRank !== undefined)
          score += vectorWeight / (rankConstant + vectorRank);
      }
      return {
        path,
        score: finite(score),
        ...(keywordByPath.has(path)
          ? { keywordScore: keywordByPath.get(path) }
          : {}),
        ...(vectorByPath.has(path)
          ? { vectorScore: vectorByPath.get(path) }
          : {}),
      };
    })
    .filter((item) => item.score > 0)
    .sort(comparePathScores);
}

export interface RankingOptions {
  /** Timestamp reference for deterministic recency scoring. Defaults to now. */
  now?: number | Date;
  recencyHalfLifeDays?: number;
  importanceMin?: number;
  importanceMax?: number;
  filenameBoost?: number;
}

function datedDailyNote(path: string): Date | undefined {
  // Date-shaped basenames include YYYY-MM-DD.md and session-summary suffixes.
  const match = path
    .replace(/\\/g, "/")
    .match(/(?:^|\/)(\d{4})-(\d{2})-(\d{2})(?:[-.]|$)/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return date;
}

/** 30-day half-life on date-stamped memory paths; evergreen files are unchanged. */
export function recencyMultiplier(
  path: string,
  options: RankingOptions = {},
): number {
  const normalized = path.replace(/\\/g, "/");
  if (/(?:^|\/)(?:MEMORY|USER)\.md$/i.test(normalized)) return 1;
  const noteDate = datedDailyNote(normalized);
  if (!noteDate) return 1;
  const nowValue =
    options.now instanceof Date
      ? options.now.getTime()
      : (options.now ?? Date.now());
  const now = finite(nowValue, Date.now());
  const ageDays = Math.max(0, (now - noteDate.getTime()) / DAY_MS);
  const halfLife = Math.max(
    0.001,
    finite(
      options.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS,
      DEFAULT_RECENCY_HALF_LIFE_DAYS,
    ),
  );
  return finite(Math.pow(0.5, ageDays / halfLife), 1);
}

/** Prefer exact path, basename, or extensionless stem query matches. */
export function filenameMatchMultiplier(
  query: string,
  path: string,
  boost = 1.5,
): number {
  const wanted = normalizeIdentifier(query);
  if (!wanted) return 1;
  const normalizedPath = path.replace(/\\/g, "/").toLocaleLowerCase();
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const stem = basename.replace(/\.[^.]*$/, "");
  const pathWithoutExtension = normalizedPath.replace(/\.[^.\/]*$/, "");
  if (
    wanted === normalizedPath ||
    wanted === pathWithoutExtension ||
    wanted === basename ||
    wanted === stem
  ) {
    return clamp(finite(boost, 1.5), 1, 3);
  }
  return 1;
}

function normalizeIdentifier(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLocaleLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, finite(value, min)));
}

function nonNegative(value: number): number {
  return Math.max(0, finite(value));
}

/** Apply recency, bounded importance, and exact-name preference to fused scores. */
export function applyRankingAdjustments(
  scores: readonly PathScore[],
  documents: readonly SearchDocument[],
  query: string,
  options: RankingOptions = {},
): FusedPathScore[] {
  const byPath = new Map(
    documents.map((document) => [documentKey(document), document]),
  );
  const min = finite(options.importanceMin ?? 0.5, 0.5);
  const max = finite(options.importanceMax ?? 2, 2);
  const importanceMin = Math.min(min, max);
  const importanceMax = Math.max(min, max);
  return scores
    .map((item) => {
      const document = byPath.get(item.path);
      const importance = document?.importance;
      const importanceMultiplier = Number.isFinite(importance)
        ? clamp(importance!, importanceMin, importanceMax)
        : 1;
      const filenameMultiplier = filenameMatchMultiplier(
        query,
        document?.path ?? item.path,
        options.filenameBoost,
      );
      const recency = recencyMultiplier(document?.path ?? item.path, options);
      return {
        ...item,
        score: finite(
          finite(item.score) *
            importanceMultiplier *
            filenameMultiplier *
            recency,
        ),
      };
    })
    .sort(comparePathScores);
}

export interface MmrOptions {
  lambda?: number;
  limit?: number;
}

/**
 * Greedy maximal-marginal-relevance re-ranking with token-set Jaccard overlap.
 * A higher lambda favors original relevance; the safe default is 0.7.
 */
export function diversifyWithMmr(
  ranked: readonly PathScore[],
  documents: readonly SearchDocument[],
  options: MmrOptions = {},
): FusedPathScore[] {
  const lambda = clamp(finite(options.lambda ?? 0.7, 0.7), 0, 1);
  const limit =
    options.limit === undefined
      ? ranked.length
      : positiveInteger(options.limit, ranked.length);
  const textByPath = new Map(
    documents.map((document) => [documentKey(document), document.text]),
  );
  const tokensByPath = new Map<string, Set<string>>();
  for (const item of ranked)
    tokensByPath.set(
      item.path,
      new Set(tokenizeSearchText(textByPath.get(item.path) ?? "")),
    );
  const remaining = ranked.map((item) => ({
    ...item,
    score: finite(item.score),
  }));
  const selected: FusedPathScore[] = [];
  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestMmr = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const candidateTokens =
        tokensByPath.get(candidate.path) ?? new Set<string>();
      let maxSimilarity = 0;
      for (const chosen of selected) {
        const chosenTokens = tokensByPath.get(chosen.path) ?? new Set<string>();
        maxSimilarity = Math.max(
          maxSimilarity,
          jaccard(candidateTokens, chosenTokens),
        );
      }
      const relevance = finite(candidate.score);
      const mmr = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (
        mmr > bestMmr ||
        (mmr === bestMmr &&
          candidate.path.localeCompare(remaining[bestIndex]!.path) < 0)
      ) {
        bestMmr = mmr;
        bestIndex = i;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }
  return selected;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}
