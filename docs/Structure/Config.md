# config — Configuration & Security

Shared configuration loading, Zod schema validation, security helpers, and encrypted secret vault.

```
config/
├── src/
│   ├── index.ts                     Public API (re-exports config, security, schema, secret-vault, types)
│   ├── config.ts                    Config loading and resolution from YAML files
│   ├── schema.ts                    Zod schema validation for agent.yaml, tools.yaml, litellm.yaml
│   ├── security.ts                  CORS, CIDR, rate limiting, API key helpers
│   ├── secret-vault.ts              Encrypted secret storage with key derivation
│   └── types.ts                     Shared type definitions used across packages
├── dist/                            Compiled output
├── package.json
└── tsconfig.json
```
