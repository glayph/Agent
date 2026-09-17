/**
 * Miki is one continuous agent, not a per-channel chatbot. It does not
 * partition memory by which app a message arrived from (Telegram vs
 * Discord vs WhatsApp vs the scheduler, etc.) - there is exactly one
 * ongoing conversation/session, so Miki has the same continuous memory
 * regardless of which connected platform is being used to talk to it.
 *
 * Every channel adapter, and every self-scheduled task created through the
 * agent, must pass this constant as the sessionId into
 * `collectAgentResponse` / `runAgentLoop`. Do not derive per-chat or
 * per-user sessionIds - `AgentOrchestrator._messageHistory` is keyed by
 * sessionId purely as a generic map; by always using the same key, it
 * naturally becomes a single global history instead of per-channel silos.
 *
 * Reply routing (which chat/user/channel to send the response back to) is
 * unrelated to this and must keep using the platform's own identifiers
 * (chatId, channelId, from, etc.) - only the *memory* session is unified.
 *
 * What context actually gets read/loaded into the model for a given turn
 * is the responsibility of the memory subsystem (context-window
 * read/retrieval algorithm), not of sessionId partitioning.
 */
export const UNIVERSAL_SESSION_ID = "miki-universal";
