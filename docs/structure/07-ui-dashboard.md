# UI Dashboard

The Web UI architecture is:

```text
React frontend → Node Gateway → Core / Agent / Memory / Providers
```

`packages/gateway` is the primary Web UI backend. It owns the dashboard REST API, authentication session, gateway lifecycle contract, static frontend serving, and `/miki/ws`.

`packages/ui/backend/stub_main.go` is a compatibility/static-serving stub only. It is not the primary dashboard backend and must not be launched as the Web UI API server.

The legacy Go routes under `packages/ui/backend/api/` are compatibility code behind the `legacy_backend` build tag and are not part of the primary runtime.

In development, Vite proxies `/api`, `/gateway`, and `/miki/ws` to the active Node Gateway.
