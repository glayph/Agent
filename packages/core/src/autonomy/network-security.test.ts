import { isPrivateOrReservedIp, validateNetworkUrl } from "./network-security.js";

describe("autonomous network security", () => {
  it("recognizes private and reserved addresses", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.10.10.10")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.10")).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("::1")).toBe(true);
  });

  it("blocks direct private network URL access", async () => {
    await expect(validateNetworkUrl("http://127.0.0.1:8080/health")).rejects.toThrow(/private or reserved/i);
    await expect(validateNetworkUrl("http://10.0.0.1/")).rejects.toThrow(/private or reserved/i);
  });
});
