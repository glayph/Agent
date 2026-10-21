import { describe, expect, it } from "vitest";
import { sessionCookie } from "./session-cookie.js";

describe("dashboard session cookie", () => {
  it("is SameSite=None; Secure for HTTPS, so the cross-site Preview iframe keeps the session", () => {
    expect(sessionCookie("tok")).toBe("miki_session=tok; Path=/; HttpOnly; SameSite=None; Secure");
    expect(sessionCookie("tok", undefined, true)).toBe("miki_session=tok; Path=/; HttpOnly; SameSite=None; Secure");
  });

  it("is SameSite=Lax without Secure over plain HTTP, so a LAN browser keeps it", () => {
    expect(sessionCookie("tok", undefined, false)).toBe("miki_session=tok; Path=/; HttpOnly; SameSite=Lax");
  });

  it("adds Max-Age only when a timeout is set", () => {
    expect(sessionCookie("tok", 1800, true)).toBe("miki_session=tok; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=1800");
    expect(sessionCookie("tok", 1800, false)).toBe("miki_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800");
    expect(sessionCookie("tok", 0, true)).toBe("miki_session=tok; Path=/; HttpOnly; SameSite=None; Secure");
  });
});
