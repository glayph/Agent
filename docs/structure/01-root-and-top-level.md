# 01 — Root and Top-Level Directories

This guide reflects the root files and folders present in the current source snapshot. Optional generated directories such as `node_modules/`, package `dist/`, runtime `data/`, and build outputs may appear after installation or execution and are not part of the clean source layout.

## Root configuration

| File | Responsibility |
|---|---|
| `package.json` | npm workspace declaration, lifecycle scripts, build/test orchestration and Node engine requirement |
| `package-lock.json` | Canonical npm dependency lock used by `npm ci` |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Retained pnpm configuration; verify the invoking script before using them |
| `tsconfig.json`, `tsconfig.base.json` | Root and shared TypeScript settings |
| `turbo.json` | Build task graph and caching configuration |
| `eslint.config.js` | Flat ESLint configuration |
| `jest.config.cjs`, `jest.core.config.cjs`, `jest.release.config.cjs`, `jest.setup.mjs` | General, Core and release-oriented Jest setup |
| `.gitignore`, `.gitattributes` | Repository hygiene and file normalization |
| `.gitleaks.toml`, `.miki-secretignore` | Secret-scanning configuration |

Node.js must satisfy the root engine declaration (`>=22.19.0`). Check the installed version before installing dependencies or interpreting build failures.

## bin/

`bin/miki.js` is the primary Node launcher. `bin/miki-config.js` provides configuration support, `bin/miki-doctor.mjs` reports environment/runtime diagnostics, and `bin/supervisor.ps1` is a Windows helper. Follow the launcher code and package build outputs for the actual startup order.

## config/

- `agent.yaml`: configured persona and Agent/runtime defaults.
- `tools.yaml`: tool-group permissions, denied operations, MCP and web-search configuration.
- `.env.example`: environment variable template.

The YAML files express defaults and policy inputs; they do not supersede hard runtime denials, live tool registration, OS permissions, or approval gates. The interactive identity file loading order is documented in [the operating model](../AGENT_MIKI_OPERATING_MODEL.md).

## deploy/

Deployment helpers are grouped by platform and deployment function: Linux service scripts, Windows installation scripts, reverse-proxy configuration and firewall examples. Read and adapt examples before exposing the Gateway beyond loopback. Do not copy sample firewall rules blindly into a production host.

## docs/ and identity/

`docs/` contains current operating/architecture guides and dated investigation reports. `identity/` contains Miki's prompt documents, operating manual, owner preferences and optional specialist identity profiles. `identity/README.md` explains which components are loaded in interactive and ambient contexts.

## packages/ and scripts/

Workspace package ownership is documented in [02-packages-overview.md](02-packages-overview.md). `scripts/` contains the build, validation, runtime supervision, recovery tests and release automation described in [08-build-and-ci.md](08-build-and-ci.md).

## Runtime data

The runtime data root may contain databases, memory, logs, process state, model cache, vault files and task artifacts. It is generated at runtime and contains sensitive information; keep it outside source control and secure backups appropriately.
