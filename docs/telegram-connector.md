# Telegram connector

Miki's built-in Telegram connector runs independently of the browser UI. It supports long polling by default and secret-verified webhooks when `mode` is set to `webhook`.

## Secrets

Set the bot token only in the process environment or the configured secret vault:

```bash
export TELEGRAM_BOT_TOKEN='...'
export ENABLE_TELEGRAM=true
```

The runtime deliberately ignores `channels.telegram.token` and other ordinary config fields. The token is never read from source code or prompt-controlled configuration. Webhook deployments may additionally set `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_WEBHOOK_URL`.

## Runtime settings

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "settings": {
        "mode": "polling",
        "allow_from": ["123456789"],
        "rate_limit_per_minute": 30,
        "typing": true,
        "streaming": { "enabled": false }
      }
    }
  }
}
```

For webhook mode, set `mode` to `webhook`, configure `TELEGRAM_WEBHOOK_URL` to the public `/webhooks/telegram` URL, and optionally set `TELEGRAM_WEBHOOK_SECRET`. Telegram updates are accepted at `POST /webhooks/telegram`; the secret header is verified before dispatch.

Each accepted update is persisted in `telegram-state.db` under the runtime data directory. The store provides durable duplicate-update protection, sender rate limiting, delivery-attempt audit records, and failed-update reclamation. Replies are retried up to three times with exponential spacing and use Telegram reply parameters to remain threaded to the inbound message.

Text, voice/audio, and photo updates are supported. Photo file links are passed to the agent as image attachments; voice/audio is routed through the existing voice input path. All Telegram turns use the single `miki-main-chat` canonical session, while Telegram chat IDs remain only in the outbound reply route.
