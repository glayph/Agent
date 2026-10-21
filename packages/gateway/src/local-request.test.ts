import {
  isLocalDirectRequest,
  isLoopbackAddress,
  isRemoteSetupAllowed,
} from "./local-request.js";

describe("isLoopbackAddress", () => {
  it("accepts IPv4 loopback, IPv6 loopback and the IPv4-mapped form", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::FFFF:127.0.0.1")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackAddress("128.0.0.1")).toBe(false);
    expect(isLoopbackAddress("::2")).toBe(false);
    expect(isLoopbackAddress("fe80::1")).toBe(false);
  });

  it("rejects look-alikes and malformed values", () => {
    expect(isLoopbackAddress("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackAddress("1270.0.0.1")).toBe(false);
    expect(isLoopbackAddress("127.0.0.256")).toBe(false);
    expect(isLoopbackAddress("127.0.0")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
  });
});

describe("isLocalDirectRequest", () => {
  it("allows a direct loopback connection with no forwarding headers", () => {
    expect(isLocalDirectRequest("127.0.0.1", "127.0.0.1", {})).toBe(true);
    expect(
      isLocalDirectRequest("::1", "::1", { host: "localhost:18800" }),
    ).toBe(true);
    expect(
      isLocalDirectRequest("::ffff:127.0.0.1", "::ffff:127.0.0.1", {}),
    ).toBe(true);
  });

  it("rejects a loopback connection that carries any forwarding header (a reverse proxy)", () => {
    for (const name of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-port",
      "x-real-ip",
      "forwarded",
      "via",
      "cf-connecting-ip",
    ]) {
      expect(
        isLocalDirectRequest("127.0.0.1", "127.0.0.1", {
          [name]: "203.0.113.9",
        }),
      ).toBe(false);
    }
  });

  it("treats a header that is present but empty as forwarding", () => {
    expect(
      isLocalDirectRequest("127.0.0.1", "127.0.0.1", { "x-forwarded-for": "" }),
    ).toBe(false);
  });

  it("ignores a header key whose value is undefined", () => {
    expect(
      isLocalDirectRequest("127.0.0.1", "127.0.0.1", {
        "x-forwarded-for": undefined,
      }),
    ).toBe(true);
  });

  it("rejects a connection from another machine", () => {
    expect(isLocalDirectRequest("203.0.113.9", "192.168.1.5", {})).toBe(false);
    expect(isLocalDirectRequest("192.168.1.9", "192.168.1.5", {})).toBe(false);
    expect(isLocalDirectRequest("10.0.0.5", "127.0.0.1", {})).toBe(false);
  });

  it("allows the machine browsing to its own LAN address (remote equals local)", () => {
    expect(isLocalDirectRequest("192.168.1.5", "192.168.1.5", {})).toBe(true);
    expect(isLocalDirectRequest("::ffff:192.168.1.5", "192.168.1.5", {})).toBe(
      true,
    );
    expect(
      isLocalDirectRequest("192.168.1.5", "192.168.1.5", {
        "x-forwarded-for": "203.0.113.9",
      }),
    ).toBe(false);
  });

  it("never treats two missing addresses as equal", () => {
    expect(isLocalDirectRequest(undefined, undefined, {})).toBe(false);
    expect(isLocalDirectRequest("", "", {})).toBe(false);
    expect(isLocalDirectRequest("203.0.113.9", undefined, {})).toBe(false);
  });
});

describe("isRemoteSetupAllowed", () => {
  it("is on only for an explicit 1 or true", () => {
    expect(isRemoteSetupAllowed("1")).toBe(true);
    expect(isRemoteSetupAllowed("true")).toBe(true);
    expect(isRemoteSetupAllowed(" TRUE ")).toBe(true);
  });

  it("is off by default and for anything else", () => {
    expect(isRemoteSetupAllowed(undefined)).toBe(false);
    expect(isRemoteSetupAllowed("")).toBe(false);
    expect(isRemoteSetupAllowed("0")).toBe(false);
    expect(isRemoteSetupAllowed("false")).toBe(false);
    expect(isRemoteSetupAllowed("yes")).toBe(false);
  });
});
