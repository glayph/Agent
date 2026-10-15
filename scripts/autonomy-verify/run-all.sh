#!/usr/bin/env bash
# Offline verification of the autonomy pipeline. Needs Node >= 22 and TypeScript (project node_modules or TS_PATH=...).
# Uses a LOCAL SCRIPTED STUB endpoint instead of a real model: it proves the plumbing, not your provider's quality.
set -u; cd "$(dirname "$0")"
for t in t1-reproduce t2-baseline t3-model-config t4-autonomous-loop t5-verification-honesty; do
  echo "================ $t"; node --import ./register.mjs $t.mjs 2>&1 | grep -v "ExperimentalWarning\|trace-warnings"
done
echo "================ repo resolver tests (shim)"; MIKI_SRC="$(cd ../.. && pwd)" node --import ./register.mjs run-resolver-tests.mjs 2>&1 | grep -v "ExperimentalWarning\|trace-warnings"
