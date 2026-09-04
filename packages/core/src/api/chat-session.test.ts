import {
  normalizeChatSessionId,
  SINGLE_CHAT_SESSION_ID,
} from "./chat-session.js";

describe("chat session identity", () => {
  it("accepts bounded UUID-like session identifiers", () => {
    expect(normalizeChatSessionId("a1b2c3-4d5e")).toBe("a1b2c3-4d5e");
  });

  it("falls back for missing, malformed, or oversized identifiers", () => {
    expect(normalizeChatSessionId(undefined)).toBe(SINGLE_CHAT_SESSION_ID);
    expect(normalizeChatSessionId("../../outside")).toBe(
      SINGLE_CHAT_SESSION_ID,
    );
    expect(normalizeChatSessionId("x".repeat(121))).toBe(
      SINGLE_CHAT_SESSION_ID,
    );
  });
});
