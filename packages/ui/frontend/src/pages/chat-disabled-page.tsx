import { IconMessageOff, IconPlugConnected } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"

/**
 * Placeholder shown at the app's root route while Web UI chat is disabled
 * (see WEB_UI_CHAT_DISABLED in packages/core/src/api/index.ts). Miki is
 * only chatted with through a connected platform (Telegram, Discord,
 * WhatsApp, Slack, Feishu, DingTalk, Line, QQ, Matrix, IRC, MQTT, OneBot).
 *
 * This does NOT delete the chat feature - chat-page.tsx and every
 * component under features/chat/ are left fully intact. To re-enable Web
 * UI chat: point routes/index.tsx's `component` back at `ChatPage`, and
 * flip `WEB_UI_CHAT_DISABLED` back to `false` on the backend.
 */
export function ChatDisabledPage() {
  return (
    <div className="animate-fade-in mx-auto flex max-w-2xl flex-col items-center gap-4 p-6 pt-24 text-center">
      <div className="bg-muted flex size-14 items-center justify-center rounded-full">
        <IconMessageOff size={28} className="text-muted-foreground" />
      </div>
      <h2 className="text-xl font-bold tracking-tight">
        Web UI chat is disabled
      </h2>
      <p className="text-muted-foreground text-sm">
        Miki isn&apos;t chatted with from this dashboard. Talk to Miki through
        one of your connected platforms instead - Telegram, Discord, WhatsApp,
        Slack, and others all share the same conversation with Miki.
      </p>
      <Link
        to="/channels"
        className="border-border hover:bg-muted mt-2 inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors"
      >
        <IconPlugConnected size={16} />
        Manage connected platforms
      </Link>
    </div>
  )
}
