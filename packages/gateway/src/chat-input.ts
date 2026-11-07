import { CHAT_INPUT_LIMITS as LIMITS } from "@miki/config";

export type IncomingChatMessage = {
  type: string;
  id?: string;
  task_id?: string;
  session_id?: string;
  checkpoint_id?: string;
  last_sequence?: number;
  payload?: Record<string, unknown>;
};

export type ChatInputValidation =
  | { ok: true; value: IncomingChatMessage }
  | { ok: false; code: string; message: string };

const THINKING_MODES = new Set(["auto", "off", "low", "medium", "high"]);
const ATTACHMENT_TYPES = new Set(["image", "audio", "video", "file"]);
const TOP_LEVEL_KEYS = new Set(["type", "id", "task_id", "session_id", "checkpoint_id", "last_sequence", "payload"]);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const fail = (code: string, message: string): ChatInputValidation => ({ ok: false, code, message });

function validateAttachment(item: unknown): boolean {
  if (!isObject(item)) return false;
  if (Object.keys(item).some((key) => !["type", "url", "filename", "content_type"].includes(key))) return false;
  if (typeof item.type !== "string" || !ATTACHMENT_TYPES.has(item.type)) return false;
  if (typeof item.url !== "string" || !item.url.trim() || item.url.length > LIMITS.attachmentUrlCharacters) return false;
  if (item.filename !== undefined && (typeof item.filename !== "string" || item.filename.length > LIMITS.attachmentFilenameCharacters)) return false;
  if (item.content_type !== undefined && (typeof item.content_type !== "string" || item.content_type.length > LIMITS.contentTypeCharacters)) return false;
  return true;
}

function validateVoice(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = ["source", "provider", "language", "transcript", "durationMs", "latencyMs", "model", "transport"];
  if (Object.keys(value).some((key) => !keys.includes(key))) return false;
  if (!["microphone", "upload", "channel"].includes(String(value.source))) return false;
  if (!["whisper.cpp", "cloud"].includes(String(value.provider))) return false;
  if (typeof value.language !== "string" || value.language.length > 64) return false;
  if (typeof value.transcript !== "string" || value.transcript.length > LIMITS.textCharacters) return false;
  for (const key of ["durationMs", "latencyMs"] as const) {
    const number = value[key];
    if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 86_400_000)) return false;
  }
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.length > LIMITS.modelIdentifierCharacters)) return false;
  if (value.transport !== undefined && !["endpoint", "cli", "cloud"].includes(String(value.transport))) return false;
  return true;
}

function validateAudio(value: unknown): boolean {
  if (!isObject(value) || Object.keys(value).some((key) => !["data", "mimeType", "filename"].includes(key))) return false;
  if (typeof value.data !== "string" || !value.data || value.data.length > LIMITS.audioBase64Characters) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) return false;
  if (typeof value.mimeType !== "string" || value.mimeType.length > LIMITS.contentTypeCharacters || !/^audio\/[a-z0-9.+-]+$/i.test(value.mimeType)) return false;
  return value.filename === undefined || (typeof value.filename === "string" && value.filename.length <= LIMITS.attachmentFilenameCharacters);
}

/** Runtime schema for all WebSocket control and user-chat frames. */
export function validateIncomingChatMessage(input: unknown, frameBytes?: number): ChatInputValidation {
  if (frameBytes !== undefined && frameBytes > LIMITS.websocketPayloadBytes) return fail("payload_too_large", "WebSocket message exceeds the maximum payload size.");
  if (!isObject(input)) return fail("invalid_payload", "WebSocket message must be a JSON object.");
  if (Object.keys(input).some((key) => !TOP_LEVEL_KEYS.has(key))) return fail("invalid_payload", "WebSocket message contains unsupported fields.");
  if (typeof input.type !== "string") return fail("invalid_message_type", "WebSocket message type is required.");
  if (input.session_id !== undefined && (typeof input.session_id !== "string" || input.session_id.length > 128)) return fail("invalid_session_id", "session_id must be a string up to 128 characters.");

  const keysOnly = (allowed: readonly string[]) => Object.keys(input).every((key) => allowed.includes(key));
  if (input.type === "authenticate") {
    if (!keysOnly(["type", "session_id", "payload"]) || typeof input.session_id !== "string" || !input.session_id || input.session_id.length > 128) return fail("invalid_session_id", "Authentication requires a valid session_id.");
    if (input.payload !== undefined && (!isObject(input.payload) || Object.keys(input.payload).some((key) => key !== "resume_active") || (input.payload.resume_active !== undefined && typeof input.payload.resume_active !== "boolean"))) return fail("invalid_payload", "Authentication payload is invalid.");
    return { ok: true, value: input as IncomingChatMessage };
  }
  if (input.type === "resume") {
    if (!keysOnly(["type", "session_id", "checkpoint_id", "last_sequence"]) || typeof input.session_id !== "string" || !input.session_id || input.session_id.length > 128 || typeof input.checkpoint_id !== "string" || !input.checkpoint_id || input.checkpoint_id.length > 200 || typeof input.last_sequence !== "number" || !Number.isSafeInteger(input.last_sequence) || input.last_sequence < -1) return fail("invalid_resume", "Resume session, checkpoint and sequence are invalid.");
    return { ok: true, value: input as IncomingChatMessage };
  }
  if (input.type === "cancel_task") {
    if (!keysOnly(["type", "task_id"]) || typeof input.task_id !== "string" || !input.task_id || input.task_id.length > 200) return fail("invalid_task_id", "cancel_task requires a non-empty task_id no longer than 200 characters and no extra fields.");
    return { ok: true, value: input as IncomingChatMessage };
  }
  const isRetry = input.type === "message.retry";
  if (input.type !== "message.send" && !isRetry) return fail("unsupported_message_type", `Unsupported WebSocket message type: ${input.type.slice(0, 80)}`);
  if (!keysOnly(["type", "id", "payload"])) return fail("invalid_payload", "Chat message contains unsupported top-level fields.");
  if (input.id !== undefined && (typeof input.id !== "string" || !input.id || input.id.length > LIMITS.messageIdCharacters)) return fail("invalid_message_id", "Message id must be a non-empty string up to 128 characters.");
  if (!isObject(input.payload)) return fail("invalid_payload", "Chat payload must be an object.");
  const payload = input.payload;
  const allowedPayloadKeys = isRetry
    ? ["message_id", "prompt_message_id", "content", "thinking_mode", "attachments"]
    : ["content", "media", "attachments", "requested_model", "requested_model_index", "thinking_mode", "voice", "audio"];
  if (Object.keys(payload).some((key) => !allowedPayloadKeys.includes(key))) return fail("invalid_payload", "Chat payload contains unsupported fields for this message type.");
  if (isRetry) {
    if (typeof payload.message_id !== "string" || !payload.message_id || payload.message_id.length > LIMITS.messageIdCharacters) return fail("invalid_message_id", "Retry requires a valid message_id.");
    if (payload.prompt_message_id !== undefined && (typeof payload.prompt_message_id !== "string" || !payload.prompt_message_id || payload.prompt_message_id.length > LIMITS.messageIdCharacters)) return fail("invalid_message_id", "prompt_message_id must be a valid message identifier.");
    // The original prompt is included as a recovery copy if the first send was
    // rejected before persistence. Saved-message retries may omit this field.
    if (payload.content !== undefined && (typeof payload.content !== "string" || payload.content.length > LIMITS.textCharacters)) return fail("invalid_content", `Retry content must be text limited to ${LIMITS.textCharacters} characters.`);
  } else {
    if (typeof payload.content !== "string") return fail("invalid_content", "Message content must be text.");
    if (payload.content.length > LIMITS.textCharacters) return fail("invalid_content", `Message content is limited to ${LIMITS.textCharacters} characters.`);
  }
  if (payload.requested_model !== undefined && (typeof payload.requested_model !== "string" || !payload.requested_model.trim() || payload.requested_model.length > LIMITS.modelIdentifierCharacters || !/^[\p{L}\p{N}._:/@+-]+$/u.test(payload.requested_model))) return fail("invalid_model", "requested_model must be a valid model identifier.");
  if (payload.requested_model_index !== undefined && (typeof payload.requested_model_index !== "number" || !Number.isSafeInteger(payload.requested_model_index) || payload.requested_model_index < 1 || payload.requested_model_index > 1_000)) return fail("invalid_model_index", "requested_model_index must be an integer between 1 and 1000.");
  if (payload.thinking_mode !== undefined && (typeof payload.thinking_mode !== "string" || !THINKING_MODES.has(payload.thinking_mode))) return fail("invalid_thinking_mode", "Unsupported thinking mode.");
  if (payload.attachments !== undefined && (!Array.isArray(payload.attachments) || payload.attachments.length > LIMITS.attachmentCount || !payload.attachments.every(validateAttachment))) return fail("invalid_attachments", `Attachments must contain at most ${LIMITS.attachmentCount} valid items with URLs no longer than ${LIMITS.attachmentUrlCharacters} characters.`);
  if (payload.media !== undefined && (!Array.isArray(payload.media) || payload.media.length > LIMITS.attachmentCount || payload.media.some((url) => typeof url !== "string" || !url.trim() || url.length > LIMITS.attachmentUrlCharacters))) return fail("invalid_media", "media must be an array of valid bounded URLs.");
  const uniqueAttachmentUrls = new Set<string>([
    ...(Array.isArray(payload.attachments) ? payload.attachments.map((item) => (item as { url: string }).url) : []),
    ...(Array.isArray(payload.media) ? payload.media as string[] : []),
  ]);
  if (uniqueAttachmentUrls.size > LIMITS.attachmentCount) return fail("invalid_attachments", `A chat turn may contain at most ${LIMITS.attachmentCount} distinct attachment URLs.`);
  if (payload.voice !== undefined && !validateVoice(payload.voice)) return fail("invalid_voice", "Voice metadata is invalid.");
  if (payload.audio !== undefined && !validateAudio(payload.audio)) return fail("invalid_audio", "Audio payload is invalid or exceeds its limit.");
  if (payload.message_id !== undefined && (typeof payload.message_id !== "string" || !payload.message_id || payload.message_id.length > LIMITS.messageIdCharacters)) return fail("invalid_message_id", "message_id must be a valid identifier.");
  const hasAttachment = (Array.isArray(payload.attachments) && payload.attachments.length > 0) || (Array.isArray(payload.media) && payload.media.length > 0) || payload.audio !== undefined;
  if (!isRetry && !String(payload.content).trim() && !hasAttachment) return fail("empty_message", "Message content or an attachment is required.");
  return { ok: true, value: input as IncomingChatMessage };
}
