/**
 * The dashboard session cookie, built in one place so login, setup, the status refresh and the
 * launcher settings save never disagree about its attributes.
 *
 * SameSite=None; Secure is needed for the cross-site HTTPS Preview iframe. Plain HTTP (for example a LAN
 * address) cannot store a Secure cookie, so there the cookie is SameSite=Lax without Secure.
 */
export function sessionCookie(token: string, maxAgeSeconds?: number, secure = true): string {
  const sameSite = secure ? "SameSite=None; Secure" : "SameSite=Lax"
  const maxAge = maxAgeSeconds ? `; Max-Age=${maxAgeSeconds}` : ""
  return `miki_session=${token}; Path=/; HttpOnly; ${sameSite}${maxAge}`
}
