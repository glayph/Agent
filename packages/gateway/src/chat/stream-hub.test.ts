import type { WebSocket } from "ws";
import { StreamHub, sendSocketEvent } from "./stream-hub.js";

class FakeSocket {
  readyState = 1;
  OPEN = 1;
  sent: Array<Record<string, any>> = [];
  throwOnSend = false;
  send(raw: string) {
    if (this.throwOnSend) throw new Error("socket is closing");
    this.sent.push(JSON.parse(raw));
  }
  get types() {
    return this.sent.map((message) => message.type);
  }
}
const asSocket = (socket: FakeSocket) => socket as unknown as WebSocket;

describe("StreamHub", () => {
  let hub: StreamHub;
  let clock = 1_000;
  const advance = (ms: number) => {
    clock += ms;
  };

  beforeEach(() => {
    clock = 1_000;
    hub = new StreamHub({ sweepIntervalMs: 0, clock: () => clock, resumeGraceMs: 30_000, finishedRetentionMs: 10_000 });
  });
  afterEach(() => hub.dispose());

  it("adds the originating user message id to run events", () => {
    const socket = new FakeSocket();
    const run = hub.createRun({ runId: "correlated", sessionId: "s1", contextId: "c1", replyToMessageId: "user-1", socket: asSocket(socket) });
    hub.publish(run, "message.create", { message_id: "assistant-1", content: "reply" });
    expect(socket.sent[0].payload).toMatchObject({ reply_to_message_id: "user-1", run_id: "correlated" });
  });

  it("sequences and buffers events and delivers them to the subscriber", () => {
    const socket = new FakeSocket();
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(socket) });
    hub.publish(run, "message.delta", { text: "a" });
    hub.publish(run, "message.delta", { text: "b" });

    expect(socket.sent.map((message) => message.sequence)).toEqual([1, 2]);
    expect(socket.sent[0]).toMatchObject({ type: "message.delta", session_id: "s1", checkpoint_id: "checkpoint_r1" });
    expect(socket.sent[0].payload).toMatchObject({ text: "a", run_id: "r1" });
    expect(run.events).toHaveLength(2);
  });

  it("keeps buffering and continues the run when a subscriber closes during send", () => {
    const closing = new FakeSocket();
    const healthy = new FakeSocket();
    const run = hub.createRun({ runId: "r-closing", sessionId: "s1", contextId: "c1", socket: asSocket(closing) });
    run.subscribers.add(asSocket(healthy));
    closing.throwOnSend = true;

    expect(() => hub.publish(run, "message.delta", { text: "still running" })).not.toThrow();
    expect(run.events).toHaveLength(1);
    expect(run.subscribers.has(asSocket(closing))).toBe(false);
    expect(healthy.sent[0]).toMatchObject({ type: "message.delta", payload: { text: "still running" } });
  });

  it("never buffers or sequences live-only events (heartbeats)", () => {
    const socket = new FakeSocket();
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(socket) });
    hub.publishLive(run, "run.heartbeat", { elapsed_seconds: 5 });

    expect(socket.types).toEqual(["run.heartbeat"]);
    expect(socket.sent[0].sequence).toBeUndefined();
    expect(run.events).toHaveLength(0);
    expect(run.sequence).toBe(0);
  });

  it("keeps buffering for a run nobody is watching, and replays it to a late subscriber", () => {
    // This is what lets the system start a run with no browser connected.
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1" });
    expect(run.subscribers.size).toBe(0);
    hub.publish(run, "message.delta", { text: "a" });
    hub.publish(run, "message.delta", { text: "b" });
    hub.finish(run, "completed");

    const late = new FakeSocket();
    hub.resume(run, asSocket(late), 1);

    expect(late.sent.map((message) => message.sequence)).toEqual([2, 3]);
    expect(late.types).toEqual(["message.delta", "stream_done"]);
  });

  it("streams a run with no explicit socket to the sockets attached to its session only", () => {
    const watching = new FakeSocket();
    const elsewhere = new FakeSocket();
    hub.attach("s1", asSocket(watching));
    hub.attach("other", asSocket(elsewhere));
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1" });
    hub.publish(run, "message.delta", {});

    expect(watching.types).toEqual(["message.delta"]);
    expect(elsewhere.sent).toEqual([]);
  });

  it("streams a run created with an explicit socket to that socket only", () => {
    const origin = new FakeSocket();
    const sibling = new FakeSocket();
    hub.attach("s1", asSocket(origin));
    hub.attach("s1", asSocket(sibling));
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(origin) });
    hub.publish(run, "message.delta", {});

    expect(origin.types).toEqual(["message.delta"]);
    expect(sibling.sent).toEqual([]);
  });

  it("announces the checkpoint with top-level checkpoint_id and sequence 0", () => {
    const socket = new FakeSocket();
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(socket) });
    hub.announce(run);

    expect(socket.sent[0]).toMatchObject({ type: "stream_checkpoint", checkpoint_id: "checkpoint_r1", sequence: 0 });
    expect(socket.sent[0].payload).toMatchObject({ run_id: "r1" });
    expect(run.events).toHaveLength(0);
  });

  it("finishes a run exactly once, so cancel and normal completion can race safely", () => {
    const socket = new FakeSocket();
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(socket) });
    hub.finish(run, "cancelled");
    hub.finish(run, "completed");

    expect(socket.sent.filter((message) => message.type === "stream_done")).toHaveLength(1);
    expect(socket.sent[0].payload.status).toBe("cancelled");
    expect(run.done).toBe(true);
  });

  it("drops late events published after cancellation", () => {
    const socket = new FakeSocket();
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(socket) });
    hub.finish(run, "cancelled");
    hub.publish(run, "message.final", { content: "stale work" });

    expect(socket.sent.map((message) => message.type)).toEqual(["stream_done"]);
    expect(run.events).toHaveLength(1);
  });

  it("includes the error in stream_done when there is one", () => {
    const socket = new FakeSocket();
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(socket) });
    hub.finish(run, "failed", "boom");
    expect(socket.sent[0].payload).toMatchObject({ status: "failed", error: "boom" });
  });

  it("resume hands the stream to the new socket and drops the previous one", () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(first) });
    hub.publish(run, "message.delta", { text: "a" });
    hub.resume(run, asSocket(second), 0);
    hub.publish(run, "message.delta", { text: "b" });

    expect(second.sent.map((message) => message.sequence)).toEqual([1, 2]);
    expect(first.sent.map((message) => message.sequence)).toEqual([1]);
  });

  it("finds a run by session and checkpoint, and not across sessions", () => {
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1" });
    expect(hub.findByCheckpoint("s1", "checkpoint_r1")).toBe(run);
    expect(hub.findByCheckpoint("s2", "checkpoint_r1")).toBeUndefined();
    expect(hub.findByCheckpoint("s1", "checkpoint_nope")).toBeUndefined();
  });

  it("caps the replay buffer but keeps sequence numbers monotonic", () => {
    const capped = new StreamHub({ sweepIntervalMs: 0, maxBufferedEvents: 3 });
    const run = capped.createRun({ runId: "r1", sessionId: "s1", contextId: "c1" });
    for (let i = 0; i < 5; i += 1) capped.publish(run, "message.delta", { i });
    expect(run.events).toHaveLength(3);
    const late = new FakeSocket();
    capped.resume(run, asSocket(late), 0);
    expect(late.types[0]).toBe("stream_gap");
    expect(late.sent[0].payload).toMatchObject({ requested_sequence: 0, oldest_buffered_sequence: 3, latest_sequence: 5 });
    expect(late.sent.slice(1).map((message) => message.sequence)).toEqual([3, 4, 5]);
    capped.dispose();
  });

  it("does not send to a closed socket", () => {
    const socket = new FakeSocket();
    const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(socket) });
    socket.readyState = 3;
    hub.publish(run, "message.delta", {});
    expect(socket.sent).toEqual([]);
    expect(run.events).toHaveLength(1);
  });

  describe("disconnects and expiry", () => {
    it("detach stops delivery but keeps an unfinished run until it completes", () => {
      const socket = new FakeSocket();
      hub.attach("s1", asSocket(socket));
      const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(socket) });
      advance(5_000);
      hub.detach(asSocket(socket));

      expect(run.subscribers.size).toBe(0);
      expect(run.expiresAt).toBe(Number.POSITIVE_INFINITY);
      hub.publish(run, "message.delta", {});
      expect(socket.sent).toEqual([]);
    });

    it("detach does not extend the lifetime of a finished run", () => {
      const socket = new FakeSocket();
      const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1", socket: asSocket(socket) });
      hub.finish(run, "completed");
      const expiry = run.expiresAt;
      advance(1_000);
      hub.detach(asSocket(socket));
      expect(run.expiresAt).toBe(expiry);
    });

    it("detach removes the socket from the session so later runs do not stream to it", () => {
      const socket = new FakeSocket();
      hub.attach("s1", asSocket(socket));
      hub.detach(asSocket(socket));
      const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1" });
      expect(run.subscribers.size).toBe(0);
    });

    it("settle shortens retention of a finished run that nobody is watching", () => {
      const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1" });
      hub.finish(run, "completed");
      advance(4_000);
      hub.settle(run);
      expect(run.expiresAt).toBe(clock + 10_000);
    });

    it("keeps disconnected active runs, but sweeps expired finished runs", async () => {
      const sweeping = new StreamHub({ sweepIntervalMs: 5, clock: () => clock, finishedRetentionMs: 1_000 });
      const active = sweeping.createRun({ runId: "active", sessionId: "s1", contextId: "c1" });
      const finished = sweeping.createRun({ runId: "finished", sessionId: "s1", contextId: "c1" });
      sweeping.finish(finished, "completed");
      advance(2_000);
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(sweeping.get("active")).toBe(active);
      expect(sweeping.get("finished")).toBeUndefined();
      sweeping.dispose();
    });

    it("automatically reattaches all active streams after a session reconnect", () => {
      const run = hub.createRun({ runId: "r1", sessionId: "s1", contextId: "c1" });
      hub.publish(run, "message.delta", { content: "in progress" });
      const socket = new FakeSocket();
      hub.resumeActiveForSession("s1", asSocket(socket));
      expect(socket.types).toEqual(["stream_checkpoint", "message.delta"]);
      expect(socket.sent[0].payload).toMatchObject({ run_id: "r1", checkpoint_id: "checkpoint_r1" });
    });
  });
});

describe("sendSocketEvent", () => {
  it("does not throw when a socket closes between readyState and send", () => {
    const socket = new FakeSocket();
    socket.throwOnSend = true;
    expect(() => sendSocketEvent(asSocket(socket), "error", "s1", {})).not.toThrow();
  });

  it("lifts checkpoint_id and sequence to the top level and skips closed sockets", () => {
    const socket = new FakeSocket();
    sendSocketEvent(asSocket(socket), "stream_checkpoint", "s1", { checkpoint_id: "cp", sequence: 0, run_id: "r1" });
    expect(socket.sent[0]).toMatchObject({ type: "stream_checkpoint", session_id: "s1", checkpoint_id: "cp", sequence: 0 });

    socket.readyState = 3;
    sendSocketEvent(asSocket(socket), "error", "s1", {});
    expect(socket.sent).toHaveLength(1);
  });
});
