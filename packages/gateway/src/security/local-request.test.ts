import {
  isLocalDirectRequest,
  isLoopbackAddress,
  isRemoteSetupAllowed,
  isTrustedLocalHost,
  parseAllowedHosts,
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

describe("isTrustedLocalHost (DNS rebinding)", () => {
  const machine = ["miki-box", "miki-box.local"];

  it("accepts names an attacker cannot rebind", () => {
    for (const host of [
      "localhost",
      "localhost:18800",
      "LOCALHOST.:18800",
      "app.localhost:18800",
      "127.0.0.1:18800",
      "[::1]:18800",
      "192.168.1.20:18800",
      "miki-box:18800",
      "miki-box.local",
    ]) {
      expect(isTrustedLocalHost(host, [], machine)).toBe(true);
    }
  });

  it("rejects an attacker-controlled host name pointed at 127.0.0.1", () => {
    for (const host of [
      "evil.example",
      "evil.example:18800",
      "localhost.evil.example",
      "127.0.0.1.evil.example",
      "evil.example@127.0.0.1",
      "127.0.0.1/evil",
      "",
      "not a host",
    ]) {
      expect(isTrustedLocalHost(host, [], machine)).toBe(false);
    }
    expect(isTrustedLocalHost(["localhost", "evil.example"], [], machine)).toBe(false);
  });

  it("accepts a missing Host header (non-browser client)", () => {
    expect(isTrustedLocalHost(undefined, [], machine)).toBe(true);
  });

  it("accepts owner-listed names only", () => {
    expect(isTrustedLocalHost("miki.lan:18800", [], machine)).toBe(false);
    expect(isTrustedLocalHost("miki.lan:18800", ["miki.lan"], machine)).toBe(true);
  });

  it("parses MIKI_ALLOWED_HOSTS and ignores wildcards and junk", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("Miki.LAN, miki2.lan:8443, *, *.evil.example, a/b, ")).toEqual([
      "miki.lan",
      "miki2.lan",
    ]);
  });
});

describe("isLocalDirectRequest with a rebinding Host header", () => {
  it("rejects loopback requests whose Host is an attacker's name", () => {
    expect(
      isLocalDirectRequest("127.0.0.1", "127.0.0.1", { host: "evil.example:18800" }),
    ).toBe(false);
  });

  it("accepts it again when the owner lists that name", () => {
    expect(
      isLocalDirectRequest(
        "127.0.0.1",
        "127.0.0.1",
        { host: "miki.lan:18800" },
        { allowedHosts: ["miki.lan"] },
      ),
    ).toBe(true);
  });

  it("still accepts the machine's own LAN address as Host", () => {
    expect(
      isLocalDirectRequest("192.168.1.20", "192.168.1.20", { host: "192.168.1.20:18800" }),
    ).toBe(true);
  });
});
