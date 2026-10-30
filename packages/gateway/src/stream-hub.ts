/**
 * StreamHub: per-run event stream state, independent of any one WebSocket.
 *
 * A chat run used to carry its socket inside the run state, so a run could only exist while
 * the browser that started it was connected. The hub separates the two:
 *
 *  - a run owns an event buffer (for resume) and a sequence counter;
 *  - sockets are only *subscribers* of a run. A run keeps buffering and finishing normally when
 *    it has zero subscribers, which is what lets the system start a run on its own (no browser).
 *
 * Behaviour is intentionally identical to the previous in-handler implementation:
 *  - events are buffered (last 500) and sequenced so a reconnecting client can `resume`;
 *  - live-only events (heartbeats) are never buffered or sequenced;
 *  - a run whose last socket disconnected is kept for a grace period, a finished run for 10s;
 *  - `resume` takes the stream over for the resuming socket (the previous subscriber is dropped).
 */
import type { WebSocket } from "ws"

export type StreamStatus = "completed" | "completed_with_warning" | "failed" | "cancelled"

export interface RunStream {
  runId: string
  sessionId: string
  contextId: string
  replyToMessageId?: string
  checkpointId: string
  sequence: number
  /** Serialized, sequenced events kept for stream resume (bounded). */
  events: string[]
  /** Sockets currently receiving this run's events. Empty means nobody is watching. */
  subscribers: Set<WebSocket>
  done: boolean
  expiresAt: number
}

export interface StreamHubOptions {
  /** How long an unfinished run is kept after its last socket disconnected. */
  resumeGraceMs?: number
  /** How long a finished run stays resumable. */
  finishedRetentionMs?: number
  /** Sweep period for expired runs. 0 disables the timer (tests). */
  sweepIntervalMs?: number
  /** Cap on buffered events per run. */
  maxBufferedEvents?: number
  clock?: () => number
  /** Optional durable event sink. Failures must never interrupt a live chat stream. */
  onEvent?: (event: { runId: string; sessionId: string; sequence: number; type: string; payload: Record<string, unknown>; timestamp: number }) => void
}

const SOCKET_OPEN = 1

const isOpen = (socket: WebSocket) => socket.readyState === SOCKET_OPEN

/** One-off event sent directly to a single socket (not part of any run stream, never buffered). */
export function sendSocketEvent(socket: WebSocket, type: string, sessionId: string, payload: Record<string, unknown> = {}): void {
  if (!isOpen(socket)) return
  const message: Record<string, unknown> = { type, session_id: sessionId, timestamp: Date.now(), payload }
  if (typeof payload.checkpoint_id === "string") message.checkpoint_id = payload.checkpoint_id
  if (typeof payload.sequence === "number") message.sequence = payload.sequence
  socket.send(JSON.stringify(message))
}

export class StreamHub {
  private readonly runs = new Map<string, RunStream>()
  private readonly sessionSockets = new Map<string, Set<WebSocket>>()
  private readonly resumeGraceMs: number
  private readonly finishedRetentionMs: number
  private readonly maxBufferedEvents: number
  private readonly clock: () => number
  private readonly onEvent?: StreamHubOptions["onEvent"]
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(options: StreamHubOptions = {}) {
    this.resumeGraceMs = options.resumeGraceMs ?? 30_000
    this.finishedRetentionMs = options.finishedRetentionMs ?? 10_000
    this.maxBufferedEvents = options.maxBufferedEvents ?? 500
    this.clock = options.clock ?? Date.now
    this.onEvent = options.onEvent
    const sweepMs = options.sweepIntervalMs ?? 5_000
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepMs)
      ;(this.sweepTimer as { unref?: () => void }).unref?.()
    }
  }

  /** Register a connected socket for a session. Runs created without an explicit socket stream to these. */
  attach(sessionId: string, socket: WebSocket): void {
    const sockets = this.sessionSockets.get(sessionId) ?? new Set<WebSocket>()
    sockets.add(socket)
    this.sessionSockets.set(sessionId, sockets)
  }

  /** The socket closed: stop streaming to it. Unfinished runs it was watching start their grace period. */
  detach(socket: WebSocket): void {
    for (const [sessionId, sockets] of this.sessionSockets) {
      if (sockets.delete(socket) && sockets.size === 0) this.sessionSockets.delete(sessionId)
    }
    for (const run of this.runs.values()) {
      if (!run.subscribers.delete(socket)) continue
      if (!run.done && run.subscribers.size === 0) run.expiresAt = this.clock() + this.resumeGraceMs
    }
  }

  /**
   * Start tracking a run. With `socket` the run streams to that socket only (a user's message).
   * With no socket it streams to whichever sockets are attached to the session, possibly none
   * (a system-started run): it still buffers every event so a later `resume` can replay them.
   */
  createRun(init: { runId: string; sessionId: string; contextId: string; replyToMessageId?: string; socket?: WebSocket | null }): RunStream {
    const subscribers = init.socket
      ? new Set<WebSocket>([init.socket])
      : new Set<WebSocket>(this.sessionSockets.get(init.sessionId) ?? [])
    const run: RunStream = {
      runId: init.runId,
      sessionId: init.sessionId,
      contextId: init.contextId,
      ...(init.replyToMessageId ? { replyToMessageId: init.replyToMessageId } : {}),
      checkpointId: `checkpoint_${init.runId}`,
      sequence: 0,
      events: [],
      subscribers,
      done: false,
      expiresAt: this.clock() + this.resumeGraceMs,
    }
    this.runs.set(run.runId, run)
    return run
  }

  get(runId: string): RunStream | undefined {
    return this.runs.get(runId)
  }

  findByCheckpoint(sessionId: string, checkpointId: string): RunStream | undefined {
    for (const run of this.runs.values()) if (run.sessionId === sessionId && run.checkpointId === checkpointId) return run
    return undefined
  }

  /** Tell the subscribers which checkpoint this run streams under (sent live, not buffered). */
  announce(run: RunStream): void {
    for (const socket of run.subscribers) {
      sendSocketEvent(socket, "stream_checkpoint", run.sessionId, { checkpoint_id: run.checkpointId, run_id: run.runId, sequence: 0 })
    }
  }

  /** Sequenced event: buffered for resume and sent to every open subscriber. */
  publish(run: RunStream, type: string, payload: Record<string, unknown> = {}): void {
    if (run.done) return
    run.sequence += 1
    const timestamp = this.clock()
    const eventPayload = { ...payload, run_id: run.runId, ...(run.replyToMessageId ? { reply_to_message_id: run.replyToMessageId } : {}) }
    try {
      this.onEvent?.({ runId: run.runId, sessionId: run.sessionId, sequence: run.sequence, type, payload: eventPayload, timestamp })
    } catch {
      // Durable observability is best-effort and must never stop the user-facing stream.
    }
    const message = JSON.stringify({
      type,
      session_id: run.sessionId,
      timestamp,
      checkpoint_id: run.checkpointId,
      sequence: run.sequence,
      payload: eventPayload,
    })
    run.events.push(message)
    if (run.events.length > this.maxBufferedEvents) run.events.splice(0, run.events.length - this.maxBufferedEvents)
    for (const socket of run.subscribers) if (isOpen(socket)) socket.send(message)
  }

  /** Live-only event (heartbeats): sent to open subscribers, never buffered or sequenced. */
  publishLive(run: RunStream, type: string, payload: Record<string, unknown> = {}): void {
    if (run.subscribers.size === 0) return
    const message = JSON.stringify({ type, session_id: run.sessionId, timestamp: Date.now(), payload: { ...payload, run_id: run.runId, ...(run.replyToMessageId ? { reply_to_message_id: run.replyToMessageId } : {}) } })
    for (const socket of run.subscribers) if (isOpen(socket)) socket.send(message)
  }

  /** Terminal event. Idempotent: the first caller wins (cancel and normal completion can race). */
  finish(run: RunStream, status: StreamStatus, error?: string): void {
    if (run.done) return
    this.publish(run, "stream_done", { status, ...(error ? { error } : {}) })
    run.done = true
    run.expiresAt = this.clock() + this.finishedRetentionMs
    const timer = setTimeout(() => {
      if (this.runs.get(run.runId) === run && this.clock() >= run.expiresAt) this.runs.delete(run.runId)
    }, this.finishedRetentionMs + 1_000)
    ;(timer as { unref?: () => void }).unref?.()
  }

  /** A reconnecting client takes the stream over and replays everything after `lastSequence`. */
  resume(run: RunStream, socket: WebSocket, lastSequence: number): void {
    run.subscribers = new Set([socket])
    run.expiresAt = this.clock() + (run.done ? this.finishedRetentionMs : this.resumeGraceMs)
    for (const serialized of run.events) {
      try {
        const candidate = JSON.parse(serialized) as { sequence?: number }
        if (Number(candidate.sequence) > lastSequence && isOpen(socket)) socket.send(serialized)
      } catch { /* a malformed buffered event must never break resume */ }
    }
  }

  /** Called when the turn that owned the run has fully ended (success or failure). */
  settle(run: RunStream): void {
    if (run.done && run.subscribers.size === 0) run.expiresAt = this.clock() + this.finishedRetentionMs
  }

  /** Number of tracked runs (diagnostics and tests). */
  size(): number {
    return this.runs.size
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  private sweep(): void {
    const cutoff = this.clock()
    for (const [runId, run] of this.runs) if (run.expiresAt <= cutoff && run.subscribers.size === 0) this.runs.delete(runId)
  }
}
