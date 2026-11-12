# Miki Tools, Plugins, Skills & MCP — Operations Guide

This guide explains how Miki discovers capabilities, why an installed extension may not be executable, and how to configure the supported sources. Miki keeps installation, permission grant, activation, and invocation as separate states by design.

## 1. Capability types are different systems

| Capability | How it is registered | What Miki uses it for |
|---|---|---|
| Native tools | Built into `packages/gateway/src/agent/agent-runtime.ts` and grouped by `tools.tool_state` | Files, memory, browser, terminal, goals, control and other first-party operations |
| Skills | Bundled/user skill store (`SKILL.md`) and optional installer bridge | Reusable instruction sets; scripts can be executed via `skill_run` when policy allows |
| Contract plugins | Downloaded skill/plugin contracts in `data/downloaded-skills` and `config/tools.yaml` | Additional tool schemas exposed to the same ToolRegistry |
| Isolated ZIP plugins | Trusted local signed registry under `config/plugins` | Standalone external runtime, enabled only after permission and sandbox checks |
| MCP servers | External MCP connector configuration | Remote tools that are discovered and registered at runtime |

A “skill”, a contract plugin, an isolated ZIP plugin and an MCP server are not interchangeable package formats. Installing one does not automatically register or activate the others.

## 2. How Miki chooses a tool

1. The planner receives the current registered tool names, descriptions and parameter names.
2. The main model chooses the operation based on the user's goal and the available descriptions.
3. If the model context is too small to hold every schema, Miki exposes `miki_find_tools`. The same configured LLM then semantically selects from live capability descriptions in batches. Selection is language-independent and does not use a fixed keyword list.
4. Miki exposes matching schemas in a later model turn. The model must then call the selected tool normally.
5. `miki_capability_status` reports disabled tool groups and active/registered counts. `agent_control_state` reports current control settings.

A schema being registered is not proof it is currently executable. A group can be disabled, a runtime can be unhealthy, or an extension can be blocked by missing grants or host prerequisites.

## 3. Diagnostics the agent can use

- `miki_capability_status`: native/dynamic capability groups, enabled state, active count, registered tool descriptions and disabled reason.
- `skill_list`: currently visible installed skills and plugin/installer discovery warnings.
- `skill_search`: searches installed skills and, when configured, remote skill registries.
- `plugin_marketplace`: signed local ZIP plugin registry and signature/checksum diagnostics.
- `plugin_list`: all installed external plugins, plus whether they are ready to invoke and why they are blocked.
- `agent_control_state` / `agent_control_capabilities`: current tool groups and control capabilities.

If an extension is not visible, check diagnostics before reinstalling it.

## 4. Configure the Skill Registry

Skill registries are optional and **none is assumed by default**. Configure one or more HTTPS registry URLs in the dashboard configuration under `skills.registries`, or use the `MIKI_SKILL_REGISTRIES` environment variable. The environment variable accepts comma-separated `name=url` pairs, a comma-separated list of URLs, or a JSON array.

Example configuration:

```yaml
skills:
  registries:
    - name: internal
      url: https://skills.example.com/api
```

Equivalent environment variable:

```bash
MIKI_SKILL_REGISTRIES='internal=https://skills.example.com/api'
```

A registry must implement the search and download contract consumed by `SkillRegistryClient`. Private or plain-HTTP hosts are blocked unless the explicit local-development option `MIKI_SKILL_ALLOW_INSECURE=true` is enabled. Do not enable that option for an untrusted network.

You can still install a skill directly from an allowed HTTPS archive or supported GitHub URL using the skill import/install UI or the `skill_install` tool; remote marketplace search requires a configured registry.

## 5. Configure the isolated ZIP Plugin Registry

The isolated ZIP-plugin marketplace is a separate, local signed registry. By default it expects:

```text
<configDir>/plugins/
  registry.json
  trusted-public-key.pem
  packages/
    <plugin-id>.zip
```

The JSON registry contains package entries with a validated manifest, archive path relative to the registry directory, SHA-256 digest and Ed25519 signature over the exact archive bytes. `trusted-public-key.pem` is the public key used to verify those signatures. `MIKI_PLUGIN_REGISTRY_FILE` can point to a different registry JSON path relative to `configDir`.

Do not place an arbitrary downloaded archive in the trusted registry and treat it as trusted. Publish/sign it using the matching private key held by the registry operator. The dashboard's local archive upload also verifies the submitted checksum, but checksum validation alone is not a publisher signature.

## 6. Install, grant, enable, invoke, disable and uninstall

These are deliberately separate lifecycle steps:

1. **Install** copies/verifies a package and persists its manifest. It remains disabled; install does not execute plugin code.
2. **Grant** the minimum required permissions on the Plugin page. Miki's agent tools never silently grant permissions.
3. **Enable** starts the plugin runtime and performs a health check. A plugin may remain blocked if the host sandbox is unavailable, the permission type is unsupported, a grant is missing, the platform is incompatible, or startup/health fails.
4. **Describe** uses `plugin_describe` to inspect an enabled plugin's optional machine-readable method catalogue. Existing plugins may not implement `describe()`; in that case method details are unavailable and Miki must not guess.
5. **Invoke** is available only for an enabled, healthy runtime and declared capabilities. `plugin_invoke` currently requires the normal approval gate because per-method risk metadata is not yet enforced.
6. **Disable** stops the runtime but keeps the installed package.
7. **Uninstall** removes a non-built-in package only when no installed plugin depends on it. Destructive approval is required for agent-initiated removal.

The ordinary isolated plugin runner currently requires Linux user/network namespaces (`unshare -Urn`) plus `prlimit`. The sandbox supports only the permission classes enforced by the runner; network, secrets, shell, browser, computer-use, MCP and agent-delegation permissions are not granted in that mode. Use the dashboard's documented host/guest security configuration rather than weakening the sandbox to make an arbitrary plugin run.

## 7. Turn profiles and permissions

A turn-profile skill allowlist controls which installed skills Miki may **read or execute** during that turn. It does not hide catalog management: `skill_install` and `skill_delete` remain available (with their existing approval gates). This avoids a profile intended to limit execution accidentally making skill installation or removal impossible.

Global tool groups in `tools.tool_state` are different: a disabled group removes its tool schemas from the active model registry. Use `miki_capability_status` to identify a disabled group, then enable it in configuration or through the existing approval-aware control workflow. Built-in safety policies and per-tool approval still apply.

## 8. Runtime and dependency checks

This repository requires Node.js `>=22.19.0`. Before diagnosing build/runtime issues, run:

```bash
node --version
npm install
npm run build:all
npm run dev
```

If tests or build fail, preserve the first error and check whether dependencies and optional native modules actually installed. A missing registry is a configuration state; a missing package, permission, sandbox or runtime is an operational blocker. They should not be reported as “no matching capability”.


### Plugin method discovery

The autonomous agent exposes `plugin_describe` for enabled plugins. A plugin may optionally implement `describe()` and return a machine-readable method catalogue (method names, descriptions, parameter schemas, and risk hints). The runner limits the serialized description size. This data is untrusted documentation, not an authorization grant. Existing plugins without `describe()` continue to run, but Miki must not guess their method names or payload schemas.

Until a plugin method catalogue can be validated against a per-method permission schema, generic `plugin_invoke` requires the normal approval gate. MCP no-confirm settings do not override server `allow_side_effects` policies or unknown-safety blocking.


## Agent identity integration

The live tool registry and permission state determine which operations can be performed in the current run. `identity/TOOLS.md` is a discovery guide, not an executable registry. A skill supplies reusable instructions; it does not create a worker, grant tool permission or bypass plugin/MCP authorization. A plugin may require discovery, installation, explicit grants, enablement, health checks and invocation as separate steps.

Use [Agent-Miki Operating Model](AGENT_MIKI_OPERATING_MODEL.md) for the runtime-specific tool-family map and the safe procedure for finding an apparently missing capability. Do not edit bundled skill definitions as part of persona/documentation maintenance unless a separate task explicitly requests skill content changes.
