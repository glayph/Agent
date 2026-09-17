# Example Provider

This directory demonstrates the Agent Miki provider manifest format and the bounded runtime-contract entrypoint pattern. It is intentionally deterministic and does not call a network service, read secrets, write files, or execute shell commands.

The manifest declares `example-provider/demo` and the `network` permission to show how a real provider would describe an external endpoint. The mock entrypoint accepts a JSON object on standard input and returns a JSON object with an `output` field. It is not imported into the Agent Miki core process: external provider entrypoints are metadata-only unless an operator explicitly approves the runtime-contract policy.

See:

- [`docs/provider-plugin-architecture.md`](../../docs/provider-plugin-architecture.md)
- [`docs/provider-plugin-authoring.md`](../../docs/provider-plugin-authoring.md)
- [`docs/provider-plugin-security.md`](../../docs/provider-plugin-security.md)
