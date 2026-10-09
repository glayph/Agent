/** Default title every new chat gets before it has been named. */
export const DEFAULT_CHAT_TITLE = "Miki chat";

/**
 * Names a new chat after what the user asked for, so the chat list answers
 * "what did I start, and for what purpose" at a glance. Returns "" when the
 * message has no usable text (for example attachments only), in which case the
 * default title is kept.
 */
export function titleFromMessage(text: string, maxLength = 60): string {
  const firstLine = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  const flat = firstLine
    .replace(/^[#>*\-\s]+/, "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length === 0) return "";
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // Cut at a word boundary when that does not throw away most of the title.
  const base = lastSpace >= maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}
