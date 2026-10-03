/**
 * Step 02 — file-based memory system (OpenClaw-style).
 *
 * OpenClaw's memory is plain Markdown on disk; the model only "remembers"
 * what was written to a file. Miki follows the same layout, systemwide (one
 * memory for the whole agent — not per workspace folder, not per project):
 *
 *   <identityDir>/MEMORY.md                 curated long-term facts/decisions
 *   <identityDir>/memory/YYYY-MM-DD.md      daily notes (append-only)
 *   <identityDir>/memory/YYYY-MM-DD-HHMM-<slug>.md   session summaries
 *   <identityDir>/memory/compactions/*.md   archives of compacted context
 *
 * Nothing in this module may block, delay or fail a user-facing turn.
 */

export type SummarizerMode = "auto" | "llm" | "heuristic";

export interface MemoryFilesConfig {
  enabled: boolean;
  /** Absolute override for the memory root (default: identityDir). */
  dir?: string;
  /** Owner/agent/workspace scope; isolates all memory files under scopes/<scope>/. */
  scope?: string;
  /** Total character budget for the memory block injected into the prompt. */
  bootstrapMaxChars: number;
  /** Share of the budget MEMORY.md may use (injected copy only — the file on disk is never truncated). */
  memoryMdMaxChars: number;
  /** How many days back the "recent notes" index looks (today = 1). */
  recentDays: number;
  indexMaxEntries: number;
  summarizer: SummarizerMode;
  summaryTimeoutMs: number;
  /** Last N user/assistant messages considered for a session summary. */
  summaryTurns: number;
  /** A session with no activity for this long is summarised. 0 disables. */
  sessionIdleMinutes: number;
  /** Fewer non-empty user/assistant messages than this → nothing worth saving. */
  minTurnsForSummary: number;
  writer: { maxSlowQueue: number };
  compaction: {
    enabled: boolean;
    /** % of the context budget at which older turns are compacted. */
    triggerPercent: number;
    /** Never compact fewer conversational messages than this. */
    minMessages: number;
    /** Most recent conversational messages kept verbatim (>= 2). */
    keepRecent: number;
    maxSummaryChars: number;
    /** Silent pre-compaction "write durable notes now" pass. */
    flushEnabled: boolean;
    /** The flush fires this many percentage points before the trigger. */
    flushMarginPercent: number;
  };
}

/** Minimal shape shared by ChatMessage and persisted history rows. */
export interface TurnLike {
  role: string;
  content?: string | null;
  name?: string;
  is_error?: boolean;
  created_at?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export type SummaryKind = "session" | "compaction" | "flush";

export interface SummaryDoc {
  topics: string[];
  decisions: string[];
  outcomes: string[];
  tools: Record<string, { n: number; failed: number }>;
  files: string[];
  turns: number;
}

export interface MemoryPaths {
  root: string;
  memoryMd: string;
  dailyDir: string;
  compactionDir: string;
}

export type MemoryHookEvent =
  | "before_compaction"
  | "after_compaction"
  | "flush"
  | "session_saved";

export interface MemoryHookPayloads {
  before_compaction: {
    sessionId: string;
    messageCount: number;
    chars: number;
    thresholdChars: number;
  };
  after_compaction: {
    sessionId: string;
    archivedCount: number;
    keptCount: number;
    summaryChars: number;
    archivePath: string;
  };
  flush: { sessionId: string; noted: number; via: "llm" | "heuristic" | "none" };
  session_saved: { sessionId: string; path: string; reason: string };
}

export interface WriterStats {
  queuedFast: number;
  queuedSlow: number;
  processed: number;
  failed: number;
  dropped: number;
  lastError?: string;
}
