import { normalizeSessionScope, resolveSessionContextId } from "./session-scope.js";

describe("session scope", () => {
  it("normalizes only supported modes", () => {
    expect(normalizeSessionScope("global")).toBe("global");
    expect(normalizeSessionScope("per-channel")).toBe("per-channel");
    expect(normalizeSessionScope("per-peer")).toBe("per-peer");
    expect(normalizeSessionScope("bad-value")).toBe("per-channel-peer");
  });

  it("maps channel/peer identity to stable context keys", () => {
    expect(resolveSessionContextId("per-channel-peer", "telegram", "u1")).toBe("channel:telegram:peer:u1");
    expect(resolveSessionContextId("per-channel", "telegram", "u1")).toBe("channel:telegram");
    expect(resolveSessionContextId("per-peer", "telegram", "u1")).toBe("peer:u1");
    expect(resolveSessionContextId("global", "telegram", "u1")).toBe("miki-global");
  });

  it("shares and isolates exactly as the UI descriptions specify", () => {
    expect(resolveSessionContextId("per-channel", "a", "u1")).toBe(resolveSessionContextId("per-channel", "a", "u2"));
    expect(resolveSessionContextId("per-channel", "a", "u1")).not.toBe(resolveSessionContextId("per-channel", "b", "u1"));
    expect(resolveSessionContextId("per-peer", "a", "u1")).toBe(resolveSessionContextId("per-peer", "b", "u1"));
    expect(resolveSessionContextId("per-peer", "a", "u1")).not.toBe(resolveSessionContextId("per-peer", "a", "u2"));
    expect(resolveSessionContextId("per-channel-peer", "a", "u1")).not.toBe(resolveSessionContextId("per-channel-peer", "a", "u2"));
    expect(resolveSessionContextId("per-channel-peer", "a", "u1")).not.toBe(resolveSessionContextId("per-channel-peer", "b", "u1"));
    expect(resolveSessionContextId("global", "a", "u1")).toBe(resolveSessionContextId("global", "b", "u2"));
  });
});
