# scripts/ — Build & Release Automation

Node.js (.mjs) scripts that orchestrate TypeScript compilation, Go builds,
frontend Vite builds, testing, and verification.

```
scripts/
├── build-cli.mjs                   Build Go CLI binary (cross-platform)
├── build-go-backend.mjs            Build Go UI backend (with/without legacy tag)
├── build-release-artifacts.mjs     Full release artifact build (all targets)
├── build-runtime-if-stale.mjs      Conditional rebuild (skip if up-to-date)
├── clean-build-artifacts.mjs       Clean all build output and temp files
├── frontend-pnpm.mjs               pnpm wrapper for frontend operations
├── prepare-runtime-package.mjs     Prepare runtime for distribution
├── run-go-tests.mjs                Run Go test suites (CLI + backend)
├── run-release-verify.mjs          Pre-release verification (stricter checks)
├── run-verify.mjs                  Full verification (test + audit + doctor)
├── sync-webui-backend.mjs          Sync built frontend to Go backend embed directory
└── workflow-runner.mjs             CI workflow automation runner
```
