import { describe, expect, it } from "vitest";
import { CHAT_INPUT_LIMITS } from "@miki/config";
import { validateIncomingChatMessage } from "./chat-input.js";

describe("validateIncomingChatMessage", () => {
  it("accepts ordinary text and the supported thinking modes", () => {
    expect(validateIncomingChatMessage({ type: "message.send", id: "m-1", payload: { content: "হ্যালো", thinking_mode: "auto" } }).ok).toBe(true);
  });

  it("rejects empty, whitespace-only, and oversized messages", () => {
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "   " } })).toMatchObject({ ok: false, code: "empty_message" });
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "x".repeat(CHAT_INPUT_LIMITS.textCharacters + 1) } })).toMatchObject({ ok: false, code: "invalid_content" });
  });

  it("accepts attachment-only turns and rejects malformed or excessive attachments", () => {
    const attachment = { type: "file", url: "/api/chat-media?path=doc.pdf", filename: "doc.pdf", content_type: "application/pdf" };
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "", attachments: [attachment], media: [attachment.url] } }).ok).toBe(true);
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "open", attachments: [{ url: "/file" }] } })).toMatchObject({ ok: false, code: "invalid_attachments" });
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "open", attachments: Array(17).fill(attachment) } })).toMatchObject({ ok: false, code: "invalid_attachments" });
  });

  it("rejects invalid model identifiers and unsupported thinking modes", () => {
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "hi", requested_model: { id: "model" } } })).toMatchObject({ ok: false, code: "invalid_model" });
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "hi", requested_model: "bad model name" } })).toMatchObject({ ok: false, code: "invalid_model" });
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "hi", thinking_mode: "turbo" } })).toMatchObject({ ok: false, code: "invalid_thinking_mode" });
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "hi", requested_model_index: 1.5 } })).toMatchObject({ ok: false, code: "invalid_model_index" });
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "hi", requested_model_index: 0 } })).toMatchObject({ ok: false, code: "invalid_model_index" });
  });

  it("rejects malformed JSON payload shapes without coercing objects to strings", () => {
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: { text: "hello" } } })).toMatchObject({ ok: false, code: "invalid_content" });
    expect(validateIncomingChatMessage(["message.send", "hello"])).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateIncomingChatMessage({ type: "message.send", unexpected: true, payload: { content: "hello" } })).toMatchObject({ ok: false, code: "invalid_payload" });
  });

  it("keeps message retry frames compatible and accepts a bounded recovery copy of the prompt", () => {
    expect(validateIncomingChatMessage({ type: "message.retry", id: "msg-1", payload: { message_id: "msg-1", thinking_mode: "auto" } }).ok).toBe(true);
    expect(validateIncomingChatMessage({ type: "message.retry", id: "retry-1", payload: { message_id: "msg-1", prompt_message_id: "user-msg-1", content: "original prompt", thinking_mode: "auto" } }).ok).toBe(true);
    expect(validateIncomingChatMessage({ type: "message.retry", payload: { message_id: "msg-1", content: "x".repeat(CHAT_INPUT_LIMITS.textCharacters + 1) } })).toMatchObject({ ok: false, code: "invalid_content" });
    expect(validateIncomingChatMessage({ type: "message.retry", payload: { message_id: { id: "x" } } })).toMatchObject({ ok: false, code: "invalid_message_id" });
  });

  it("bounds attachment URLs, audio metadata and WebSocket frames", () => {
    const attachment = { type: "image", url: `/${"x".repeat(CHAT_INPUT_LIMITS.attachmentUrlCharacters)}` };
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "x", attachments: [attachment] } })).toMatchObject({ ok: false, code: "invalid_attachments" });
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "x", audio: { data: "not base64", mimeType: "audio/wav" } } })).toMatchObject({ ok: false, code: "invalid_audio" });
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "x" } }, CHAT_INPUT_LIMITS.websocketPayloadBytes + 1)).toMatchObject({ ok: false, code: "payload_too_large" });
  });

  it("uses identical validation for HTTP edit bodies and WebSocket chat frames", () => {
    const httpBody = { content: "hello", attachments: [{ type: "file", url: "/uploads/a.txt" }] };
    const websocket = { type: "message.send", payload: httpBody };
    expect(validateIncomingChatMessage(websocket)).toMatchObject({ ok: true });
    const invalidHttpBody = { content: "x".repeat(CHAT_INPUT_LIMITS.textCharacters + 1) };
    expect(validateIncomingChatMessage({ type: "message.send", payload: invalidHttpBody })).toMatchObject({ ok: false, code: "invalid_content" });
  });

  it("caps the combined attachment and media URL set", () => {
    const attachments = Array.from({ length: 16 }, (_, index) => ({ type: "file", url: `/a-${index}` }));
    const media = ["/a-0", ...Array.from({ length: 15 }, (_, index) => `/m-${index}`)];
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "open", attachments, media } })).toMatchObject({ ok: false, code: "invalid_attachments" });
    // A legacy media mirror of the same attachment does not count twice.
    expect(validateIncomingChatMessage({ type: "message.send", payload: { content: "open", attachments: [attachments[0]], media: ["/a-0"] } }).ok).toBe(true);
  });

  it("validates control-message schemas", () => {
    expect(validateIncomingChatMessage({ type: "resume", session_id: "session-1", checkpoint_id: "checkpoint-1", last_sequence: 0 }).ok).toBe(true);
    expect(validateIncomingChatMessage({ type: "resume", checkpoint_id: "checkpoint-1", last_sequence: 0 })).toMatchObject({ ok: false, code: "invalid_resume" });
    expect(validateIncomingChatMessage({ type: "resume", session_id: "session-1", checkpoint_id: "checkpoint-1", last_sequence: 0, payload: {} })).toMatchObject({ ok: false, code: "invalid_resume" });
    expect(validateIncomingChatMessage({ type: "authenticate", session_id: "session-1", payload: { resume_active: true } }).ok).toBe(true);
    expect(validateIncomingChatMessage({ type: "authenticate", payload: {} })).toMatchObject({ ok: false, code: "invalid_session_id" });
    expect(validateIncomingChatMessage({ type: "cancel_task", task_id: "run-1" }).ok).toBe(true);
    expect(validateIncomingChatMessage({ type: "cancel_task", task_id: {} })).toMatchObject({ ok: false, code: "invalid_task_id" });
    expect(validateIncomingChatMessage({ type: "cancel_task", task_id: "run-1", payload: {} })).toMatchObject({ ok: false, code: "invalid_task_id" });
  });
});
