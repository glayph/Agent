# installer — Skill Installer

Multi-source skill installation framework supporting ClawHub marketplace, npm registry,
Git repositories, and local file system installations with verification.

```
installer/
├── src/
│   ├── index.ts                     Public API
│   │                                - SkillInstaller class
│   │                                - SkillRegistry class
│   │                                - Source handler exports
│   ├── installer/
│   │   └── skill-installer.ts       Installation orchestrator
│   │                                - Source resolution
│   │                                - Download + extraction
│   │                                - Metadata validation
│   │                                - Registry registration
│   ├── registry/
│   │   └── skill-registry.ts        Installed skills registry
│   │                                - CRUD operations
│   │                                - Query/filter skills
│   │                                - Persistence
│   ├── sources/                     Installation sources
│   │   ├── base-source.ts           Abstract base class
│   │   ├── clawhub-source.ts        ClawHub marketplace source
│   │   ├── npm-source.ts            npm registry source
│   │   ├── git-source.ts            Git repository source
│   │   └── local-source.ts          Local file system source
│   ├── utils/                       Utilities
│   │   ├── downloader.ts            File downloader with retry
│   │   ├── extractor.ts             Archive extraction (zip, tar.gz)
│   │   ├── validator.ts             Skill metadata validation
│   │   └── source-safety.ts         Safety checks for sources
│   ├── types/                       Type definitions
│   └── __tests__/                   Test suite (10 files)
├── dist/                            Compiled output
├── package.json
└── tsconfig.json
```
