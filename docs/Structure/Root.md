# Root — Top-Level Structure

```
Hiro/
├── .devin/                          Devin AI workflow definitions
├── .github/workflows/               GitHub CI/CD pipelines (ci.yml, release.yml)
├── .kiro/                           Agent steering and sub-agent configurations
├── .trash/                          Deprecated/unused files (installer-old, scripts-unused, etc.)
├── bin/                             CLI entry points
│   ├── Hiro.js                   Main CLI launcher (resolves runtime, spawns gateway + CLI + memory)
│   └── Hiro-doctor.mjs           Health diagnostics script
├── config/                          Runtime YAML configuration files
│   ├── agent.yaml                   Agent persona, channels, capabilities
│   ├── litellm.yaml                 LLM model routing and provider settings
│   └── tools.yaml                   Tool permissions and web search providers
├── data/                            Runtime state (logs, encryption keys, backup data)
├── dist/                            Compiled build artifacts
├── docs/                            Project documentation and troubleshooting guides
│   ├── Documentation.md
│   ├── feature.md
│   ├── MEDIUM_PRIORITY_ISSUES_REVIEW.md
│   ├── RELEASE_CHECKLIST.md
│   └── TROUBLESHOOTING_MATRIX.md
├── node_modules/                    Installed dependencies
├── packages/                        Monorepo workspaces (8 packages — see sub-files)
├── promlem-lists/                   Problem tracking and fix documentation
│   ├── problems/                    Documented bugs/issues (14 files)
│   └── fixed/                       Resolved issues (4 files)
├── scripts/                         Build and release automation (see Scripts.md)
├── src/skills/                      Legacy/incoming skills marketplace
│   ├── categories.json
│   └── marketplace/
├── .env.example                     Environment variable template
├── eslint.config.js                 ESLint flat config
├── jest.config.cjs                  Jest test configuration
├── package.json                     Root workspace definition
├── pnpm-workspace.yaml              pnpm workspace config (for frontend)
├── tsconfig.base.json               Shared TypeScript base configuration
├── tsconfig.json                    Project references (5 packages)
└── skills-lock.json                 Locked third-party skill hashes
```
