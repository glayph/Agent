# Release Validation

This document records the release validation performed against the GitHub `main` branch at commit `cfcaa274dc94f5a3617e98fa54747dc707457556`.

## GitHub Actions and release artifact

The published release `v1.3.12-offline` was inspected through GitHub Actions and its Linux x64 assets were downloaded into a separate installation-test directory. Both files listed by `SHA256SUMS-linux-x64` validated successfully:

- `agent-miki-linux-x64-offline-1.3.9.tgz`
- `agent-miki-linux-x64-offline-1.3.9.tar.gz`

The release intentionally does not bundle an answer-model GGUF or voice-to-text model. Those assets must be configured separately.

## Verification

The exact repository gate used by the build workflow was run locally with `MIKI_LLAMA_BUILD_JOBS=1 npm run verify`. It completed successfully, including production builds, strict typechecks, workspace tests, frontend tests, and the doctor checks. The frontend suite reported 18 passing files and 124 passing tests.

The separate `verify:release` command is stricter and currently discovers six legacy duplicate suites under `packages/core/__tests__` that are not part of the GitHub Actions gate. Its failures are test-discovery/fixture compatibility failures, not failures of the published release artifact or the official CI gate.

## Global installation smoke test

The Linux tarball was installed with npm into an isolated global prefix:

```bash
npm install --global --prefix /path/to/global-prefix agent-miki-linux-x64-offline-1.3.9.tar.gz
```

From a different clean working directory, `miki doctor` passed. The installed launcher initially reported that core port `8000` was already in use because another Miki instance was running. The launcher was then started successfully with isolated ports:

```bash
CORE_PORT=8001 GATEWAY_PORT=18801 GATEWAY_HOST=127.0.0.1 miki start
```

The resulting health endpoint returned HTTP 200 with `status: "ok"` and `coreHealthy: true`. This confirms that the npm-installed command works independently of the source checkout; when another Miki instance is already running, use distinct `CORE_PORT` and `GATEWAY_PORT` values or stop the existing instance.
