/** Shared chat input limits consumed by the browser client and gateway. */
export const CHAT_INPUT_LIMITS = Object.freeze({
  textCharacters: 32_000,
  attachmentCount: 16,
  attachmentUrlCharacters: 8_192,
  attachmentFilenameCharacters: 255,
  contentTypeCharacters: 160,
  modelIdentifierCharacters: 200,
  messageIdCharacters: 128,
  websocketPayloadBytes: 1_048_576,
  audioBase64Characters: 900_000,
});
