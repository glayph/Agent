import { describe, expect, it } from "vitest";
import {
  isTelegramAdmin,
  parseTelegramAdminCommand,
  resolveTelegramRuntimeConfig,
} from "./telegram.js";

describe("Telegram administration controls", () => {
  it("parses only the narrow approvals, approve, and deny commands", () => {
    expect(parseTelegramAdminCommand("/miki approvals")).toEqual({
      action: "approvals",
    });
    expect(
      parseTelegramAdminCommand(
        "/approve 123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toEqual({
      action: "approve",
      requestId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(
      parseTelegramAdminCommand(
        "/miki deny 123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toEqual({
      action: "deny",
      requestId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(parseTelegramAdminCommand("/miki reset")).toBeNull();
    expect(parseTelegramAdminCommand("/miki approve not-a-request")).toBeNull();
  });

  it("requires an explicit admin allow-list separate from ordinary chat allow-list", () => {
    const config = resolveTelegramRuntimeConfig(
      {
        channels: {
          telegram: {
            enabled: true,
            settings: {
              token: "test-token",
              allow_from: ["chat-user"],
              admin_allow_from: ["42"],
            },
          },
        },
      },
      {},
    );
    const adminContext = {
      chat: { id: 100 },
      from: { id: 42, is_bot: false },
    } as Parameters<typeof isTelegramAdmin>[0];
    const regularContext = {
      chat: { id: 100 },
      from: { id: 43, is_bot: false },
    } as Parameters<typeof isTelegramAdmin>[0];

    expect(config.allowedIds).toEqual(["chat-user"]);
    expect(config.adminIds).toEqual(["42"]);
    expect(isTelegramAdmin(adminContext, config)).toBe(true);
    expect(isTelegramAdmin(regularContext, config)).toBe(false);
  });
});
