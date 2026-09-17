# 07 — packages/ui (Web Dashboard)

Operator-facing single-session Chat UI and management dashboard.

```
packages/ui/
├── README.md
├── appearance.css
├── xAgent-launcher.png          # Launcher icon asset
├── miki-backend                 # Built Go backend binary (platform specific)
├── backend/                     # Go backend sources
│   ├── api/
│   ├── dashboardauth/           # Dashboard authentication (password 12345678 default)
│   ├── launcherconfig/
│   ├── middleware/
│   ├── model/
│   ├── utils/
│   └── winres/                  # Windows resource embedding
└── frontend/                    # React + Vite application
    ├── package.json             # Miki-web — Vite, Tailwind, Radix, Tabler icons
    ├── public/
    ├── scripts/
    ├── src/
    │   ├── main.tsx             # Application entry
    │   ├── index.css
    │   ├── app/                 # App shell / providers
    │   ├── pages/               # Page components (Chat, Models, Skills, Memory, Logs, …)
    │   ├── features/            # Feature modules
    │   ├── routes/              # Route definitions
    │   ├── routeTree.gen.ts     # Generated route tree
    │   ├── api/                 # API client layer talking to gateway
    │   ├── store/               # Client state management
    │   ├── hooks/
    │   ├── shared/
    │   ├── lib/
    │   ├── theme/               # Material / design tokens, CSS
    │   ├── i18n/                # Internationalization
    │   └── assets/
    ├── vite.config.ts
    └── tsconfig*.json
```

**Comments**
- Frontend is a modern React SPA (Vite + TypeScript + Tailwind).
- Backend (Go) handles launcher, auth, and some model/dashboard concerns; the main agent logic remains in core.
- Default dashboard password is documented as 12345678 (configuration-driven).
- Maintains a single-session Chat UI as the primary interaction surface.
- Screenshots of Chat UI actions are expected during end-to-end evaluation.
