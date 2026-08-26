/**
 * Reads a Miki environment variable, preferring the conventional
 * all-uppercase name (MIKI_FOO) and falling back to the legacy
 * mixed-case name (Miki_FOO) that earlier rebrand passes produced.
 *
 * Every environment variable Miki ships as user-facing configuration
 * (see .env.example) should be read through this helper rather than
 * `process.env["Miki_FOO"]` directly, so that setting the variable the
 * way virtually every other tool expects (SCREAMING_SNAKE_CASE) actually
 * works. `canonicalName` must already be the MIKI_ prefixed, all-caps
 * form; the legacy alias is derived automatically.
 */
export function readMikiEnv(
  canonicalName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const direct = env[canonicalName];
  if (direct !== undefined) return direct;
  const legacyName = canonicalName.replace(/^MIKI_/, "Miki_");
  return legacyName === canonicalName ? undefined : env[legacyName];
}
