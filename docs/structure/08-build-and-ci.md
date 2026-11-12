# 08 — Build, CI, Scripts and Tooling

The root `package.json` defines the supported scripts. Always inspect its current script body before assuming an exact build sequence.

## Main commands

```bash
npm ci
npm run build:all
npm run test:architecture-layout
npm run test:agent-core
npm run test:gateway
npm --prefix packages/ui/frontend run test
npm --prefix packages/ui/frontend run lint
```

The root engine declaration requires Node.js `>=22.19.0`. `npm ci` must run with install scripts enabled for native dependencies such as SQLite. A full build may also compile the bundled llama.cpp native integration and therefore require a supported CMake/compiler toolchain.

## Script families

- **Build:** workspace orchestration, frontend compilation, CLI assembly, native provider preparation, local/release build scripts.
- **Validation:** architecture/layout contracts, package tests, frontend tests/lint, bundled-skill checks, native SQLite check, release verification.
- **Runtime:** development launcher, continuous-runtime supervisor, health checks, backup/recovery helpers.
- **Models:** list/status/install/remove supported local models and smoke-test model runtime.
- **Reliability:** chaos/recovery tests, integration smoke, soak and benchmark gates.

Use `npm run` to inspect the exact script names in this checkout. Historical reports may refer to commands or paths from an earlier source snapshot.

## CI

`.github/workflows/` contains cross-platform build and offline-release workflows. The release pipeline assembles distributable artifacts from built workspace outputs. Release success should be based on the workflow logs and artifact checks, not a static statement in documentation.

## Change verification

For a runtime identity change, run the identity prompt tests and any relevant supervisor tests. For Chat Top Bar changes, run the status/helper and frontend test suites, lint and production build, then inspect desktop/mobile behavior in an actual browser. For broad changes, finish with architecture/layout contracts and the root build/test path.

Do not claim a check passed unless it was executed successfully in the current environment. Record Node version, dependency installation state, commands, exit codes and environmental blockers in the upgrade verification record.
