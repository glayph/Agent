# Files / Drive

The dashboard Drive page, the HTTP API and the agent all use the same sandbox: the workspace
(`MIKI_WORKSPACE_DIR`, default is the project root). Every `/api/files/*` route requires the
dashboard session.

## HTTP API (`createFileManagerRouter` from `@miki/core/file-manager`)

| Route | Purpose |
| --- | --- |
| `GET /api/files/roots` | Roots with `canWrite` / `canRun` (`canRun` follows the execution switch) |
| `GET /api/files?path=` | Paged directory listing (protected entries are hidden) |
| `GET /api/files/read?path=` / `PUT /api/files/write` | Text read / atomic write with `expectedModifiedAt` conflict check (409) |
| `POST /api/files/create`, `PATCH /api/files/rename` | New file/folder, rename |
| `POST /api/files/copy`, `POST /api/files/move` | Recursive; never overwrites (409); symlink trees rejected |
| `DELETE /api/files` | Folders need `recursive: true` |
| `POST /api/files/upload` | multipart `parentPath` + `file`, 25 MB limit, 409 if the name exists |
| `GET /api/files/download?path=` | Attachment download |
| `GET /api/files/download-archive?paths=...` | `.tar.gz` of one or more items (size/entry budget enforced) |
| `GET /api/files/preview?path=` | Inline image/audio/video/pdf/svg with `Range` support; others 415 |
| `POST /api/files/run {path}` | Runs a script, returns `{status, result:{stdout, stderr, exitCode, ...}}`; failures are 422 with the error line |

## Real file execution

Implemented in `packages/core/src/engine/file-runner.ts`; enabled by default.

* Types: `.js .mjs .cjs .py .sh .ps1 .bat .cmd` (per platform). Native binaries only if `allowNative`.
* Started with `shell: false`, so arguments are never interpreted by a shell.
* Working directory is the script's folder (or another folder inside the workspace).
* Environment is an allowlist (`PATH`, `HOME`, `LANG`, ...); API keys and tokens are not inherited.
* 30 s default / 300 s maximum, 256 KB output per stream (a flooding script is killed), the whole process group is killed on timeout or cancel.
* At most 3 concurrent runs (`MIKI_FILE_RUN_MAX_CONCURRENT`).
* Symlinks, files outside the workspace, credential files and scripts over 5 MB are refused.
* Output has credential-shaped strings redacted.
* Every run is recorded in the `file_runs` table (`source` = `dashboard` or `agent`).

This is a guard rail, not an OS sandbox: a script runs with the gateway's OS user rights. Do not
expose the gateway to untrusted users. Turn execution off with `MIKI_FILE_EXECUTION=false` or
`app_config.files.execution_enabled = false`; the Run action then disappears and `/run` returns 403.

## Protected files

Hidden from lists and refused for read, write, download, preview, copy, move, delete and run:
the runtime data directory (vault, database), and credential-looking names (`.env*`, `*.pem`,
`*.key`, `*.sqlite`, `id_rsa`, `secret-vault.json`, ...). Archives silently skip them.
`MIKI_FILES_ALLOW_SENSITIVE=true` lets the operator work with credential-named files; the data
directory stays protected.

## Agent tools (all file commands available to the LLM)

| Tool | Risk | Approval |
| --- | --- | --- |
| `workspace_list`, `file_read`, `workspace_search`, `file_info` | read | no |
| `file_write`, `file_mkdir`, `file_rename`, `file_move`, `file_copy` | config_write | `file_write` yes; the rest follow the engine default (ask) |
| `file_delete` | destructive | always |
| `file_run` | service | always |

The execution switch also applies to `file_run`; the agent cannot change it (it is not an allowed
control-service config path).

## Tests

```bash
npm run test:files          # runner, file tools, router run/preview/protected paths (36 new + existing router tests = 50)
npm run smoke:agent-core    # end to end through the gateway (30 checks)
```
