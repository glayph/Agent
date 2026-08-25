# Agent Miki Provider and Plugin SDK

## Purpose

Agent Miki supports two related extension paths. A provider SDK plugin is an in-process `MikiProviderPlugin` implementation used by the core provider registry. A general installed plugin is acquired by the installer and may declare `tools`, `channels`, `skills`, `providers`, or `hooks` contracts. Installed executable contracts are not loaded directly into the core process; they run through the policy-gated runtime contract executor.

The built-in provider policy remains **Gemini and llama.cpp only**. Installing a third-party provider does not silently activate it or replace the configured built-ins.

## Public SDK import

After building the core package, plugin authors can import the public SDK contracts from:

```ts
import type {
  MikiProviderPlugin,
  MikiProviderManifest,
  MikiProviderCompletionRequest,
} from "@miki/core/llm/provider/sdk";
```

The public SDK API version is `1.0`. Provider manifests must use a semantic `version`, a compatible `pluginApiVersion`, a lowercase provider ID containing letters, digits, `_`, `-`, or `.`, and all five boolean capability fields: `chat`, `tools`, `streaming`, `vision`, and `local`.

A provider plugin must export a compatible object with `manifest`, `auth`, `catalog(context)`, and `complete(request)` hooks. Optional hooks include `listModels`, `testConnection`, and `shutdown`. The loader and registry re-validate the exported manifest before use; an entrypoint cannot make its manifest less restrictive than its JSON descriptor.

## Native provider manifest

A distributable provider can use `miki.provider.json` when it is being installed through the general plugin installer. The installer converts it into a provider contract while preserving provider ID, display name, model IDs, endpoint metadata, authentication metadata, capabilities, and declared permissions.

```json
{
  "id": "example-provider",
  "displayName": "Example Provider",
  "version": "1.0.0",
  "pluginApiVersion": "1.0",
  "entrypoint": "index.mjs",
  "baseUrl": "https://api.example.invalid/v1",
  "apiKeyEnv": "EXAMPLE_PROVIDER_KEY",
  "modelIds": ["example/fast"],
  "permissions": ["network"],
  "capabilities": {
    "chat": true,
    "tools": true,
    "streaming": true,
    "vision": false,
    "local": false
  }
}
```

A provider manifest with no entrypoint is valid as metadata-only. A provider with an entrypoint is executable only after the runtime contract policy, permissions, runtime type, and static capability scan all allow it.

## Installation sources and preview

The installer accepts these source prefixes:

| Source | Example | Notes |
|---|---|---|
| Local directory | `./my-plugin` | Copies the directory while excluding `.git` and `node_modules`. |
| npm package | `npm:@scope/plugin@1.2.3` | Uses `npm pack` and safe tar extraction. |
| Git repository | `git:https://github.com/example/plugin.git#main` | Uses a shallow clone, validates the branch, and strips `.git`. HTTPS/SSH is required. |
| Clawhub registry | `clawhub:example-plugin` | Requires a configured registry response and safe archive URL. |

Before persisting a plugin, call the mutation-free preview API:

```http
POST /api/skills?action=preview-install
Content-Type: application/json

{"source":"./my-plugin"}
```

The preview returns `valid`, `installability`, source protocol, manifest data, entrypoint, detected runtime, errors, and warnings. `installability` is one of:

| Value | Meaning |
|---|---|
| `installable` | Manifest is valid and the entrypoint uses Node (`.js`, `.mjs`, `.cjs`) or Python (`.py`). |
| `metadata_only` | Manifest is valid but has no executable entrypoint. |
| `unsupported_runtime` | Manifest is valid, but the entrypoint extension is not runnable by the current contract executor. |
| `invalid` | Acquisition or manifest validation failed. |

The same classification is included in a successful install result. A successful installation means the package was safely acquired and persisted; it does **not** mean that every declared contract is immediately executable.

## Runtime safety and activation

The installer validates relative entrypoints, rejects traversal, checks realpath containment, rejects unsafe archive links, and stores fetched content in the isolated downloaded-skills directory. The provider loader rejects external direct in-process loading and checks both lexical and realpath containment before importing a built-in entrypoint. The runtime contract executor performs the equivalent realpath check for installed contract entrypoints.

Executable contracts are disabled by default unless the runtime policy explicitly enables them. Declared permissions, detected entrypoint capabilities, allowed runtimes, execution timeout, output limit, disabled plugin lists, and allowed contract kinds are evaluated before execution. Node and Python are the supported executable runtimes. TypeScript and TSX sources may be retained as plugin assets, but they are reported as `unsupported_runtime` rather than being executed without a build step.

A typical controlled policy is configured in the workspace `config/tools.yaml` file. Enable only the permissions needed by the reviewed plugin, keep `allow_execution` off until inspection is complete, and retain audit logging. High-risk capabilities such as shell execution, secrets, network access, and filesystem writes require explicit policy decisions.

## Verification checklist

For a new plugin, first run `preview-install`, inspect the manifest and warnings, then install only from a reviewed source. Confirm the registry record and assets path, run the marketplace readiness report, and verify that the intended contract is either `metadata_only`, `requires_policy`, or `ready` for the expected reason. For executable plugins, test a bounded invocation and inspect the audit event. Never treat an install HTTP 200 alone as proof that the plugin ran.

The repository regression suite covers provider manifest validation, API-version gating, duplicate IDs, exported-manifest re-validation, lexical and symlink escape protection, local provider-manifest conversion, preview classification, contract execution policy, and runtime contract symlink protection.
