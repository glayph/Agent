# Release Checklist

[README](README.md) | [Documentation](Documentation.md) | [Feature Notes](feature.md) | [Troubleshooting Matrix](TROUBLESHOOTING_MATRIX.md)

Use this checklist before publishing, packaging, or handing off an Hiro
Hiro build.

## Required Gates

Run from the repository root:

```bash
npm run lint
npm run verify
npm run build
npm run pack:check
npm run audit:agent
npm run smoke:gateway
npm run smoke:channels-ui
npm run smoke:plugins:packaged
npm audit --omit=dev
```

`npm run verify:release` runs verify, build, package checks, agent audit, and
gateway/channel/plugin smoke checks. Run the production dependency audit after
it.

## Package Integrity

- `dist/runtime` has been regenerated from source.
- `packages/core/dist/api/index.js` exists.
- `packages/gateway/dist/index.js` exists.
- `packages/config/dist/index.js` exists.
- `packages/installer/dist/index.js` exists.
- `packages/skills/dist/index.js` exists.
- `packages/ui/frontend/dist/index.html` exists.
- `packages/ui/backend/dist/bin/*` exists.
- `dist/runtime/bin/Hiro-cli*` exists.
- `dist/runtime/runtime-loader.mjs` exists.
- `npm run pack:check` passes.

## Runtime Readiness

- `npm start` launches the CLI and gateway.
- Dashboard opens at `http://127.0.0.1:18800/`.
- `GET /gateway/health` reports healthy gateway state.
- `GET /api/health` and `GET /api/status` are reachable through the gateway.
- `GET /api/enhancements/health/full` returns a full health report.
- Pico/Web chat works through `/pico/ws`.
- MCP is reachable only when `ENABLE_MCP=true` and a strong `API_KEY_SECRET`
  is configured.
- Shutdown drains HTTP/WebSocket connections and terminates child processes.

## Security Readiness

- `.env` is not committed with real secrets.
- `npm run sanitize:local-data` has been run before sharing a local checkout.
- Doctor secret scan reports no likely leaks.
- `LITELLM_MASTER_KEY` is set or safely generated for local use.
- `ENABLE_API_KEY_AUTH=true`.
- `API_KEY_SECRET` is strong when API key auth or MCP is enabled.
- `Hiro_ALLOWED_ORIGINS` is limited to trusted origins.
- Dashboard password setup and login work.

## Config Readiness

- `config/agent.yaml` validates.
- `config/litellm.yaml` contains the intended model list.
- `config/tools.yaml` contains intended tool settings.
- The default model exists in the configured provider/model list.
- Workspace paths match the deployment machine.
- Channels are either fully configured or intentionally disabled.

## Channel Readiness

- `npm run smoke:channels-ui` passes.
- Probes return `ready`, `needs_config`, `degraded`, or explicit errors.
- Webhook URLs and provider dashboards are configured where required.
- Credentials are present only for enabled channels.
- Feishu/Lark, DingTalk, QQ, LINE, and WhatsApp token/signature settings are
  ready before public use.

## Plugin Ecosystem Readiness

- `npm run smoke:plugins` passes against an isolated workspace.
- `npm run smoke:plugins:packaged` passes after `npm run build` and validates
  plugin runtime behavior from `dist/runtime`.
- Plugin marketplace readiness reports installed contracts as publishable only
  when metadata, entrypoints, and runtime policy are complete.
- Plugin tool execution writes audit evidence without recording payload values
  or secret canaries.
- Plugin channel and provider catalogs expose marketplace contracts through the
  gateway without requiring external registry access.

## Final Local Checks

```bash
npm run doctor -- --json --skip-external --migrations --secret-scan
npm run audit:agent
git status --short
```

Only intended source, config, and documentation changes should remain.
