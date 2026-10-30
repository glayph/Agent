import { isPrivateOrReservedIp, validateNetworkUrl } from "./network-security.js";

describe("autonomous network security without built-in restrictions", () => {
  it("allows loopback and private addresses by default", async () => {
    await expect(validateNetworkUrl("http://127.0.0.1:8080/health")).resolves.toBeInstanceOf(URL);
    await expect(validateNetworkUrl("http://10.0.0.1/")).resolves.toBeInstanceOf(URL);
  });

  it("still refuses non-web schemes", async () => {
    await expect(validateNetworkUrl("file:///etc/passwd")).rejects.toThrow(/http/i);
  });

  it("enforces an allowlist only when one is supplied", async () => {
    await expect(
      validateNetworkUrl("https://example.com/", { allowedDomains: ["example.org"] }),
    ).rejects.toThrow(/allowlist/);
  });

  it("blocks localhost and private ranges only when explicitly turned off", async () => {
    await expect(validateNetworkUrl("http://localhost:8080/", { allowLocalhost: false })).rejects.toThrow(/localhost/i);
    await expect(validateNetworkUrl("http://10.0.0.1/", { allowPrivateNetworks: false })).rejects.toThrow(
      /private or reserved/i,
    );
  });

  it("keeps the private-address helper working", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
  });

  it("blocks private IPv4 addresses embedded in IPv4-mapped IPv6", () => {
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrReservedIp("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:808:808")).toBe(false);
  });

  it("rejects an IPv4-mapped IPv6 loopback URL when private networks are blocked", async () => {
    await expect(
      validateNetworkUrl("http://[::ffff:7f00:1]/", { allowPrivateNetworks: false }),
    ).rejects.toThrow(/private or reserved/i);
  });
});
