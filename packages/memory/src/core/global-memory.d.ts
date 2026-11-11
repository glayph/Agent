import type { AgentMemoryIntegration, ExtractionSummary } from "./types.js";
/**
 * One global memory for every channel.
 *
 * Chats stay separate conversations (each task has its own thread and history),
 * but what Miki learns lives in a single store: a fact told in the web chat is
 * recalled when the same owner writes from Telegram, and the other way round.
 *
 * Because that store is shared, who may read and write it matters. Only the
 * owner's own channels do. Anything else (a stranger who messages a Telegram
 * bot, an API test) neither reads the memory nor leaves anything in it, so a
 * hostile message on one channel can never plant instructions that Miki later
 * follows on another.
 */
export interface GlobalMemoryDeps {
    getIntegration: () => AgentMemoryIntegration | null | undefined;
    /** Live app config; read on every call so changes apply without a restart. */
    getConfig: () => unknown;
    log?: (message: string, details?: Record<string, unknown>) => void;
}
export interface TurnOrigin {
    /** Channel the message arrived on: "webchat", "telegram", ... */
    source: string;
    /** Sender identity on that channel (Telegram user id, ...). */
    peerId?: string;
    /** The chat/thread = task this turn belongs to. */
    sessionId?: string;
    /** Human title of that task, when known. */
    taskTitle?: string;
}
export interface RecordedTurn extends TurnOrigin {
    userMessage: string;
    assistantMessage: string;
    status: string;
}
/**
 * The owner's own channels share memory. Another platform counts as the owner
 * only when the sender is listed in `agent.memory.global.owner_peers` as "<source>:<peerId>"
 * (for example "telegram:123456789").
 */
export declare function isOwnerOrigin(origin: Pick<TurnOrigin, "source" | "peerId"> | null | undefined, config: unknown): boolean;
export interface GlobalMemoryHit {
    id: string;
    text: string;
    region: string;
    score: number;
    provenance: "owner" | "agent";
    sourceReference?: string;
    timestamp?: string;
    source?: "graph";
}
export interface GlobalMemory {
    /** Bounded recall for this message, or undefined (not the owner, nothing recalled, or an error). */
    recall(goal: string, origin: TurnOrigin): string | undefined;
    /**
     * Graph + semantic search over the same memory, as structured hits for the
     * `memory_search` tool. Owner-only like recall; no word matching is involved:
     * ranking comes from the memory engine (graph relations, activation, embeddings).
     */
    search(query: string, origin: TurnOrigin, limit: number): GlobalMemoryHit[];
    /** Remember a finished turn. Returns whether it was written. */
    recordTurn(turn: RecordedTurn): boolean;
    /**
     * Turn stored paragraphs into graph knowledge (entities and relations) with the
     * given model. Only the owner's turns are ever stored, so everything processed
     * here already passed the owner check.
     */
    extractPending(options: {
        complete: (messages: Array<{
            role: string;
            content: string;
        }>) => Promise<string>;
        limit?: number;
        signal?: AbortSignal;
    }): Promise<ExtractionSummary>;
}
export declare function createGlobalMemory(deps: GlobalMemoryDeps): GlobalMemory;
