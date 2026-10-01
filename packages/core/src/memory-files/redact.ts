/**
 * Memory files are plain text that get re-injected into prompts and may be
 * synced or shared, so credentials must never be written into them.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED:api-key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED:api-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[REDACTED:token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:jwt]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]"],
  [
    /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|পাসওয়ার্ড)\b(\s*(?:[:=]|is|হলো|হল)\s*)(["']?)(?!\[REDACTED)[^\s"',;]{4,}\3/gi,
    "$1$2[REDACTED]",
  ],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
