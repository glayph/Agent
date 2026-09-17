# 08 — Build, CI, Scripts & Tooling

## scripts/

```
scripts/
├── build-all related
│   ├── build-cli.mjs                 # Builds the CLI package
│   ├── build-go-backend.mjs          # Compiles the Go backend binary
│   ├── build-llama.mjs               # Builds / prepares llama.cpp integration
│   ├── build-local.mjs               # Local development build
│   ├── build-offline-release.mjs     # Full offline release packaging
│   ├── build-release-artifacts.mjs   # Release artifact assembly
│   ├── build-standard.mjs            # Standard build path
│   └── clean-build-artifacts.mjs     # Cleanup
├── model management
│   ├── miki-model.mjs                # list / status / install / remove models
│   ├── miki-model.test.mjs
│   └── model-smoke.mjs               # Smoke test for model runtime
├── verification & quality
│   ├── run-verify.mjs                # Main verification suite
│   ├── run-release-verify.mjs        # Release-time verification
│   ├── run-go-tests.mjs
│   ├── smoke-gateway-integration.mjs
│   ├── soak-agent.mjs                # Long-running soak test
│   ├── benchmark-score-gate.mjs      # Performance / quality gate
│   └── assert-pack-contents.mjs
├── runtime helpers
│   ├── miki-24-7.mjs                 # 24/7 runtime launcher
│   ├── miki-24-7-policy.mjs / .test.mjs
│   ├── miki-healthcheck.mjs
│   ├── miki-backup.mjs
│   └── offline-launcher-template.mjs
├── packaging & sync
│   ├── prepare-runtime-package.mjs
│   ├── runtime-package-filters.mjs / .test.mjs
│   ├── sync-webui-backend.mjs
│   ├── frontend-pnpm.mjs
│   └── fix-packages.mjs
├── analysis
│   ├── analyze-live-memory.cjs
│   └── inspect-memory-upgrade.cjs
├── dev.js                            # Development launcher
└── jest-release-setup.cjs
```

**Comments**
- `npm run build:all` orchestrates the full monorepo build (llama → config → installer → skills → memory → core → gateway → frontend → cli → go-backend).
- Model scripts allow installing approved GGUF models (default local target: gemma-4-E2B style) and verifying health.
- 24/7 scripts support continuous operation with policy checks.
- Soak and benchmark scripts are used for reliability and quality gating.

## .github/workflows/

```
.github/workflows/
├── build-cross-platform.yml              # Cross-platform build CI
└── release-offline-cross-platform.yml    # Offline release workflow
```

**Comments**
- CI builds and packages for multiple platforms.
- Offline release workflow produces the distributable that was originally zipped as Agent-1.3.7-offline.

## Root test & lint tooling

- `eslint.config.js` — flat ESLint configuration.
- `jest.config.cjs`, `jest.core.config.cjs`, `jest.release.config.cjs`, `jest.setup.mjs` — layered Jest setups.
- `turbo.json` — task pipeline and caching for the monorepo.

These files ensure consistent code quality, unit/integration coverage, and reproducible releases.
