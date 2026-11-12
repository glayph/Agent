# Sandbox No-Confirmation Mode

Miki is configured for agent-side no-confirmation execution in a disposable VM/container controlled by the operator. This is not an OS sandbox: the VM/container is the isolation boundary.

## Enabled behavior

- Foreground AgentEngine calls are auto-approved for all registered tools, including tools marked `approval: required` and learned `ask` decisions.
- Autonomous heartbeat and goal runs receive the tools allowed by the current tool-group configuration and hard autonomy policies. New tools are exposed on the next autonomous run after registration and extension refresh.
- High-impact, destructive, install, service and external side-effect actions do not produce owner confirmation prompts.
- The Agent Control Service bypasses approval and its default config-path allowlist only for Miki's internal agent actor. Dashboard and remote API callers retain their ordinary control policy.
- Workspace file tools can read and mutate credential-like files, hidden directories, and the workspace root; they can target absolute paths visible to the guest OS. The OS account, mounts and VM boundary determine what can actually be reached.
- Browser access is not restricted by domain or private-network filtering in this profile. The browser still requires valid HTTP(S) navigation URLs.
- MCP side effects still require the server's explicit `allow_side_effects: true` setting; unknown-safety tools remain blocked even in no-confirm mode. The setting suppresses eligible user confirmation prompts but does not grant authority to an external server.
- Plugin manager automatically grants every manifest-declared permission, permits any plugin method implemented by the runtime, and runs plugin code with the guest OS identity; legacy installs receive the same grants on startup. The nested plugin sandbox and its previous unsupported-permission list are bypassed in this mode.
- The terminal ignores `MIKI_TERMINAL_SAFE` command blocklists, workspace clamps and environment secret stripping while owner mode is active; all environment values visible to the Miki process are inherited by guest commands.
- Executable plugin contracts are enabled with network, secrets, filesystem-write and shell capability policies; statically detected but undeclared plugin capabilities no longer block execution (they remain visible in the audit/readiness report). All installed skills are visible even when a turn profile narrows the skill list. File/skill scripts inherit the full guest process environment. Authenticated remote-origin tool calls may execute guest commands; channel sender allowlists and dashboard authentication remain in force.

## Boundaries that remain

No-confirm mode is not permission escalation beyond the guest OS identity. It cannot create a missing tool, missing provider credential, unavailable adapter, missing network, unsupported plugin bridge or OS capability. Channel sender allowlists, dashboard authentication, request/schema validation, plugin manifest/schema and entrypoint validation, archive/path validation, plugin resource limits, cancellation, and actual operating-system controls remain in place. Capability declarations are not used as a permission gate in this mode.

Ordinary plugin mode still uses Linux namespaces and Node's filesystem permission model. In guest-unrestricted owner mode that additional plugin sandbox is deliberately not used: plugin code and plugin contracts can access the guest OS capabilities available to the Miki process. The VM/container boundary, not the plugin runner, is the security boundary. This is appropriate only for trusted code inside a disposable guest.

## Required deployment posture

- `agent.security.sandbox_mode: true` is an application feature switch; it does not create a VM or container.
- Run Miki only inside a disposable VM/container that you control. Do not mount host home folders, credentials, SSH agents, Docker sockets, browser profiles, cloud metadata access or sensitive host devices into the guest unless they are genuinely needed.
- `agent.security.bypass_restrictions: true` enables browser access to private/reserved networks as well as public sites.
- `runtime.plugin_contracts.require_os_sandbox: false`, `allow_unsafe_host_execution: true`, and `allow_undeclared_permissions: true` rely on the outer VM/container rather than nested plugin checks. Keep the guest isolated from sensitive host and cloud control planes.
- `agents.defaults.restrict_to_workspace: false`, `tools.exec.allow_remote: true`, `runtime_installer.allow_sudo: true`, full shell/file access, guest secret-file access and inherited process environment permit Miki to affect everything visible to its guest OS account, not merely the project directory.
- `runtime.plugin_contracts.allow_execution: true` with the `allow_*` policies enables full plugin-contract capabilities inside the guest. Owner mode can bypass eligible approval prompts, bypass turn-profile skill allowlists and pass the complete process environment to terminal, file and skill scripts. It does not re-enable a tool group explicitly switched off in `tools.tool_state`, and it does not override the hard `autonomy.tool_policy.allow_computer_use` gate. It still ignores the optional `MIKI_TERMINAL_SAFE` tripwires.

## Configuration

- `tools.auto_approve_all: true` enables foreground no-confirm execution for eligible registered tools; it does not turn on a tool group explicitly disabled in `tools.tool_state`, override the computer-use hard policy, or bypass an MCP server's `allow_side_effects` setting.
- `agent.security.sandbox_mode: true` is required to activate the no-confirm switch.
- `autonomy.tool_policy.auto_approve_all: true` enables no-confirm execution for autonomous runs.
- `autonomy.tool_policy.allow_all_paths: true` lets autonomous file tools use any guest-visible path.
- `autonomy.tool_policy.browser_allowed_domains: ["*"]` allows any domain; `agent.security.bypass_restrictions: true` also allows private/reserved network targets.

Set `tools.auto_approve_all: false` and `autonomy.tool_policy.auto_approve_all: false` to restore ordinary approval prompts. Set `allow_all_paths: false` and `bypass_restrictions: false` to restore the narrower application-level path and browser network boundaries.

## Maintenance and status note

This is a dated investigation, plan, or implementation snapshot. Its findings and status labels describe the code and test evidence available when it was written; they are not a live assertion that every item remains current. Preserve this report as historical context. For present behavior, check the current source, the adjacent tests, and [Agent-Miki Operating Model](AGENT_MIKI_OPERATING_MODEL.md) where applicable. Do not treat an unverified recommendation or an old checklist as proof of an enabled capability.
