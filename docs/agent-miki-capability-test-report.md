# Agent Miki Capability Test Report

**পরীক্ষার তারিখ:** ২৭ আগস্ট ২০২৬

**Repository:** `https://github.com/glayph/agent.git`

**পরীক্ষার revision:** `f049913`

**পরীক্ষার পরিবেশ:** Ubuntu 24.04, Node.js 22.13.0, npm 10.9.0

**পরীক্ষার ধরন:** নিরাপদ local runtime, API, CLI, automated test এবং visual UI verification

## Executive result

Agent Miki-এর বর্তমান runtime সফলভাবে চালু হয়েছে এবং gateway, core backend, memory service ও dashboard end-to-end smoke test পাস করেছে। Authenticated dashboard-এর login, workspace, Drive, Hub, Agent Control, Runs, plugin navigation, plugin catalog, Models, Credentials, Channels, Skills, Tools, Memory, Configuration, Automation, Health, Logs এবং chat error state visualভাবে পরীক্ষা করা হয়েছে। মোট ২২টি screenshot `docs/screenshots/`-এ সংরক্ষিত আছে; screenshot index `docs/screenshot-index.md`-এ দেওয়া হয়েছে।

বর্তমান run-এ model-independent অংশ কার্যকর প্রমাণিত হয়েছে। Repository test suite-এ core-এর ৫৮৬টি এবং installer-এর ৫১টি test পাস করেছে। তবে full native local-model build সম্পূর্ণ হয়নি, কারণ clone-এ platform-native llama.cpp source bundle নেই। Gemini smoke test-এ ব্যবহৃত credential provider-এর পক্ষ থেকে `HTTP 400: Invalid Auth key` ফেরত দিয়েছে। ফলে Gemini বা local LFM inference সফল বলে দাবি করা যাবে না।

> **সঠিক সিদ্ধান্ত:** Agent Miki-এর runtime foundation, dashboard, guarded tools, memory UI, automation UI, health/observability এবং CLI management কার্যকর। Actual AI answer generation, local LFM inference, external channel delivery এবং ২৪/৭ target-host service recovery এখনো সম্পূর্ণভাবে certify করা যায়নি।

## বর্তমান run-এর verified ফলাফল

| ক্ষেত্র | ফলাফল | প্রমাণ |
|---|---|---|
| Core/gateway/frontend build | Native step বাদ দিলে সফল | Build output ও runtime startup log |
| Full `npm run build:all` | ব্যর্থ | Native llama source unavailable |
| Gateway smoke | সফল; gateway/core/memory/dashboard HTTP checks পাস | `docs/evidence/gateway-smoke.json` |
| Dashboard login | সফল | `01-setup.webp`, `02-login.webp`, `03-workspace.webp` |
| Core health | HTTP 200 | Runtime probe |
| CLI version/help/doctor/install preparation | সফল | `docs/evidence/cli-capability.log` |
| Workspace test suite | ৫৮৬/৫৮৬ core এবং ৫১/৫১ installer test পাস | `docs/evidence/cli-model-tests.log` |
| Short soak | ৩টি health check পাস; metrics endpoint auth ছাড়া 401 | `docs/evidence/soak-report.json` |
| Skills UI | ৩৯টি discovered skill দৃশ্যমান | `13-skills.webp` |
| Plugin catalog | Provider, channel ও capability inventory দৃশ্যমান | `09-plugin-catalog.webp` |
| Memory UI | Search, reindex, region filters ও zero-state সঠিকভাবে দৃশ্যমান | `15-memory.webp` |
| Health/doctor UI | Healthy state, doctor pass, zero secret findings দৃশ্যমান | `18-health.webp` |
| Chat execution | Request accepted; missing/rejected provider honestভাবে দেখানো | `21-chat-provider-error.webp` |
| Gemini model smoke | ব্যর্থ; provider বলেছে `Invalid Auth key` | `docs/evidence/verification-summary.txt` |
| Local LFM model | চালানো যায়নি; GGUF/model runtime configured নয় | Model status ও full-build error |

## Agent Miki কী ধরনের কাজ করতে পারে

### ১. Workspace ও local computer কাজ

Miki local workspace-এর মধ্যে file read, file write, file listing, artifact verification, guarded shell execution এবং structured output তৈরি করতে পারে। Tools page-এ `file_read`, `file_write`, `file_delete`, `shell_execute` এবং workspace restriction/risk indicator দৃশ্যমান ছিল। File deletion এবং arbitrary shell action high-risk হিসেবে চিহ্নিত; সেগুলোকে সাধারণ safe operation হিসেবে গণ্য করা যাবে না।

### ২. Code engineering ও testing

Repository-তে Software Engineer ধরনের routing configuration এবং code, debug, test, integration capability সংজ্ঞায়িত আছে। CLI doctor project structure, gateway build এবং network stack পরীক্ষা করেছে। Core ও installer suite পাস করায় code-level orchestration, provider boundary, scheduler, memory, workflow, approval, tool registry এবং persistence সংক্রান্ত বড় অংশ regression-tested।

### ৩. Research ও information handling

Miki-এর local-first search, web search, scrape এবং source-citation-oriented capability আছে। Public web research-এর পূর্ববর্তী benchmark-এ safe source retrieval সফল ছিল; বর্তমান run-এ external research task model credential failure-এর কারণে end-to-end agent answer হিসেবে পুনরায় certify করা হয়নি। OpenCode-এর ক্ষেত্রে official documentation যাচাই করে জানা গেছে যে Zen optional gateway এবং model ID format `opencode/<model-id>`; base URL ছাড়া provided key দিয়ে request পাঠানো হয়নি [7]।

### ৪. Memory ও personalization

Memory page-এ selective retrieval, search, reindex, region filters, chunk inspector এবং scope-fixed credential-safe presentation কার্যকর দেখা গেছে। Runtime health report memory database, active sessions, search endpoint এবং retrieval surface দেখিয়েছে। বর্তমান clean run-এ zero memory chunks দৃশ্যমান ছিল; তাই এই run-এ নতুন fact write/retrieve end-to-end করা হয়নি। পূর্ববর্তী benchmark evidence অনুযায়ী harmless memory write/retrieve সফল ছিল [2]।

### ৫. Planning, workflow ও automation

Hub, Agent Control এবং Automation Center-এ planning, workflow, repeatable automation, execution history, connections, schedule management এবং linked runs-এর UI আছে। Automation page zero-state-এ কোনো workflow নিজে থেকে চালু করেনি। Agent Control draft learning mode, reversible resource profiles এবং typed capability inventory দেখিয়েছে। External side effect বা live schedule ইচ্ছাকৃতভাবে তৈরি করা হয়নি।

### ৬. Safety, governance ও approval boundary

Miki destructive action, external publish, credential handling, MCP activation, tool enablement এবং model management-এর জন্য typed controls ও approval boundary প্রকাশ করে। Config page-এ workspace restriction, command blacklist, scheduled-command permission, MCP enablement এবং bypass restriction আলাদা controls হিসেবে দেখা গেছে। Health page secret scan-এ zero finding দেখিয়েছে। কোনো payment, external post, live channel send, third-party install বা destructive filesystem action চালানো হয়নি।

### ৭. Skills, tools ও plugins

Skills page-এ ৩৯টি discovered skill, search/filter/sort ও view controls দেখা গেছে। Plugin Catalog provider, channel এবং capability family দেখিয়েছে; Tools page shell, filesystem, browser, computer, model, workflow, memory ও skill-related tools-এর risk/status labels দেখিয়েছে। কিন্তু discovered skill, loaded skill এবং callable skill একই বিষয় নয়। পূর্ববর্তী audit-এ runtime loaded skills শূন্য এবং metadata/callable contract gap শনাক্ত হয়েছিল [1]। এই run-এ কোনো skill install বা third-party plugin execution করা হয়নি।

### ৮. Models ও provider management

Models ও Credentials page-এ local llama.cpp এবং Gemini provider management, API-key edit, default selection, local model configuration এবং voice configuration UI দৃশ্যমান। Runtime চারটি model entry দেখিয়েছে, কিন্তু সবগুলো unconfigured। Gemini smoke test invalid key-তে থেমেছে; local LFM-এর জন্য GGUF model path এবং native llama-server প্রয়োজন। Provider readiness না থাকলে chat UI কাজ না করার কারণ স্পষ্টভাবে দেখিয়েছে।

### ৯. Linux/Windows deployment foundation

README অনুযায়ী একই launcher/configuration/dashboard model Linux ও Windows-এর জন্য ব্যবহৃত হয় এবং ২৪/৭ readiness command আছে [3]। বর্তমান Linux run-এ `runtime:24-7:check` gateway artifact পাওয়া গেছে বলে `ok:true` দেখিয়েছে। কিন্তু Windows PowerShell, Task Scheduler, reboot recovery, native Windows llama.cpp, systemd boot recovery এবং multi-hour soak target host-এ পরীক্ষা করা হয়নি। তাই cross-platform claim-এর source evidence আছে, target-host certification নেই [4]।

### ১০. Observability ও recovery

Health page doctor, backup, secret scan, watchdog, queue, delivery recovery, pending restart field এবং component health দেখিয়েছে। Logs page gateway/core startup, memory, provider plugins, disabled channels, MCP prerequisite এবং capability plugin startup record করেছে। Short soak-এ তিনটি core health check পাস করেছে। Prometheus metrics endpoint authentication ছাড়া 401 দিয়েছে; dashboard session বা valid API key দিয়ে আলাদা authenticated probe প্রয়োজন।

## অসম্পূর্ণতা ও release blockers

| অগ্রাধিকার | সমস্যা | প্রভাব | পরবর্তী প্রয়োজন |
|---|---|---|---|
| উচ্চ | Native llama.cpp source bundle অনুপস্থিত | `npm run build:all` এবং full `npm run verify` ব্যর্থ | Linux/Windows compatible source বা prebuilt checksum-pinned executable দিন |
| উচ্চ | Gemini credential invalid | Cloud model answer ও agentic task execution certify করা যায়নি | Valid Gemini key dashboard-এর protected flow-তে configure করুন |
| উচ্চ | Local LFM GGUF configured নয় | Local inference quality/latency যাচাই করা যায়নি | Approved LFM GGUF install/register/start করে health test চালান |
| উচ্চ | Skill discovered বনাম callable contract gap | Metadata skill থাকলেও executable invocation অনিশ্চিত | `loaded/callable` আলাদা status ও typed adapter যোগ করুন |
| মাঝারি | Prometheus endpoint auth-protected | Unauthenticated soak metrics সংগ্রহ করতে পারেনি | Session/API-key authenticated soak run চালান |
| মাঝারি | Windows target-host evidence নেই | PowerShell, Task Scheduler ও reboot recovery uncertified | বাস্তব Windows host-এ acceptance matrix চালান |
| মাঝারি | External integrations credentials absent | Telegram/Discord/Slack/WhatsApp delivery পরীক্ষা হয়নি | আলাদা অনুমোদিত test account ও allow-list দিয়ে probe করুন |
| মাঝারি | Prior audit-এ RL failure ingestion gap | Provider exception থেকে learning signal অসম্পূর্ণ হতে পারে | Exception path structured failure experience persist করুন [1] |

## Screenshots

সব visual screenshot repository-এর `docs/screenshots/` directory-তে আছে। Login, dashboard, প্রতিটি প্রধান page, plugin navigation, provider state, health/logs এবং provider-error chat state আলাদা file হিসেবে রাখা হয়েছে। সূচিপত্র `docs/screenshot-index.md`।

## Final review

এই verification pass-এ কোনো credential, token, password বা private response report/doc/screenshot-এর মধ্যে লেখা হয়নি। Model credential transient environment variable হিসেবে ব্যবহৃত হলেও output-এ key প্রকাশিত হয়নি। কোনো external side effect ঘটেনি। Full build failure এবং Gemini invalid-key failure ইচ্ছাকৃতভাবে failure হিসেবে রিপোর্ট করা হয়েছে; এগুলোকে সফলতা হিসেবে গণ্য করা হয়নি।

বর্তমান evidence অনুযায়ী Agent Miki একটি কার্যকর local-first agent workspace foundation, কিন্তু এটি এখনো valid model configuration এবং target-host ২৪/৭ acceptance evidence ছাড়া সম্পূর্ণ autonomous production agent হিসেবে certify করা যাবে না।

## References

[1]: ./Agent%20Miki%20%E2%80%94%20%E0%A6%AA%E0%A7%82%E0%A6%B0%E0%A7%8D%E0%A6%A3%E0%A6%BE%E0%A6%99%E0%A7%8D%E0%A6%97%20Technical%20Audit%20Report.md "Agent Miki পূর্ণাঙ্গ Technical Audit Report"
[2]: ./Agent%20Miki%20Agentic%20Capability%20Benchmark%20Report.md "Agent Miki Agentic Capability Benchmark Report"
[3]: ../README.md "Agent Miki README"
[4]: ./Agent%20Miki%20Limitation%20Remediation%20Status.md "Agent Miki Limitation Remediation Status"
[7]: https://opencode.ai/docs/zen/ "OpenCode Zen official documentation"
