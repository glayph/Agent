# Verification Summary

Validation was run from the repository root after the Agent Control completion pass.

| Check | Result |
| --- | --- |
| `npm install --ignore-scripts` followed by `npm rebuild better-sqlite3` | Passed |
| `npm run build --workspace=@miki/core` | Passed |
| `npm run lint --workspace=@miki/core` | Passed |
| `npm run build:frontend` | Passed |
| `npm run lint --workspace=packages/ui/frontend` | Passed |
| `npm test --workspace=packages/ui/frontend -- --run` | Passed: 13 files, 53 tests |
| `npm run verify` | Passed: all verification checks passed |

The doctor stage reports two non-blocking environment warnings: Go is not installed, and some runtime build artifacts require the production build flow before deployment. A real llama.cpp process probe, live provider completion probe, 24/7 supervisor run, and browser screenshot pass remain target-machine checks.

The final archive intentionally excludes `node_modules`, generated distribution folders, runtime data, and the Git metadata directory. Install dependencies and rebuild on the target Linux or Windows machine before production use.
