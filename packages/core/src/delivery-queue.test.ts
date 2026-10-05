import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "@jest/globals";
import { DeliveryQueue } from "./delivery-queue.js";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-idempotency-"));
}

describe("DeliveryQueue idempotency safety", () => {
  test("rejects reusing an idempotency key for a different request", () => {
    const dir = makeDir();
    try {
      const queue = new DeliveryQueue(path.join(dir, "deliveries.json"));
      queue.enqueue({
        channel: "webhook",
        destination: "https://example.invalid/a",
        body: "first",
        idempotencyKey: "same-key",
      });
      expect(() =>
        queue.enqueue({
          channel: "webhook",
          destination: "https://example.invalid/a",
          body: "different",
          idempotencyKey: "same-key",
        }),
      ).toThrow(/different delivery request/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("converts an in-flight receipt to unknown outcome after restart", () => {
    const dir = makeDir();
    try {
      const file = path.join(dir, "deliveries.json");
      const firstQueue = new DeliveryQueue(file);
      const receipt = firstQueue.enqueue({
        channel: "webhook",
        destination: "https://example.invalid/a",
        body: "once",
        idempotencyKey: "crash-key",
      });
      expect(firstQueue.claim()?.status).toBe("sending");

      const recoveredQueue = new DeliveryQueue(file);
      expect(recoveredQueue.get(receipt.id)).toMatchObject({
        status: "unknown_outcome",
        replayAllowed: false,
        errorClass: "unknown_side_effect",
      });
      expect(recoveredQueue.claim()).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("treats a thrown sender error as unknown outcome", async () => {
    const dir = makeDir();
    try {
      const queue = new DeliveryQueue(path.join(dir, "deliveries.json"));
      const receipt = queue.enqueue({
        channel: "webhook",
        destination: "https://example.invalid/a",
        body: "may-have-been-sent",
        idempotencyKey: "uncertain-key",
      });
      const settled = await queue.dispatch(async () => {
        throw new Error("connection closed after write");
      });
      expect(settled).toMatchObject({
        id: receipt.id,
        status: "unknown_outcome",
        errorClass: "unknown_side_effect",
        replayAllowed: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not change a terminal receipt when settle is called again", () => {
    const dir = makeDir();
    try {
      const queue = new DeliveryQueue(path.join(dir, "deliveries.json"));
      const receipt = queue.enqueue({
        channel: "webhook",
        destination: "https://example.invalid/a",
        body: "terminal",
        idempotencyKey: "terminal-key",
      });
      queue.claim();
      expect(queue.settle(receipt.id, { status: "sent" })).toMatchObject({
        status: "sent",
      });
      expect(
        queue.settle(receipt.id, {
          status: "failed",
          error: "late duplicate result",
        }),
      ).toMatchObject({ status: "sent" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("DeliveryQueue adaptive output", () => {
  it("persists ordered adaptive chunks with stable idempotency keys", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miki-adaptive-"));
    const queue = new DeliveryQueue(path.join(dir, "deliveries.json"));
    const receipts = queue.enqueueAdaptive(
      { id: "response-1", runId: "run-1", channel: "discord", kind: "response", content: "# A\n\n" + "One. " + "a".repeat(180) + "\n\n# B\n\n" + "Two. " + "b".repeat(180), final: true },
      { destination: "channel-1", maxAttempts: 2 },
      { multiMessageMinLength: 256 },
    );
    expect(receipts.length).toBe(2);
    expect(receipts.map((item) => item.messageSequence)).toEqual([1, 2]);
    expect(new Set(receipts.map((item) => item.idempotencyKey)).size).toBe(2);
  });
});
