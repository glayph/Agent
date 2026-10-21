import { isWsOriginAllowed, parseAllowedOrigins } from "./ws-origin.js";

describe("isWsOriginAllowed", () => {
  const host = "127.0.0.1:18800";

  it("allows non-browser clients that send no Origin header", () => {
    expect(isWsOriginAllowed(undefined, host)).toBe(true);
    expect(isWsOriginAllowed(undefined, undefined)).toBe(true);
  });

  it("allows a page served by this gateway (Origin host equals Host header)", () => {
    expect(isWsOriginAllowed("http://127.0.0.1:18800", host)).toBe(true);
    expect(isWsOriginAllowed("http://localhost:18800", "localhost:18800")).toBe(
      true,
    );
    expect(isWsOriginAllowed("http://[::1]:18800", "[::1]:18800")).toBe(true);
    expect(
      isWsOriginAllowed("https://miki.example.com", "miki.example.com"),
    ).toBe(true);
  });

  it("compares hosts case-insensitively", () => {
    expect(
      isWsOriginAllowed("https://Miki.Example.com", "miki.example.COM"),
    ).toBe(true);
  });

  it("blocks a foreign website", () => {
    expect(isWsOriginAllowed("https://evil.example", host)).toBe(false);
    expect(isWsOriginAllowed("http://evil.example:18800", host)).toBe(false);
  });

  it("blocks another origin on a different port or a different spelling of the same machine", () => {
    expect(isWsOriginAllowed("http://127.0.0.1:3000", host)).toBe(false);
    expect(isWsOriginAllowed("http://localhost:18800", host)).toBe(false);
  });

  it("blocks look-alike hosts", () => {
    expect(isWsOriginAllowed("http://127.0.0.1:18800.evil.example", host)).toBe(
      false,
    );
    expect(isWsOriginAllowed("http://evil.example/127.0.0.1:18800", host)).toBe(
      false,
    );
    expect(isWsOriginAllowed("http://user@127.0.0.1:18800", host)).toBe(false);
    expect(isWsOriginAllowed("http://127.0.0.1:18800/", host)).toBe(false);
  });

  it("blocks opaque, empty, malformed and non-http origins", () => {
    expect(isWsOriginAllowed("null", host)).toBe(false);
    expect(isWsOriginAllowed("", host)).toBe(false);
    expect(isWsOriginAllowed("not a url", host)).toBe(false);
    expect(isWsOriginAllowed("file://", host)).toBe(false);
    expect(isWsOriginAllowed("chrome-extension://abcdef", host)).toBe(false);
  });

  it("blocks any Origin when the Host header is missing", () => {
    expect(isWsOriginAllowed("http://127.0.0.1:18800", undefined)).toBe(false);
    expect(isWsOriginAllowed("http://127.0.0.1:18800", "")).toBe(false);
  });

  it("allows an origin listed in the allow-list, and only that exact origin", () => {
    const allowed = parseAllowedOrigins("https://miki.example.com:8443");
    expect(
      isWsOriginAllowed(
        "https://miki.example.com:8443",
        "127.0.0.1:18800",
        allowed,
      ),
    ).toBe(true);
    expect(
      isWsOriginAllowed("https://miki.example.com", "127.0.0.1:18800", allowed),
    ).toBe(false);
    expect(
      isWsOriginAllowed(
        "http://miki.example.com:8443",
        "127.0.0.1:18800",
        allowed,
      ),
    ).toBe(false);
    expect(
      isWsOriginAllowed("https://evil.example", "127.0.0.1:18800", allowed),
    ).toBe(false);
  });

  it("allows the opaque origin only when `null` is listed explicitly", () => {
    expect(isWsOriginAllowed("null", host, parseAllowedOrigins("null"))).toBe(
      true,
    );
    expect(
      isWsOriginAllowed("null", host, parseAllowedOrigins("https://a.example")),
    ).toBe(false);
  });
});

describe("parseAllowedOrigins", () => {
  it("returns nothing for empty input", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(null)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins(" , ,, ")).toEqual([]);
  });

  it("normalizes entries: trims, lowercases, drops path and trailing slash", () => {
    expect(
      parseAllowedOrigins(
        " HTTPS://Miki.Example.com/ , http://localhost:5173/app ",
      ),
    ).toEqual(["https://miki.example.com", "http://localhost:5173"]);
  });

  it("never lets a wildcard switch the check off", () => {
    expect(parseAllowedOrigins("*")).toEqual([]);
    expect(parseAllowedOrigins("https://*.example.com")).toEqual([]);
    expect(
      isWsOriginAllowed(
        "https://evil.example",
        "127.0.0.1:18800",
        parseAllowedOrigins("*"),
      ),
    ).toBe(false);
  });

  it("ignores junk and non-http schemes", () => {
    expect(
      parseAllowedOrigins("nonsense, ftp://example.com, javascript:alert(1)"),
    ).toEqual([]);
  });
});
