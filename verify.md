# Agent Miki — Independent Verification Checklist

এই ফাইলটি একটি independent reviewer বা Claude-কে দেওয়ার জন্য তৈরি করা হয়েছে। লক্ষ্য হলো এই project-এ করা reliability, TypeScript CLI port, workflow hardening, recovery এবং runtime validation সত্যিই repository-তে উপস্থিত ও কার্যকর কি না যাচাই করা। কোনো secret বা production credential ব্যবহার করা যাবে না।

## 1. পরিবেশ প্রস্তুতি

Project root-এ গিয়ে Node.js 22 বা compatible Node.js ব্যবহার করুন। Dependency install করুন:

```bash
npm install --no-audit --no-fund
```

`.env` না থাকলে `.env.example` দেখে test-only configuration তৈরি করুন। কোনো real API key commit বা log করবেন না।

## 2. TypeScript CLI port যাচাই

Go CLI আর default build path-এ প্রয়োজনীয় নয়—এটি যাচাই করুন:

```bash
npm run build:cli
node packages/cli/dist/cli.js --help
node packages/cli/dist/cli.js version
node packages/cli/dist/cli.js doctor
node bin/miki.js --version
```

Expected result:

- CLI TypeScript source থেকে compile হবে।
- `--help`, `version`, `doctor` সফল হবে।
- Root launcher compiled TypeScript CLI-তে delegate করবে।
- Default build path native Go CLI-র উপর নির্ভর করবে না।

Review করুন:

- `packages/cli/src/cli.ts`
- `packages/cli/tsconfig.json`
- `scripts/build-cli.mjs`
- `bin/miki.js`
- `package.json`

## 3. Workflow durability এবং recovery যাচাই

Focused recovery suite চালান:

```bash
NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest \
  --config=jest.core.config.cjs \
  --runInBand --forceExit \
  packages/core/src/workflow-engine.test.ts \
  packages/core/src/task-queue-persistence.test.ts \
  packages/core/src/task-queue-sqlite.test.ts \
  packages/core/src/scheduler.test.ts \
  packages/core/src/agent.test.ts
```

Expected baseline: **5 suites এবং 43 tests pass**।

Review করুন:

- `packages/core/src/workflow-engine.ts`
- `packages/core/src/task-queue.ts`
- `packages/core/src/task-queue-persistence.test.ts`
- `packages/core/src/task-queue-sqlite.test.ts`
- `packages/core/src/scheduler.ts`
- `packages/core/src/scheduler.test.ts`
- `packages/core/src/scheduled-task-store.ts`

বিশেষভাবে যাচাই করুন:

1. Workflow state-এর জন্য SQLite-backed store এবং atomic lease আছে।
2. দুই worker একই workflow একসঙ্গে claim করতে পারে না।
3. Long-running workflow heartbeat lease renew করে।
4. Fresh workspace-এ `data/` directory না থাকলেও SQLite database তৈরি হয়।
5. Corrupt JSON queue snapshot silently ignore হয় না; recovery copy রেখে visible error দেয়।
6. Scheduler timeout effective per-task budget report করে।
7. Recurring task catch-up bounded এবং persisted।

## 4. Manifest এবং generated workflow artifact যাচাই

```bash
npm run verify:workflow
cd /home/ubuntu/miki-project/Miki-final/miki-agent-test
node scripts/verify.mjs test
node scripts/verify.mjs build
node scripts/verify.mjs smoke
```

Expected result:

- Manifest valid হবে।
- Scaffold test, build এবং smoke gate pass হবে।
- Declared output files missing হলে verification fail করবে।

## 5. Supervisor এবং 24/7 lifecycle যাচাই

```bash
node --check scripts/miki-24-7.mjs
npm run runtime:24-7:check
npm run test:supervisor
```

Expected result:

- Supervisor syntax valid হবে।
- Gateway entrypoint, restart limits, backoff এবং readiness timeout valid হবে।
- Healthy shutdown এবং repeated crash/restart integration scenarios pass হবে।

Review করুন:

- `scripts/miki-24-7.mjs`
- `scripts/miki-24-7.integration.test.mjs`
- `scripts/miki-24-7-policy.mjs`

## 6. Frontend warning cleanup যাচাই

```bash
npm test --workspace=Miki-web
npm run build:frontend
```

Expected result:

- Frontend tests pass হবে।
- Production build pass হবে।
- Vite-এর `configLoader: 'native'` এবং `__dirname` compatibility warning আর থাকবে না।

Review করুন:

- `packages/ui/frontend/vite.config.ts`

Expected implementation pattern হলো ESM-safe `import.meta.url` এবং `fileURLToPath` ব্যবহার করা।

## 7. Bounded soak verification

Gateway চালু থাকা অবস্থায়:

```bash
node scripts/soak-agent.mjs \
  --url http://127.0.0.1:18800 \
  --metrics-url http://127.0.0.1:8000/metrics \
  --duration-minutes 0.2 \
  --interval-ms 1000 \
  --request-timeout-ms 2000 \
  --output /tmp/miki-soak-report.json
```

Expected result:

- Exit code 0।
- সব health checks pass।
- সব metrics checks pass।
- `errorCounts` empty এবং `errorSamples` empty থাকবে।
- RSS, open file descriptors এবং active resources report হবে।

Review করুন:

- `scripts/soak-agent.mjs`

Soak report-এ failed sample, error type এবং last sample সংরক্ষিত হচ্ছে কি না যাচাই করুন।

## 8. Full workspace verification

```bash
npm test
```

Verified baseline:

- Core: **113 suites, 726 tests passed**
- Installer: **51 tests passed**
- Memory integration: passed
- Frontend: **18 files, 124 tests passed**
- Overall command: **exit code 0**

একটি successful verification-কে শুধু “tests passed” বলে গ্রহণ করবেন না; command-এর exit code অবশ্যই 0 হতে হবে।

## 9. Runtime health

Gateway চালু থাকলে:

```bash
curl -fsS http://127.0.0.1:18800/health
curl -fsS http://127.0.0.1:18800/gateway/health
curl -fsS http://127.0.0.1:8000/metrics
```

Expected result: তিনটি endpoint-ই সফল response দেবে।

## 10. Security এবং packaging review

নিচেরগুলো পরীক্ষা করুন:

```bash
find . -type f \( -name '.env' -o -name '*.key' -o -name '*.pem' \) -not -path './node_modules/*'
find . -type f -size +50M -not -path './node_modules/*' -print
```

- Secrets archive-এ থাকা যাবে না।
- Runtime database, PID file, logs বা local credentials archive-এ থাকা উচিত নয়।
- `node_modules` archive-এ থাকার কথা নয়; clean install reproducibility যাচাই করুন।
- `package-lock.json` থাকলে dependency reproducibility যাচাই করুন।

## Reviewer conclusion format

Verification শেষে এই format-এ report দিন:

```text
[PASS/FAIL] TypeScript CLI port
[PASS/FAIL] Workflow durability and leases
[PASS/FAIL] Queue corruption recovery
[PASS/FAIL] Scheduler timeout and catch-up
[PASS/FAIL] Supervisor lifecycle
[PASS/FAIL] Frontend build and warning cleanup
[PASS/FAIL] Bounded soak
[PASS/FAIL] Full workspace tests
[PASS/FAIL] Runtime health

Failures:
- ...

Risks or follow-up work:
- ...
```

যদি কোনো test fail করে, failure-এর সম্পূর্ণ command, exit code, relevant stack trace এবং সংশ্লিষ্ট file/line উল্লেখ করুন। অনুমান করে PASS লিখবেন না।
