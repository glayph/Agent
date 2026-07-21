# packages/Hiro-cli

> **Note**: This directory is an **empty placeholder**. The actual Go CLI source code lives in [packages/cli/](../cli/).

The Go binary (`Hiro-cli` / `Hiro-cli.exe`) is built from `packages/cli/` and output to:

```
packages/cli/dist/bin/Hiro-cli      # Linux/macOS
packages/cli/dist/bin/Hiro-cli.exe  # Windows
```

The build scripts (`scripts/build-cli.mjs` and `scripts/build-release-artifacts.mjs`) reference `packages/cli` as the Go source directory.

## Why does this directory exist?

During an earlier rename pass (`packages/cli` was briefly called `packages/Hiro-cli`), the build scripts were updated to reference the new name but the directory rename was later reverted. This empty `packages/Hiro-cli` directory was retained for historical compatibility but contains no source files.
