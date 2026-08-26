/**
 * AgentMessageBus — Phase 2: Inter-Agent Message Passing
 *
 * A lightweight in-process (and optionally IPC-capable) event bus so agents
 * can communicate without tight coupling. Supports fire-and-forget sends,
 * request/reply with timeout, and broadcast messages.
 *
 * The existing channels/ directory handles external adapters (Discord, Slack,
 * Telegram, etc.). This bus makes those messages also routable between
 * internal agents.
 */

import { EventEmitter } from "events";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentMessageType =
  | "task_delegate"
  | "task_result"
  | "task_cancel"
  | "status_query"
  | "status_reply"
  | "broadcast"
  | "heartbeat"
  | "error";

export interface AgentMessage {
  id: string;
  type: AgentMessageType;
  /** Agent instance ID of sender, or "orchestrator" */
  from: string;
  /** Agent instance ID of recipient, or "broadcast" */
  to: string | "broadcast";
  payload: unknown;
  timestamp: Date;
  /** Links replies to their originating requests */
  correlationId?: string;
  /** If set, this message will expire before delivery after this date */
  expiresAt?: Date;
}

export type MessageHandler = (msg: AgentMessage) => void;

// ---------------------------------------------------------------------------
// Dead-letter queue entry
// ---------------------------------------------------------------------------

export interface DeadLetterEntry {
  message: AgentMessage;
  reason: "no_subscriber" | "timeout" | "delivery_error";
  failedAt: Date;
}

// ---------------------------------------------------------------------------
// AgentMessageBus
// ---------------------------------------------------------------------------

/**
 * In-process message bus for agent-to-agent communication.
 *
 * Design principles:
 * - All communication is async and non-blocking
 * - Undeliverable messages go to the dead-letter queue
 * - request() waits for a correlated reply with a configurable timeout
 */
export class AgentMessageBus extends EventEmitter {
  private subscriptions: Map<string, Set<MessageHandler>> = new Map();
  private deadLetterQueue: DeadLetterEntry[] = [];
  private readonly maxDeadLetterSize: number;

  constructor(maxDeadLetterSize: number = 500) {
    super();
    this.maxDeadLetterSize = maxDeadLetterSize;
    // Higher limit than default 10 to avoid MaxListenersExceededWarning
    this.setMaxListeners(200);
  }

  // ---- Core messaging -------------------------------------------------------

  /**
   * Send a message to a specific agent instance or "broadcast".
   * If no subscriber is found, the message goes to the dead-letter queue.
   */
  send(message: AgentMessage): void {
    // Drop expired messages
    if (message.expiresAt && message.expiresAt < new Date()) {
      this._deadLetter(message, "timeout");
      return;
    }

    if (message.to === "broadcast") {
      this._deliverBroadcast(message);
    } else {
      this._deliverDirect(message);
    }

    // Always emit a global "message" event for observability
    this.emit("message", message);
  }

  /**
   * Subscribe an agent instance to receive its messages.
   * Returns an unsubscribe function.
   */
  subscribe(instanceId: string, handler: MessageHandler): () => void {
    if (!this.subscriptions.has(instanceId)) {
      this.subscriptions.set(instanceId, new Set());
    }
    this.subscriptions.get(instanceId)!.add(handler);

    return () => {
      const handlers = this.subscriptions.get(instanceId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.subscriptions.delete(instanceId);
        }
      }
    };
  }

  /**
   * Broadcast a message to all currently subscribed agents.
   */
  broadcast(from: string, payload: unknown): void {
    const message = this._makeMessage({
      type: "broadcast",
      from,
      to: "broadcast",
      payload,
    });
    this.send(message);
  }

  /**
   * Send a request and await a correlated reply within timeoutMs.
   * Throws an error if no reply arrives before the timeout.
   */
  request(
    from: string,
    to: string,
    payload: unknown,
    timeoutMs: number,
  ): Promise<AgentMessage> {
    return new Promise<AgentMessage>((resolve, reject) => {
      const requestMsg = this._makeMessage({
        type: "task_delegate",
        from,
        to,
        payload,
      });

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._deadLetter(requestMsg, "timeout");
        reject(
          new Error(
            `AgentMessageBus: request from "${from}" to "${to}" timed out after ${timeoutMs}ms (correlationId: ${requestMsg.id})`,
          ),
        );
      }, timeoutMs);

      // Listen for a reply with matching correlationId
      const replyHandler = (msg: AgentMessage) => {
        if (
          msg.correlationId === requestMsg.id &&
          msg.from === to &&
          msg.to === from
        ) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.off("message", replyHandler);
          resolve(msg);
        }
      };

      this.on("message", replyHandler);
      this.send(requestMsg);
    });
  }

  // ---- Dead-letter queue ---------------------------------------------------

  getDeadLetterQueue(): readonly DeadLetterEntry[] {
    return this.deadLetterQueue;
  }

  clearDeadLetterQueue(): void {
    this.deadLetterQueue = [];
  }

  // ---- Statistics ----------------------------------------------------------

  subscriberCount(instanceId?: string): number {
    if (instanceId) {
      return this.subscriptions.get(instanceId)?.size ?? 0;
    }
    let total = 0;
    for (const handlers of this.subscriptions.values()) {
      total += handlers.size;
    }
    return total;
  }

  // ---- Private helpers -----------------------------------------------------

  private _makeMessage(
    partial: Omit<AgentMessage, "id" | "timestamp">,
  ): AgentMessage {
    return {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      ...partial,
    };
  }

  private _deliverDirect(message: AgentMessage): void {
    const handlers = this.subscriptions.get(message.to as string);
    if (!handlers || handlers.size === 0) {
      this._deadLetter(message, "no_subscriber");
      return;
    }
    for (const handler of handlers) {
      try {
        handler(message);
      } catch {
        this._deadLetter(message, "delivery_error");
      }
    }
  }

  private _deliverBroadcast(message: AgentMessage): void {
    let delivered = false;
    for (const [, handlers] of this.subscriptions) {
      for (const handler of handlers) {
        try {
          handler(message);
          delivered = true;
        } catch {
          // Broadcast delivery errors are non-fatal; continue to others
        }
      }
    }
    if (!delivered) {
      this._deadLetter(message, "no_subscriber");
    }
  }

  private _deadLetter(
    message: AgentMessage,
    reason: DeadLetterEntry["reason"],
  ): void {
    if (this.deadLetterQueue.length >= this.maxDeadLetterSize) {
      this.deadLetterQueue.shift();
    }
    this.deadLetterQueue.push({ message, reason, failedAt: new Date() });
    this.emit("dead_letter", { message, reason });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const globalAgentMessageBus = new AgentMessageBus();
