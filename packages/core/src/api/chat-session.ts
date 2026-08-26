export const SINGLE_CHAT_SESSION_ID = "miki-main-chat";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export function normalizeChatSessionId(
  value: unknown,
  fallback: string = SINGLE_CHAT_SESSION_ID,
): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return SESSION_ID_PATTERN.test(normalized) ? normalized : fallback;
}
