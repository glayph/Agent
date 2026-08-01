## Issue #10: Stale postbuild.mjs script

**Status**: ✅ Fixed (script removed)

**Original Problem**:
- `scripts/postbuild.mjs` was a stale script not referenced by any root/package scripts
- Could corrupt import specifiers like `import("./file?raw")` → `import("./file?raw.js")`
- Was dead maintenance surface since it was not wired into package scripts

**Evidence of Fix**:
- Script file `scripts/postbuild.mjs` has been deleted from the repository
- No references to postbuild in `package.json` or any other configuration

**Impact**:
- Cleaned up codebase with no dead maintenance surface
- Prevented potential import specifier corruption if script was run manually

---

## Issue #72: Health Watchdog restart label

**Status**: ✅ Fixed

**Original Problem**:
- The watchdog restart action was labeled "Restart watchdog" but it only cleared in-memory probe history
- The action did not actually restart monitored services

**Evidence of Fix**:
- Updated label in `packages/ui/frontend/src/i18n/locales/en.json` from "Restart watchdog" to "Reset watchdog state"
- Updated label in `packages/ui/frontend/src/i18n/locales/zh.json` from "重启 watchdog" to "重置 watchdog 状态"
- Updated label in `packages/ui/frontend/src/i18n/locales/pt-br.json` from "Reiniciar watchdog" to "Redefinir estado do watchdog"

**Impact**:
- Label now accurately reflects what the action actually does
- Users understand that the action resets state rather than restarting services
- Consistent across all supported languages

---

## Issue #80: MQTT mojibake separators

**Status**: ✅ Fixed

**Original Problem**:
- `packages/ui/frontend/src/components/channels/channel-forms/mqtt-form.tsx:195`, `:217`, `:232`, `:239`, and `:246` rendered the literal text `â€"` as the separator before MQTT field descriptions
- The MQTT configuration page visibly displayed corrupted characters, making the protocol instructions look broken

**Evidence of Fix**:
- Replaced corrupted characters with proper ASCII separators `{" - "}` throughout the file
- All help text now renders correctly with proper characters
- No mojibake characters found in the file

**Impact**:
- MQTT configuration page now displays clean, professional help text
- Protocol instructions are readable and trustworthy

---

## Issue #87: Model Catalog delete reports success when no catalog row was deleted

**Status**: ✅ Already Fixed

**Original Problem**:
- Backend could return success even when catalog entry didn't exist
- Frontend couldn't distinguish real delete from no-op
- No 404 error for missing catalog entries

**Evidence of Fix**:
- Current code at `packages/core/src/api/launcher-compat.ts:5034-5045` already returns 404 for missing catalog entries
- Backend properly checks if entry exists before deletion
- Returns `deleted: id` on successful deletion

**Impact**:
- Frontend can distinguish real deletes from missing entries
- Better error handling for user actions
- More accurate API responses

---

## Issue #100: Verify scripts ignore --help and unknown flags

**Status**: ✅ Already Fixed

**Original Problem**:
- `scripts/run-verify.mjs` and `scripts/run-release-verify.mjs` didn't read `process.argv`
- Running with `--help` would execute full pipeline instead of showing usage
- Unknown flags were silently ignored

**Evidence of Fix**:
- Both scripts now have proper argument handling
- `--help` flag shows usage information
- Unknown flags cause explicit errors
- Consistent with other helper scripts in the repo

**Impact**:
- Developers can safely ask for usage
- Mistyped flags are caught with clear errors
- Help requests don't trigger long-running pipelines

---
