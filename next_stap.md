# Agent Miki — Next Steps for Continued Development

এই document-টি Claude বা অন্য কোনো senior engineer-কে দেওয়ার জন্য তৈরি করা হয়েছে। প্রথমে `verify.md` অনুসরণ করে বর্তমান implementation independently verify করতে হবে। Verification fail করলে নতুন feature শুরু করা যাবে না; আগে failure reproduce, classify এবং fix করতে হবে।

## Current baseline

বর্তমান repository-তে নিচের কাজগুলো সম্পন্ন:

- Go CLI-এর পরিবর্তে TypeScript CLI default path-এ যুক্ত হয়েছে।
- Workflow engine-এ durable SQLite state, atomic lease, heartbeat renewal এবং stable step identity যুক্ত হয়েছে।
- Scheduler-এ timeout accounting, persisted catch-up এবং bounded replay যুক্ত হয়েছে।
- Queue corruption visible error এবং recovery backup behavior পায়।
- 24/7 supervisor crash/restart/shutdown lifecycle harden করা হয়েছে।
- Workflow manifest validation এবং generated scaffold gates যুক্ত হয়েছে।
- Vite `__dirname` warning ESM-safe path resolution দিয়ে সরানো হয়েছে।
- Recovery-focused tests, full workspace tests, build, supervisor integration এবং bounded soak সফলভাবে চালানো হয়েছে।

## Priority 1 — Make the soak test production-grade

বর্তমান soak utility bounded health এবং metrics polling করে। এটিকে production monitoring-এর জন্য উন্নত করুন:

1. Configurable failure threshold যোগ করুন, যেমন `--max-consecutive-failures`।
2. Health failure এবং metrics failure আলাদা severity হিসেবে report করুন।
3. Probe latency threshold যোগ করুন এবং slow response আলাদা করুন।
4. RSS এবং file descriptor growth-এর জন্য baseline বনাম final delta report করুন।
5. JSON report-এর পাশাপাশি concise Markdown summary তৈরি করুন।
6. Exit codes স্পষ্ট করুন: healthy, degraded, failed।
7. Supervisor restart counter, queue depth এবং dead-letter count report-এ যুক্ত করুন।

Acceptance criteria:

- Transient single failure এবং sustained failure আলাদা করা যাবে।
- Report-এ failure timestamp, error type, HTTP status এবং latency থাকবে।
- একই command local CI এবং long-running staging environment-এ চালানো যাবে।

## Priority 2 — Add durable recovery integration tests

বর্তমান unit এবং focused tests-এর উপর process-level recovery tests যোগ করুন:

1. Workflow run শুরু করে process terminate করুন; নতুন process-এ resume verify করুন।
2. Running lease expire হলে দ্বিতীয় worker claim করতে পারে কি না verify করুন।
3. Lease holder alive থাকলে duplicate claim reject হচ্ছে কি না verify করুন।
4. SQLite WAL database copy/restore করে state integrity verify করুন।
5. Corrupt queue snapshot-এর recovery backup restore path test করুন।
6. Scheduler downtime-এর পরে bounded catch-up duplicate execution ছাড়া হচ্ছে কি না verify করুন।
7. Gateway crash-এর পরে supervisor restart এবং task continuity verify করুন।

প্রতিটি integration test temporary directory ব্যবহার করবে এবং test শেষে cleanup করবে। কোনো real production database touch করা যাবে না।

## Priority 3 — Add idempotent side-effect receipts

Workflow step retry হলেও external বা filesystem side effect যেন duplicate না হয়:

1. প্রতিটি side effect-এর deterministic effect key নির্ধারণ করুন।
2. Effect receipt store তৈরি করুন।
3. Execute করার আগে receipt lookup করুন।
4. Completed receipt থাকলে original result ফেরত দিন।
5. In-progress receipt-এর জন্য lease বা compare-and-swap ব্যবহার করুন।
6. Failed receipt retry policy স্পষ্ট করুন।
7. Receipt retention এবং cleanup policy document করুন।

এটি file write, shell command এবং connector/API call-এর জন্য আলাদা adapter boundary-তে implement করুন। Blind global deduplication করবেন না; একই command-এর বৈধ repeated execution-এর semantics নষ্ট করা যাবে না।

## Priority 4 — Improve observability

Production diagnosis সহজ করতে:

- Structured event schema version করুন।
- Workflow run ID, task ID, lease owner, attempt এবং effect key সব log context-এ যুক্ত করুন।
- Metrics-এ workflow claims, lease conflicts, recovery resumes, catch-up executions, dead letters এবং supervisor restarts যোগ করুন।
- Health endpoint-এ degraded state-এর কারণ দেখান।
- Secret, API key বা prompt content log না করার automated test রাখুন।

## Priority 5 — Release and deployment safety

1. Clean install test করুন: fresh directory-তে archive extract করে `npm install` এবং build চালান।
2. Production `.env` template এবং required/optional variables document করুন।
3. Startup preflight command যোগ করুন।
4. Backup এবং rollback runbook লিখুন।
5. Schema migration versioning যুক্ত করুন।
6. Release archive-এ `node_modules`, secrets, PID files, runtime databases এবং logs বাদ পড়ছে কি না automated gate-এ পরীক্ষা করুন।
7. Release artifact checksum তৈরি করুন।

## Recommended implementation order

1. `verify.md` চালিয়ে baseline capture করুন।
2. Soak report এবং failure-threshold improvements করুন।
3. Process-level workflow recovery tests লিখুন।
4. Side-effect receipt boundary design ও tests করুন।
5. Observability metrics যুক্ত করুন।
6. Clean-install release verification করুন।
7. Full workspace tests, build, supervisor integration এবং soak আবার চালান।
8. Final remediation report update করুন।

## Engineering constraints

- Secrets commit বা archive করবেন না।
- Production data ব্যবহার করবেন না; temporary test workspace ব্যবহার করুন।
- Existing APIs এবং backward compatibility না ভেঙে migration করুন।
- নতুন behavior-এর আগে regression test লিখুন।
- Retry, timeout, lease এবং idempotency semantics লিখিতভাবে document করুন।
- কোনো test failure-কে warning হিসেবে লুকাবেন না।
- কোনো long-running process unattended রেখে যাবেন না; bounded command বা explicit service lifecycle ব্যবহার করুন।

## Final acceptance gate

পরবর্তী engineer কাজ শেষ বলার আগে অবশ্যই:

```bash
npm test
npm run build --workspace=@miki/core
npm run build:cli
npm run build:frontend
npm run test:supervisor
npm run verify:workflow
npm run runtime:24-7:check
```

এরপর bounded soak চালিয়ে report attach করতে হবে। Failure থাকলে exact command, exit code, root cause এবং remediation status লিখতে হবে।
