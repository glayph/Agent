# Agent Miki — Gemma 4 E2B Web UI Capability Test Matrix

## Scope

এই পরীক্ষায় Agent Miki-এর ব্যবহারকারীর দেওয়া **৬৯টি capability** কেবল Agent Miki Web UI থেকে যাচাই করা হবে। Answer model হিসেবে শুধু local `Gemma 4 E2B` (`gemma-4-E2B-it-Q4_0`, llama.cpp) ব্যবহার করা হবে। Shell বা source-code verification কেবল Web UI-তে Miki যে ফল দাবি করেছে তা স্বাধীনভাবে cross-check করার জন্য ব্যবহৃত হবে; কোনো capability-কে shell-only success ধরা হবে না।

প্রতিটি test-এর জন্য fresh workspace বা isolated subfolder, একটি নির্দিষ্ট acceptance check, Web UI run trace, এবং independent artifact/process evidence রাখা হবে। Existing repository file পরিবর্তন করতে বলা হবে না, যদি না সেই capability-র test-এ একটি disposable copy ব্যবহার করা হয়।

## Verdict rules

| Verdict | কঠোর অর্থ |
|---|---|
| **১০০% নিখুঁত** | Web UI-তে Miki নিজে সঠিক tool নির্বাচন/ব্যবহার করেছে, প্রত্যাশিত ফল তৈরি করেছে, verification করেছে, এবং independent cross-check-এ কোনো material mismatch নেই। |
| **চেষ্টা করেছে, কিন্তু ১০০% নয়** | Miki task বুঝেছে বা আংশিক execution করেছে, কিন্তু tool call, artifact, exactness, test, verification, reliability, বা completion evidence-এর অন্তত একটি শর্ত ব্যর্থ হয়েছে। |
| **০%** | Web UI run-এ capability-র observable execution হয়নি, ভুল ফল হয়েছে, অথবা safe reproducible test-এ শুরু করার মতো কার্যকর evidence পাওয়া যায়নি। |

একবারের prose reply, deterministic shortcut, বা infrastructure readiness একা ১০০% pass নয়। একই capability-র কয়েকটি sub-check থাকলে সব sub-check pass করতে হবে।

## Level 1 — Basic

| ID | Capability | Web UI acceptance check |
|---|---|---|
| L1-01 | প্রশ্নের উত্তর দেওয়া | একটি নির্দিষ্ট, যাচাইযোগ্য factual prompt-এর সরাসরি সঠিক উত্তর; অপ্রাসঙ্গিক দাবি নয়। |
| L1-02 | Text summarization | প্রদত্ত disposable text-এর মূল বক্তব্য, সীমা ও গুরুত্বপূর্ণ তথ্যসহ faithful summary। |
| L1-03 | Translation | একটি সংক্ষিপ্ত source passage target language-এ অর্থ ও formatting বজায় রেখে অনুবাদ। |
| L1-04 | Text rewriting | একই অর্থ রেখে নির্দিষ্ট tone/length/style-এ rewrite। |
| L1-05 | Information extraction | প্রদত্ত text থেকে নির্দিষ্ট fields structured JSON-এ extract; missing field বানানো যাবে না। |
| L1-06 | File পড়া | Web UI workspace file tool দিয়ে নির্দিষ্ট file পড়ে exact relevant content report। |
| L1-07 | File তৈরি করা | নতুন isolated folder-এ নির্দিষ্ট file/content তৈরি, তারপর read-back। |
| L1-08 | File edit করা | disposable file-এর একটি নির্দিষ্ট অংশ edit, unrelated content অপরিবর্তিত রাখা, read-back। |
| L1-09 | Folder তৈরি/পরিচালনা | folder তৈরি, ভিতরের files list, এবং safe rename/move বা structured management যাচাই। |
| L1-10 | Text search করা | workspace text search tool দিয়ে নির্দিষ্ট match, file path ও context report। |

## Level 2 — Computer Tasks

| ID | Capability | Web UI acceptance check |
|---|---|---|
| L2-01 | Terminal command চালানো | Web UI-তে Miki shell tool দিয়ে safe command চালিয়ে exact stdout report। |
| L2-02 | Program চালানো | disposable program execute করে deterministic output এবং exit status report। |
| L2-03 | Process খুঁজে বের করা | safe process query করে target process শনাক্ত, PID/command evidence report। |
| L2-04 | Process বন্ধ করা | disposable long-running process চালিয়ে Miki সেটি বন্ধ করে; unrelated process স্পর্শ নয়। |
| L2-05 | System information সংগ্রহ | OS/runtime/kernel বা equivalent তথ্য tool দিয়ে সংগ্রহ ও সঠিকভাবে report। |
| L2-06 | CPU/RAM/Disk পরীক্ষা | system metrics command চালিয়ে values ও interpretation report। |
| L2-07 | Log পড়া ও সমস্যা শনাক্ত করা | seeded disposable log থেকে error pattern, probable cause ও evidence শনাক্ত। |
| L2-08 | Configuration পরিবর্তন করা | disposable config edit, syntax validation, read-back এবং changed behavior check। |
| L2-09 | Software/package install করা | safe, small package বা local dependency install, version check এবং rollback/cleanup evidence। |

## Level 3 — Coding

| ID | Capability | Web UI acceptance check |
|---|---|---|
| L3-01 | নতুন project তৈরি | isolated project scaffold, expected files, runnable command। |
| L3-02 | Code লেখা | specified function/feature, syntax check এবং behavior test। |
| L3-03 | Existing code পরিবর্তন | disposable copy-তে targeted change এবং regression test। |
| L3-04 | Bug খুঁজে বের করা | seeded failing test/bug-এর reproducible diagnosis with location/evidence। |
| L3-05 | Bug fix করা | bug fix, original failing case pass, regression case pass। |
| L3-06 | Code refactor করা | behavior-preserving refactor, tests pass এবং diff scoped। |
| L3-07 | Unit test লেখা | implementation-এর জন্য meaningful built-in/unit tests এবং test discovery। |
| L3-08 | Test চালানো | Web UI shell থেকে test command, exit status, pass/fail count report। |
| L3-09 | Build করা | project build command সফল, generated output এবং exit status verify। |
| L3-10 | Compile করা | compiled language বা TypeScript compile, errors absent এবং output existence। |
| L3-11 | Dependency সমস্যা সমাধান | seeded missing/incompatible dependency diagnose, fix, install/build/test। |
| L3-12 | Git commit তৈরি | disposable repository-তে scoped changes commit এবং commit hash/read-back। |
| L3-13 | Git diff বিশ্লেষণ | diff থেকে files, behavioral changes, risk ও missing test accurately report। |

## Level 4 — Autonomous Tasks

| ID | Capability | Web UI acceptance check |
|---|---|---|
| L4-01 | বড় কাজকে ছোট task-এ ভাগ করা | multi-step goal থেকে ordered subtask list, dependencies ও completion gates। |
| L4-02 | নিজে plan তৈরি করা | plan আগে তৈরি, তারপর execution; plan-এর প্রতিটি step traceable। |
| L4-03 | প্রয়োজনীয় tool নির্বাচন করা | task অনুযায়ী minimal correct tools; unnecessary বা unsafe tools নয়। |
| L4-04 | একাধিক tool sequentially ব্যবহার | write → read → execute বা equivalent ordered chain সম্পূর্ণ। |
| L4-05 | একাধিক কাজ parallel করা | independent safe tasks parallel, dependency থাকলে sequential; evidence in trace। |
| L4-06 | কাজের ফলাফল যাচাই করা | claimed artifact/output independent read/list/test দিয়ে verify। |
| L4-07 | ভুল হলে পুনরায় চেষ্টা করা | seeded recoverable failure শনাক্ত, alternative/retry এবং final status। |
| L4-08 | নিজের কাজ পরীক্ষা করা | নিজের generated artifact-এর test/lint/read-back চালানো। |
| L4-09 | অসম্পূর্ণ কাজ শনাক্ত করে শেষ করা | missing artifact বা failed gate শনাক্ত, repair, পুনরায় verify। |
| L4-10 | দীর্ঘমেয়াদি task চালানো | multi-turn or persisted run interruption-safe completion বা honest blocked state। |

## Level 5 — Local Web/App

| ID | Capability | Web UI acceptance check |
|---|---|---|
| L5-01 | Local website তৈরি | isolated local site files তৈরি ও local server run। |
| L5-02 | Frontend তৈরি | functional page, required UI interaction এবং source artifact। |
| L5-03 | Backend তৈরি | local backend endpoint, expected response এবং logs। |
| L5-04 | Database সংযোগ করা | disposable local DB schema/connection/query এবং cleanup। |
| L5-05 | API তৈরি | endpoint, input/output contract, error path এবং local call। |
| L5-06 | API test করা | API test command/request, status/body assertion এবং pass evidence। |
| L5-07 | Browser দিয়ে website পরীক্ষা | Miki browser tool দিয়ে page navigate/interact/check; screenshot বা DOM evidence। |
| L5-08 | UI bug শনাক্ত করা | seeded UI defect reproduce, location/cause report। |
| L5-09 | Full-stack application তৈরি | frontend-backend-data flow end-to-end functional। |
| L5-10 | Application build ও run করা | build, start, health/use-case check এবং shutdown/cleanup। |

## Level 6 — Difficult Agent Tasks

| ID | Capability | Web UI acceptance check |
|---|---|---|
| L6-01 | Existing project সম্পূর্ণ বিশ্লেষণ | architecture, entrypoints, dependencies, risks ও tests evidence-based map। |
| L6-02 | Architecture বুঝে পরিবর্তন করা | scoped architecture change, affected modules এবং regression proof। |
| L6-03 | একাধিক file-এর coordinated modification | related files consistent edit, build/test/read-back। |
| L6-04 | Complex bug debugging | multi-factor failure reproduce, hypotheses eliminate, root cause evidence। |
| L6-05 | Test failure থেকে root cause বের করা | failing output থেকে precise cause এবং relevant source location। |
| L6-06 | নিজে solution তৈরি ও implement করা | requirements থেকে non-trivial solution, implementation এবং verification। |
| L6-07 | Implementation-এর পর পুনরায় test করা | change-এর পরে full relevant test পুনরায় run এবং compare। |
| L6-08 | Failure হলে alternative solution চেষ্টা করা | first approach failure record, alternative approach, final honest result। |
| L6-09 | Project-এর performance optimization | baseline metric, scoped optimization, after metric এবং no-regression test। |
| L6-10 | Security সমস্যা শনাক্ত করা | disposable seeded vulnerability শনাক্ত, impact/evidence এবং safe remediation suggestion। |
| L6-11 | নিজের কাজের final verification করা | final checklist, artifact/diff/test/process evidence cross-check। |

## Level 7 — Maximum Autonomous Test

| ID | Capability | Web UI acceptance check |
|---|---|---|
| L7-01 | Zero-to-working project তৈরি | empty isolated workspace থেকে runnable project, test এবং usable output। |
| L7-02 | Requirement → Plan → Implementation → Test → Fix → Verification | complete trace with all six gates, including at least one seeded fix। |
| L7-03 | অপরিচিত codebase বুঝে feature যোগ করা | unfamiliar disposable repo inspect, feature implement, regression evidence। |
| L7-04 | একাধিক dependency ও service সমন্বয় করা | local services/dependencies contract অনুযায়ী integrate এবং end-to-end check। |
| L7-05 | দীর্ঘ multi-step task সম্পূর্ণ করা | long task survives multiple tool turns and finishes all acceptance gates। |
| L7-06 | Unexpected error থেকে নিজে recovery করা | injected unexpected error, diagnosis, recovery এবং verified continuation। |
| L7-07 | সম্পূর্ণ local environment-এ autonomous software development করা | local-only zero-to-working build with Web UI trace, tests, artifacts and final verification। |

## Evidence record format

প্রতিটি ID-এর জন্য report-এ অন্তত এই fields থাকবে: `run/session`, `model identity`, `prompt`, `observed Web UI trace`, `artifacts`, `independent cross-check`, `verdict`, এবং `failure/root cause`। কোনো item-এর evidence না থাকলে সেটি ১০০% নিখুঁত তালিকায় যাবে না।
