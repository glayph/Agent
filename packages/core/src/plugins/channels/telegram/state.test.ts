import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { TelegramStateStore } from "./state.js";

const stores: TelegramStateStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("TelegramStateStore", () => {
  it("rejects duplicate updates after reopening", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-telegram-state-"));
    dirs.push(dir);
    const first = new TelegramStateStore(dir);
    stores.push(first);
    expect(first.claimUpdate("100")).toBe(true);
    first.completeUpdate("100");
    first.close();
    stores.splice(stores.indexOf(first), 1);
    const reopened = new TelegramStateStore(dir);
    stores.push(reopened);
    expect(reopened.claimUpdate("100")).toBe(false);
  });

  it("enforces a per-sender durable minute rate limit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-telegram-state-"));
    dirs.push(dir);
    const store = new TelegramStateStore(dir);
    stores.push(store);
    expect(store.allowRate("sender", 2)).toBe(true);
    expect(store.allowRate("sender", 2)).toBe(true);
    expect(store.allowRate("sender", 2)).toBe(false);
  });

  it("reclaims a failed update for retry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-telegram-state-"));
    dirs.push(dir);
    const store = new TelegramStateStore(dir);
    stores.push(store);
    expect(store.claimUpdate("retry-me")).toBe(true);
    store.failUpdate("retry-me");
    expect(store.claimUpdate("retry-me")).toBe(true);
  });
});
