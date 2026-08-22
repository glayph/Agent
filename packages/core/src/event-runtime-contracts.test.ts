import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeliveryQueue } from "./delivery-queue.js";
import {
  createDefaultChannelRegistry,
  normalizeInboundEvent,
} from "./event-envelope.js";
import { WatcherRegistry } from "./watcher-registry.js";

describe("event runtime contracts", () => {
  it("normalizes all configured channels into one idempotent envelope", () => {
    const registry = createDefaultChannelRegistry();
    expect(registry.list()).toHaveLength(9);
    const event = registry.normalize("telegram", {
      eventId: "evt-1",
      senderId: "user-1",
      sessionId: "session-1",
      payload: { text: "hello" },
    });
    expect(event).toMatchObject({
      eventId: "evt-1",
      idempotencyKey: "telegram:evt-1",
      channel: "telegram",
      sessionId: "session-1",
      replyRoute: { channel: "telegram", address: "user-1" },
    });
  });

  it("rejects malformed events and supports explicit correlation", () => {
    expect(() =>
      normalizeInboundEvent({ channel: "web", sender: { id: "" } }),
    ).toThrow("sender.id is required");
    const event = normalizeInboundEvent({
      channel: "api",
      sender: { id: "service" },
      correlationId: "corr-1",
      idempotencyKey: "request-1",
    });
    expect(event.correlationId).toBe("corr-1");
    expect(event.idempotencyKey).toBe("request-1");
  });

  it("persists delivery receipts, deduplicates sends and dead-letters failures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-delivery-"));
    const queue = new DeliveryQueue(path.join(dir, "deliveries.json"));
    const input = {
      channel: "webhook" as const,
      destination: "https://example.invalid/hook",
      body: "response",
      idempotencyKey: "delivery-1",
      maxAttempts: 1,
    };
    const first = queue.enqueue(input);
    expect(queue.enqueue(input).id).toBe(first.id);
    const settled = await queue.dispatch(async () => ({
      status: "failed" as const,
      error: "network down",
    }));
    expect(settled?.status).toBe("dead_letter");
    expect(queue.stats().dead_letter).toBe(1);
    expect(queue.replay(first.id, "delivery-2")?.status).toBe("pending");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("emits watcher changes once per fingerprint and persists health", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-watchers-"));
    const file = path.join(dir, "watchers.json");
    const registry = new WatcherRegistry(file);
    let value = "same";
    registry.register({
      id: "deterministic-test",
      intervalMs: 100,
      check: async () => ({ summary: value, data: { value } }),
    });
    const changes: string[] = [];
    await registry.tick((_watcher, observation) =>
      changes.push(observation.summary),
    );
    await registry.tick((_watcher, observation) =>
      changes.push(observation.summary),
    );
    value = "changed";
    await new Promise((resolve) => setTimeout(resolve, 105));
    await registry.tick((_watcher, observation) =>
      changes.push(observation.summary),
    );
    expect(changes).toEqual(["changed"]);
    expect(registry.health()).toMatchObject({ total: 1, healthy: 1 });
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
