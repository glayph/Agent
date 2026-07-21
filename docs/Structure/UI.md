# ui — Dashboard

React frontend (Vite + TanStack Router + Tailwind) and Go backend (systray, launcher auth).

## Frontend (React + TypeScript)

```
ui/frontend/
└── src/
    ├── main.tsx                     React entry point
    ├── app-providers.tsx            Global providers (QueryClient, Router, Theme, i18n)
    ├── index.css                    Global styles (Tailwind CSS)
    ├── routeTree.gen.ts             Auto-generated route tree from TanStack Router
    ├── api/                         REST API client modules
    │   ├── http.ts                  Base HTTP client with auth and error handling
    │   ├── sessions.ts              Chat session API
    │   ├── models.ts                Model management API
    │   ├── channels.ts              Channel configuration API
    │   ├── tools.ts                 Tool management API
    │   ├── skills.ts                Skill management API
    │   ├── files.ts                 File system API
    │   ├── gateway.ts               Gateway status API
    │   ├── litellm.ts               LiteLLM proxy API
    │   ├── system.ts                System health API
    │   ├── agent-runs.ts            Agent run history API
    │   ├── goals.ts                 Goal tracking API
    │   ├── pico.ts                  Pico channels API
    │   ├── launcher-auth.ts         Launcher authentication API
    │   ├── oauth.ts                 OAuth flow API
    │   └── safety.ts                Safety/backup API
    ├── assets/                      Static assets
    │   ├── launcher-wallpaper.webp
    │   └── launcher-wallpaper-mobile.webp
    ├── components/                  UI component library
    │   ├── ui/                      Reusable UI primitives (buttons, inputs, dialogs, etc.)
    │   ├── chat/                    Chat interface components
    │   ├── config/                  Configuration forms
    │   ├── models/                  Model management UI
    │   ├── channels/                Channel configuration
    │   ├── agent/                   Agent management views
    │   ├── credentials/             Credential management
    │   ├── drive/                   File system browser
    │   ├── health/                  Health dashboard
    │   ├── home/                    Home page widgets
    │   ├── logs/                    Log viewer
    │   ├── app-layout.tsx           Main application layout
    │   ├── app-sidebar.tsx          Sidebar navigation
    │   └── ...
    ├── features/chat/               Chat protocol, controller, WebSocket handler
    ├── hooks/                       Custom React hooks (16 hooks)
    │   ├── use-gateway.ts           Gateway connection state
    │   ├── use-chat-models.ts       Model selection
    │   ├── use-theme.ts             Theme toggling
    │   ├── use-mobile.ts            Responsive detection
    │   ├── use-copy-to-clipboard.ts
    │   ├── use-session-history.ts
    │   └── ...
    ├── i18n/                        Internationalization
    │   ├── index.ts                 i18n setup
    │   └── locales/                 Translation files (en, zh, pt-br)
    ├── lib/                         Utility functions
    │   ├── format.ts                Formatting helpers
    │   ├── ansi-log.ts              ANSI log parsing
    │   ├── clipboard.ts
    │   └── utils.ts
    ├── routes/                      TanStack Router route definitions
    │   ├── __root.tsx               Root layout with sidebar
    │   ├── index.tsx                Home page
    │   ├── config.tsx               Configuration page
    │   ├── config.raw.tsx           Raw config viewer
    │   ├── models.tsx               Model management
    │   ├── health.tsx               Health dashboard
    │   ├── logs.tsx                 Log viewer
    │   ├── drive.tsx                File browser
    │   ├── credentials.tsx          Credential management
    │   ├── agents.tsx               Agent management
    │   ├── agents.*.tsx             Agent detail pages
    │   ├── launcher-login.tsx       Launcher login
    │   └── launcher-setup.tsx       Initial setup wizard
    ├── store/                       Jotai state management atoms
    ├── theme/                       CSS theme variables
    └── routeTree.gen.ts             Auto-generated routing
```

## Backend (Go)

```
ui/backend/
├── main.go                         Application entry point
├── stub_main.go                    Stub build entry (non-legacy)
├── embed.go                        File embedding for the built frontend
├── app_runtime.go                  Runtime lifecycle management
├── systray.go                      System tray icon and menu
├── systray_stub_nocgo.go           Systray stub for non-CGO builds
├── systray_icon_nonwindows.go      Non-Windows systray icon
├── i18n.go                         Internationalization
├── icon.ico                        Application icon
├── winres/                         Windows resources (manifest, icons)
├── api/                            Go API handlers
├── dashboardauth/                  Dashboard authentication
├── launcherconfig/                 Launcher configuration
├── middleware/                      HTTP middleware (auth, cors, etc.)
├── dist/                           Embedded UI build output
└── model/                          Data models
```
