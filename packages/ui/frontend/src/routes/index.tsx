import { createFileRoute } from "@tanstack/react-router"

// Web UI chat re-enabled 2026-08-12 as Miki's primary chat interface
// (Live Agent work page). Connected platforms (Telegram, Discord,
// WhatsApp, etc) remain fully supported in parallel - all share the same
// universal session/history. ChatDisabledPage is left fully intact on
// disk (not deleted); to disable Web UI chat again, swap the
// import/component below back to ChatDisabledPage (and flip
// WEB_UI_CHAT_DISABLED to true in packages/core/src/api/index.ts).
import { ChatPage } from "@/pages/chat-page"

// import { ChatDisabledPage } from "@/pages/chat-disabled-page"

export const Route = createFileRoute("/")({
  component: ChatPage,
})
