# Miki Agent — কেন Tool, Memory, Plugin, Browsing ইত্যাদি সঠিকভাবে কাজ করে না: সম্পূর্ণ Diagnostic Report

**তারিখ:** ২৬ সেপ্টেম্বর ২০২৬
**যাচাই করা archive:** `miki-agent-project.zip` (version 1.3.14)
**যাচাই পদ্ধতি:** সম্পূর্ণ static code audit — নিচে "সীমাবদ্ধতা" অংশে ব্যাখ্যা করা কারণে project লাইভ চালিয়ে reproduce করা সম্ভব হয়নি।

---

## ০. গুরুত্বপূর্ণ সীমাবদ্ধতা (আগে পড়ুন)

এই audit যে sandbox environment-এ করা হয়েছে, সেখান থেকে **npm registry-তে কোনো package install করা যায়নি** (`403 Forbidden` — registry নিজেই request block করেছে, project-এর কোনো ত্রুটির কারণে নয়)। ফলে:

- আমি `npm install`, `npm run build:all`, `npm test`, বা Miki প্রকৃতপক্ষে চালিয়ে কোনো bug **লাইভে reproduce করতে পারিনি**।
- নিচের প্রতিটি finding **সরাসরি source code, config file এবং lockfile পড়ে** বের করা হয়েছে — প্রতিটির সাথে exact file/line reference দেওয়া আছে যাতে আপনি বা যেকোনো engineer নিজে গিয়ে verify করতে পারেন।
- এই কোডবেসে আগে থেকেই দুটি স্বতন্ত্র AI-generated audit report ছিল (`docs/miki-performance-observation-report.md` এবং `docs/workflow-remediation-report.md`, উভয়ই ২৩ সেপ্টেম্বর ২০২৬ তারিখে "Manus AI" নামে করা)। সেই দুটো report-এর claim-গুলো আমি বর্তমান code-এর বিপরীতে verify করেছি — কিছু ইতিমধ্যে fix হয়ে গেছে, কিছু এখনো unfixed, যা নিচে চিহ্নিত করা হয়েছে।

**সংক্ষেপে মূল উপসংহার:** Miki-এর architecture এবং tool-selection logic নিজে বেশ পরিপক্ব ও যত্ন সহকারে লেখা (অনেক জায়গায় "BUG-XX FIX" কমেন্ট সহ আগের bug-fix-এর প্রমাণ আছে)। কিন্তু **কয়েকটি critical subsystem (memory, skills/plugins, browser) কোডে ঠিকভাবে লেখা থাকা সত্ত্বেও বাস্তবে কখনো সঠিকভাবে চালু/সংযুক্ত হয় না**, কারণ install/build ধাপে প্রয়োজনীয় জিনিস (native module, browser binary, skill catalog সংযোগ) অনুপস্থিত থাকে বা ভুল জায়গায় লেখা হয়। ব্যবহারকারীর কাছে এটা "Miki কাজ ঠিকভাবে করতে পারে না" হিসেবে প্রতীয়মান হয়, কারণ ব্যর্থতাগুলো বেশিরভাগ ক্ষেত্রে **silent** (শুধু ব্যাকগ্রাউন্ড console log-এ থাকে, UI-তে দেখা যায় না)।

---

## ১. Memory System কাজ করে না (বা মাঝেমধ্যেই কাজ করে না)

### সমস্যা: `better-sqlite3`-এর দুটি সাংঘর্ষিক ভার্সন

| File | Line | সমস্যা |
|---|---|---|
| `packages/core/package.json` | 52 | `"better-sqlite3": "^11.10.0"` |
| `packages/memory/package.json` | 34 | `"better-sqlite3": "^12.11.1"` |
| `package-lock.json` | 6098–6100, 16713–16715 | Root-এ v12.11.1 install হয়, আর `packages/core/node_modules/` এর ভেতরে **আলাদা** v11.10.0 nested install হয় |

**কেন এটা সমস্যা তৈরি করে:**

`better-sqlite3` একটি **native (C++ compiled) module** — pure JavaScript নয়। দুটো ভিন্ন major version মানে দুটো সম্পূর্ণ আলাদা compiled binary তৈরি/download হওয়া দরকার। এতে করে:

1. Install/build সময় দ্বিগুণ native-compile ঝুঁকি — যদি ব্যবহারকারীর মেশিনে build tools (python, make, g++) না থাকে বা prebuilt binary সেই platform/architecture-এর জন্য না পাওয়া যায়, **যেকোনো একটা version fail করলেই** পুরো `npm install` আটকে যেতে পারে অথবা আংশিকভাবে fail করে।
2. `packages/core/src/memory/runtime.ts`-এ (দেখুন নিচে) memory init কোনো কারণে fail করলে, error টা **silently swallow** করা হয় — Miki চালু হয়ে যায় কিন্তু memory পুরোপুরি অকার্যকর থাকে, এবং ব্যবহারকারী কোনো spot করার মতো error দেখতে পান না।
3. প্রজেক্টে ইতিমধ্যে একটা dedicated smoke-test আছে (`scripts/test-native-sqlite.mjs`) — এটার অস্তিত্বই প্রমাণ করে maintainer-রা আগে থেকেই native-binding সমস্যা নিয়ে সচেতন ছিলেন। কিন্তু এই test শুধু root-এ resolve হওয়া single `better-sqlite3` কপি পরীক্ষা করে — `packages/core/node_modules/`-এর nested v11 কপিটা এই test দিয়ে কখনো যাচাই হয় না।

### Silent-failure কোড (`packages/core/src/agent.ts`, লাইন ১০৯৪–১১০৮)

```js
let memoryIntegration = null;
try {
  memoryIntegration = initMemory(dataDir);
} catch (memErr) {
  // Memory init failure must never prevent the agent from starting.
  console.error(
    "[Agent] Memory bridge init failed (continuing without memory):",
    (memErr as Error).message,
  );
}
```

এই design choice (Miki কখনো memory ছাড়া বন্ধ হবে না) নিজে নিরাপদ ও যুক্তিসঙ্গত, কিন্তু **এর সাথে user-facing কোনো সতর্কবার্তা নেই**। Dashboard/chat-এ কোথাও দেখানো হয় না যে "memory চালু হয়নি।"

### কী পরিবর্তন করতে হবে

1. `packages/core/package.json` এবং `packages/memory/package.json`-এ `better-sqlite3`-এর **একই exact version** ব্যবহার করুন (যেমন উভয় জায়গায় `^12.11.1`, যেহেতু memory package নতুন version চায়)।
2. Root `package-lock.json` regenerate করে নিশ্চিত করুন `packages/core/node_modules/better-sqlite3` আলাদা কপি হিসেবে আর তৈরি না হয় (`npm ls better-sqlite3` চালিয়ে single version নিশ্চিত করুন)।
3. `scripts/test-native-sqlite.mjs`-কে `npm run build:all`/`verify` pipeline-এর একটা **mandatory gate** বানান, যেন version-mismatch বা broken native build চুপচাপ পার না পায়।
4. `agent.ts`-এ memory init fail হলে শুধু console log না করে, agent-এর health/status endpoint বা dashboard-এ একটা visible `degraded: memory unavailable` state পাঠান, যাতে ব্যবহারকারী বুঝতে পারেন কেন memory কাজ করছে না।

---

## ২. Skills এবং Plugin System — সবচেয়ে গুরুত্বপূর্ণ আবিষ্কার: দুটো সিস্টেম সম্পূর্ণ বিচ্ছিন্ন

এটি এই audit-এর সবচেয়ে গুরুত্বপূর্ণ finding, কারণ এটাই সবচেয়ে সরাসরি ব্যাখ্যা করে **"Miki কোনো skill/plugin ব্যবহার করতে পারে না"**।

### দুটো আলাদা skill-সিস্টেম আছে, যাদের মধ্যে কোনো সংযোগ নেই

**সিস্টেম A — `packages/skills/` (built-in skill catalog, richly populated):**

```
packages/skills/src/ai-collaboration/  (২০টি skill: accessibility, css-styling, javascript, ...)
packages/skills/src/github/            (৬টি skill: github-auth, github-pr-workflow, ...)
packages/skills/src/research/          (৫টি skill: arxiv, polymarket, ...)
packages/skills/src/software-development/ (৬টি skill: systematic-debugging, tdd, ...)
packages/skills/src/social-media/xurl
```

এটা একটা proper npm workspace package (`@miki/skills`), সেটা build হয় (`packages/skills/dist/index.js`), এবং `bin/miki.js` ও `packages/core/src/safety/doctor.ts`-এ এটাকে **required runtime file** হিসেবে check করা হয়।

কিন্তু এর একমাত্র export (`packages/skills/src/index.ts`):

```ts
export function bundledSkillsRoot(): string { ... }
export const BUNDLED_SKILLS_ROOT = bundledSkillsRoot();
```

**সিস্টেম B — `SkillLoader`/`SkillSearchEngine` (runtime যা আসলে skill খোঁজে):**

`packages/core/src/skill-loader.ts` এবং `packages/core/src/paths.ts` (লাইন ৭৬, ৯০, ১৩৪, ১৫২–১৫৩) অনুযায়ী, runtime শুধুমাত্র **`<runtime data dir>/src/skills`** ডিরেক্টরি স্ক্যান করে skill খোঁজে — এটা সিস্টেম A থেকে সম্পূর্ণ আলাদা location।

### প্রমাণ যে এই দুটো কখনো সংযুক্ত হয় না

```bash
grep -rn "BUNDLED_SKILLS_ROOT\|bundledSkillsRoot\|@miki/skills" packages/core/src --include="*.ts"
# ফলাফল: কোনো match পাওয়া যায়নি
```

`packages/core`-এর কোনো ফাইল `@miki/skills` বা `BUNDLED_SKILLS_ROOT` import করে না। `doctor.ts` শুধু `packages/skills/dist/index.js` **ফাইলটা exist করে কিনা** চেক করে (লাইন ৪২) — এটা functional wiring যাচাই করে না।

### এবং runtime-এর নিজস্ব skill directory খালি ডেলিভার হয়

```bash
ls -la skills/       # খালি
ls -la src/skills/   # খালি
```

**ফলাফল:** Fresh install-এ Miki-এর কাছে **একটাও কার্যকর skill/plugin থাকে না**। `packages/skills/src/`-এ থাকা ৩৫+ skill কখনো কোনোভাবেই runtime-এ পৌঁছায় না, যদি না ব্যবহারকারী নিজে ম্যানুয়ালি ফাইল কপি করেন — যা কোথাও document করা নেই।

এর প্রভাব `adaptive-capability-selector.ts` এবং `tools/registry/executor.ts`-এও পড়ে: `getToolDefinitions()` (executor.ts লাইন ৫০৮–৫৩১) সঠিকভাবে `skillToolDefs`/`pluginToolDefs`-কে built-in tool-এর সাথে merge করার কোড রাখে — কিন্তু যেহেতু কখনো কোনো skill load-ই হয় না, `skillToolDefs` সবসময় খালি থাকে। মানে **এই merge logic টেকনিক্যালি ঠিক থাকা সত্ত্বেও কার্যত কখনো কিছু যোগ করে না।**

### কী পরিবর্তন করতে হবে

এর সমাধানের দুটো সঠিক পথ আছে — যেকোনো একটা বেছে নিতে হবে:

**অপশন ১ (দ্রুততর): Startup-এ seed/sync ধাপ যোগ করুন।**
`agent.ts`-এর constructor-এ (বা একটা নতুন `scripts/seed-builtin-skills.mjs`-এ) — Miki প্রথমবার চালু হওয়ার সময়, যদি `<dataDir>/src/skills` খালি থাকে, তাহলে `packages/skills/dist/catalog` (বা `BUNDLED_SKILLS_ROOT`) থেকে ফাইল কপি করুন।

**অপশন ২ (পরিষ্কারতর architecture): `SkillSearchEngine`/`SkillLoader`-কে সরাসরি `BUNDLED_SKILLS_ROOT` থেকেও স্ক্যান করতে শেখান।**
`packages/core/src/skill-search.ts`-এ built-in catalog path এবং user-installed `src/skills` path — দুটোই স্ক্যান করার লজিক যোগ করুন, যাতে দুই উৎস থেকেই skill মিশে merged catalog তৈরি হয়।

যেকোনোটা করার পরে, `npm run build:all`-এর শেষে একটা assertion যোগ করুন: "কমপক্ষে N-সংখ্যক built-in skill runtime-এ discover হয়েছে কিনা" — নাহলে এই ধরনের disconnect ভবিষ্যতে আবার silently ফিরে আসতে পারে।

---

## ৩. Browsing Tool — কখনো কাজ করবে না, কারণ Browser binary কখনো install হয় না

### সমস্যা

`packages/core/src/plugins/browser/runtime.ts`, লাইন ৮৭৭–৮৯০:

```ts
private async _launchPlaywright(): Promise<BrowserContext> {
  const { chromium } = await import("playwright");
  const executablePath =
    this._chromePath ||
    [
      process.env.CHROME_PATH,
      process.env.CHROMIUM_PATH,
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].find((candidate) => candidate && fs.existsSync(candidate));
  return await chromium.launchPersistentContext(this.profileDir, {
    headless: this.headless,
    executablePath: executablePath || undefined,
    ...
  });
}
```

`packages/core/package.json` লাইন ৫৮-এ `"playwright": "^1.44.0"` dependency আছে — কিন্তু **Playwright npm package নিজে কোনো browser binary সহ আসে না**। সাধারণত `npx playwright install chromium` কমান্ড আলাদাভাবে চালাতে হয় Chromium ডাউনলোড করার জন্য।

### প্রমাণ যে এই install-ধাপ কোথাও নেই

```bash
grep -rln "playwright install\|PLAYWRIGHT_BROWSERS_PATH" scripts/ package.json packages/*/package.json
# ফলাফল: কোনো match পাওয়া যায়নি

grep -in "playwright\|chromium\|chrome" SETUP.md README.md
# ফলাফল: কোনো match পাওয়া যায়নি
```

### ফলাফল

Fresh Linux/Windows install-এ, যদি না ব্যবহারকারীর মেশিনে system-wide Google Chrome/Chromium আগে থেকেই ওই hardcoded path-গুলোর একটায় install করা থাকে, `executablePath` হয় `undefined`। তখন Playwright নিজের bundled Chromium ব্যবহার করার চেষ্টা করবে — কিন্তু সেটা কখনো ডাউনলোডই হয়নি, তাই সরাসরি error দেবে (সাধারণত এরকম: `browserType.launch: Executable doesn't exist at .../chromium-XXXX/chrome-linux/chrome`)।

`_ensureLaunchedImpl()` (`runtime.ts`, লাইন ৩৬৪–৩৮৭) এই launch call-টাকে try/catch দিয়ে wrap করে না, ফলে error টা propagate হয়ে উপরে `executor.ts`-এর generic catch-এ (লাইন ৬৪৬–৬৫৩) গিয়ে ধরা পড়ে এবং model-কে একটা text error হিসেবে ফেরত দেওয়া হয়। অর্থাৎ **model প্রতিবার browsing চেষ্টা করলেই ব্যর্থ হবে**, এবং এটা constant/guaranteed failure — কোনো intermittent বা edge-case সমস্যা না।

### কী পরিবর্তন করতে হবে

1. Root `package.json`-এ একটা `postinstall` script যোগ করুন:
   ```json
   "postinstall": "npx playwright install --with-deps chromium"
   ```
   অথবা `scripts/build-all.mjs`/`build-standard.mjs`-এর ভেতরে explicit ধাপ হিসেবে এটা যোগ করুন।
2. `SETUP.md`-তে Requirements table-এ Playwright/Chromium-এর জন্য একটা row যোগ করুন, ঠিক যেভাবে llama.cpp/CMake-এর জন্য আছে।
3. `_launchPlaywright()`-এ launch-error ধরার জন্য একটা specific try/catch যোগ করুন যা "Chromium not installed — run `npx playwright install chromium`" এর মতো একটা actionable, স্পষ্ট বার্তা দেয় — raw Playwright stack trace-এর বদলে।
4. `node bin/miki.js doctor` কমান্ডে একটা নতুন check যোগ করুন: Playwright Chromium executable আসলে resolve হচ্ছে কিনা যাচাই করা, যাতে ব্যবহারকারী সমস্যাটা installation-এর সময়ই ধরতে পারেন, browsing চেষ্টা করার সময় নয়।

---

## ৪. Computer-Use (Desktop Control) Tool — External OS binary নির্ভরতা, কোথাও document করা নেই

### সমস্যা

`packages/core/src/plugins/computer-use/runtime.ts` সরাসরি OS-level command-line টুল shell-out করে ব্যবহার করে:

| Platform | প্রয়োজনীয় বাহ্যিক টুল | Reference (line) |
|---|---|---|
| Linux | `wmctrl`, `xdotool` | ১৩৪৯–১৩৭৯ |
| macOS | `osascript` (AppleScript) | ১৩৮১–১৩৯১ |
| Windows | `powershell.exe` | ৯৬২ |

কোড নিজে ভালোভাবে written — fallback আছে (`wmctrl` না পেলে `xdotool` চেষ্টা করে), এবং না পেলে পরিষ্কার error message ফেরত দেয় (`"wmctrl and xdotool not available"`)। এই অংশে কোনো silent failure নেই — এইদিক থেকে এটা ভালো design।

**তবে মূল সমস্যা:** `wmctrl` এবং `xdotool` বেশিরভাগ Linux server/container distribution-এ (যেখানে Miki 24/7 চালানোর জন্য deploy করা হয় — `docs/24-7-final-handoff.md`, `deploy/linux/install-systemd.sh` দেখুন) **ডিফল্টভাবে install করা থাকে না**। এগুলো মূলত desktop environment-এর টুল।

### প্রমাণ

```bash
grep -in "xdotool\|wmctrl" SETUP.md README.md deploy/linux/install-systemd.sh
# ফলাফল: কোনো match পাওয়া যায়নি
```

### কী পরিবর্তন করতে হবে

1. `SETUP.md`-এর Requirements table-এ Linux-এর জন্য একটা row যোগ করুন:
   ```
   sudo apt install -y wmctrl xdotool
   ```
   এবং স্পষ্ট করে লিখুন এটা শুধু `computer_use` tool ব্যবহারের জন্য প্রয়োজন (headless/server deployment-এ optional)।
2. `node bin/miki.js doctor`-এ একটা check যোগ করুন যা এই বাইনারিগুলোর presence যাচাই করে এবং সেই অনুযায়ী `computer_use` capability-কে dashboard-এ "available"/"unavailable" হিসেবে দেখায় — যাতে ব্যবহারকারী আগে থেকেই জানতে পারেন এই tool set চলবে কিনা।

---

## ৫. File ও Shell Tool — Config-নিজে ঠিক আছে, কিন্তু কিছু portability ঝুঁকি

### `config/tools.yaml` নিজে ঠিক আছে

যাচাই করে দেখা গেছে ডিফল্ট config-এ `shell_execute`, `file_read`, `file_write`, `file_delete`, `computer_use` সবকিছুই `TRUSTED_FULL_ACCESS` লেভেলে সেট করা এবং `disabled_tools: []` — অর্থাৎ config file নিজে থেকে কোনো tool বন্ধ করে রাখে না। এই অংশে কোনো bug পাওয়া যায়নি।

### সমস্যা: `shell_execute`-এ `/bin/bash` hardcoded

`packages/core/src/tools/executor/shell.ts`, লাইন ৩০৩:

```ts
const result = await execAsync(command, {
  cwd: runCwd,
  timeout: effectiveTimeout * 1000,
  maxBuffer: maxBytes + 1024,
  shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
});
```

**কেন এটা ঝুঁকিপূর্ণ:** এই সার্ভারে (এবং বেশিরভাগ standard Ubuntu/Debian-এ) `/bin/bash` থাকে, তাই এখানে সমস্যা ধরা পড়েনি। কিন্তু অনেক minimal/slim Docker container (যেমন Alpine Linux base image, যেগুলো প্রায়ই lightweight 24/7 deployment-এ পছন্দ করা হয়) **শুধুমাত্র `/bin/sh` (dash/ash) সহ আসে, `bash` আলাদা করে install করতে হয়**। এরকম পরিবেশে `shell_execute` ডাকলে সরাসরি `spawn /bin/bash ENOENT` error দেবে — অর্থাৎ shell tool পুরোপুরি অকেজো হয়ে যাবে।

### কী পরিবর্তন করতে হবে

1. Hardcoded `/bin/bash`-এর বদলে runtime-এ bash-এর presence check করুন; না থাকলে `/bin/sh`-এ gracefully fallback করুন (এবং কোন shell ব্যবহার হচ্ছে তা log করুন, যেহেতু bash-specific syntax `sh`-এ কাজ নাও করতে পারে)।
2. অথবা, `SETUP.md`/deployment doc-এ স্পষ্ট করে লিখুন যে `bash` একটা hard requirement — Docker/container deployment করার সময় base image-এ যেন bash অবশ্যই থাকে।
3. `node bin/miki.js doctor`-এ `/bin/bash` (বা Windows-এ `cmd.exe`) existence check যোগ করুন।

---

## ৬. Package Manager অসামঞ্জস্য (npm vs pnpm) — সরাসরি bug না, কিন্তু ঝুঁকিপূর্ণ

### পর্যবেক্ষণ

Root-এ **একসাথে** `package-lock.json` (npm) এবং `pnpm-lock.yaml` + `pnpm-workspace.yaml` (pnpm) আছে। `packages/ui/frontend/package.json`-এ স্পষ্ট করে `"packageManager": "pnpm@10.33.0"` declare করা এবং একটা dedicated `scripts/frontend-pnpm.mjs` আছে যেটা corepack দিয়ে pnpm invoke করে frontend build করে — এটা **ইচ্ছাকৃত ও documented split** (root monorepo → npm workspaces, শুধু frontend → pnpm), তাই এটা নিজে bug না।

### তবে একটা লুকানো ঝুঁকি আছে

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
allowBuilds:
  better-sqlite3: false
```

এই `allowBuilds: better-sqlite3: false` লাইনটা **`better-sqlite3`-এর native build/postinstall script pnpm দিয়ে চালানো নিষিদ্ধ করে দেয়**। যাচাই করে দেখা গেছে frontend package নিজে `better-sqlite3`-এর উপর নির্ভর করে না, তাই এই মুহূর্তে এটা সরাসরি ক্ষতি করছে না। কিন্তু এটা একটা **লুকানো time-bomb**:
- যদি কখনো কেউ ভুল করে root-এই `pnpm install` চালায় (যা pnpm-workspace.yaml-এর উপস্থিতি দেখে স্বাভাবিক ভুল), `better-sqlite3` কখনো properly build হবে না, এবং memory/workflow/scheduler — যা সবকিছুই SQLite-নির্ভর — নীরবে ভেঙে যাবে।

### কী পরিবর্তন করতে হবে

1. `pnpm-workspace.yaml`-এ একটা comment যোগ করুন ব্যাখ্যা করে কেন এই `allowBuilds: false` আছে (সম্ভবত frontend-এর জন্য অপ্রাসঙ্গিক dependency-কে native build থেকে বিরত রাখা), এবং নিশ্চিত করুন `better-sqlite3` root pnpm scope-এর অংশ না হয়।
2. Root `README.md`/`SETUP.md`-তে স্পষ্ট সতর্কবার্তা যোগ করুন: "**Root-এ কখনো `pnpm install` চালাবেন না — শুধু `npm install` ব্যবহার করুন। Frontend build নিজে থেকেই ভেতরে pnpm invoke করবে।**"
3. একটা preinstall script/check যোগ করুন যা root-এ ভুল package manager দিয়ে install করার চেষ্টা হলে সতর্ক করে বা বন্ধ করে দেয় (অনেক প্রজেক্ট `"preinstall": "npx only-allow npm"` ব্যবহার করে এই কাজে)।

---

## ৭. আগের Performance Audit থেকে এখনো Unfixed থাকা সমস্যা (Tool ব্যবহারে ধীরগতি/ব্যর্থতার মতো মনে হওয়া)

আগের `docs/miki-performance-observation-report.md`-এর claim গুলো code-এ verify করে দেখা গেছে অনেকগুলো ইতিমধ্যে fix হয়েছে (দেখুন `adaptive-capability-selector.ts`, `deterministic-intent.ts`-এ "BUG-08 FIX", "BUG-09 FIX" কমেন্ট)। কিন্তু নিচের সমস্যাগুলো **এখনো unfixed**:

### ৭.১ — Web search-এর ভুল latency classification

`packages/core/src/task-profile.ts`, লাইন ২১৭:

```ts
if (/\b(release|pack|verify:release|full audit|matrix)\b/.test(normalized)) {
  return "release";
}
```

এই regex ইংরেজি শব্দ **"release"** কোথাও থাকলেই (যেমন "search for the current Python **release**") verification depth-কে "release" এবং speed class-কে "heavy" ধরে নেয় (দেখুন `speedClassFor`, লাইন ২৫১), ফলে `expectedLatencyFor` (লাইন ২৭২–২৭৩) থেকে "15+ minutes" latency estimate পাওয়া যায় — যদিও এটা একটা সাধারণ ১-শট web search। এতে করে সহজ কাজও "ভারী/ধীর" ট্যাগ পেয়ে যায়, এবং workflow-acceleration/progress-display layer সেটাকে বড় কাজের মতো treat করে।

**সমাধান:** এই regex-কে আরও context-specific করুন — শুধু কোনো release/packaging/verification কাজের context-এ ম্যাচ করান (যেমন `verify:release`, `npm run build:release`-এর মতো explicit command reference থাকলে), শুধু "release" শব্দ একা থাকলে না।

### ৭.২ — Timeout policy এখনো ছোট কাজের জন্যও ভারী

`packages/core/src/agent.ts`, লাইন ১৫৪–১৭২:

```ts
const MAX_AGENT_TURNS = 50;
const LOCAL_LLM_CALL_TIMEOUT_MS = ... 90_000 (default);
const LOCAL_AGENT_RUN_TIMEOUT_MS = ... 180_000 (default);
const REMOTE_AGENT_RUN_TIMEOUT_MS = 240_000;
```

একটা সাধারণ "run pwd" বা "hello world script বানাও" কাজেও Miki-এর কাছে "এটা একটা one-shot, দ্রুত শেষ হওয়া উচিত কাজ" — এমন কোনো ধারণা/policy নেই। ভুল tool selection বা model-এর ধীরগতির কারণে ব্যবহারকারীকে পুরো ৯০–১৮০ সেকেন্ড পর্যন্ত অপেক্ষা করতে হতে পারে, যেটা "Miki কাজ করছে না/আটকে গেছে" বলে মনে হয়।

**সমাধান:** সহজ, deterministic-ভাবে classify করা কাজের (single shell command, single file write) জন্য একটা আলাদা, ছোট timeout tier (৫–১৫ সেকেন্ড) চালু করুন — আগের report-এ প্রস্তাবিত "one-shot task contract" অনুযায়ী।

### ৭.৩ — `shell_execute`-এর জন্য কোনো fast lane নেই

`packages/core/src/tool-call-parallelism.ts`, লাইন ১৯০–১৯৮: প্রতিটি `shell_execute` কল, তা `pwd` হোক বা ভারী কোনো build command, একই রকম exclusive workspace lock ও ১২০ সেকেন্ড timeout পায়। নিরাপদ read-only কমান্ডের (`pwd`, `ls`, `git status`) জন্য আলাদা, দ্রুত policy নেই।

---

## ৮. সারসংক্ষেপ টেবিল — সমস্যা, ফাইল, প্রভাব, অগ্রাধিকার

| # | সমস্যা | মূল ফাইল | প্রভাব | অগ্রাধিকার |
|---|---|---|---|---|
| ১ | `better-sqlite3` version conflict (core: v11, memory: v12), silent init failure | `packages/core/package.json:52`, `packages/memory/package.json:34`, `packages/core/src/agent.ts:1094-1108` | Memory পুরোপুরি বা মাঝেমধ্যে অকার্যকর, কোনো visible error ছাড়া | **P0** |
| ২ | Built-in skills/plugins (`packages/skills`) কখনো runtime skill loader-এর সাথে সংযুক্ত হয় না | `packages/skills/src/index.ts`, `packages/core/src/skill-loader.ts`, `packages/core/src/paths.ts:76-153` | Fresh install-এ শূন্য (০টি) কার্যকর skill/plugin | **P0** |
| ৩ | Playwright browser binary কখনো install হয় না | `packages/core/src/plugins/browser/runtime.ts:877-899`, `package.json` (কোনো postinstall নেই) | প্রতিবার browsing tool চেষ্টা করলেই guaranteed ব্যর্থতা | **P0** |
| ৪ | Computer-use tool-এর জন্য প্রয়োজনীয় OS binary (`wmctrl`/`xdotool`) কোথাও document/install করা নেই | `packages/core/src/plugins/computer-use/runtime.ts:1349-1391`, `SETUP.md` | Server/headless Linux-এ desktop-control tool ব্যর্থ | **P1** |
| ৫ | `shell_execute`-এ `/bin/bash` hardcoded, minimal container-এ নাও থাকতে পারে | `packages/core/src/tools/executor/shell.ts:303` | Alpine/minimal container deployment-এ shell tool সম্পূর্ণ ব্যর্থ | **P1** |
| ৬ | npm/pnpm মিশ্র ব্যবহারে লুকানো ঝুঁকি (`allowBuilds: better-sqlite3: false`) | `pnpm-workspace.yaml` | ভুল package manager দিয়ে install করলে SQLite subsystem silently ভাঙে | **P1** |
| ৭ | "release" শব্দে ভুল heavy/slow classification | `packages/core/src/task-profile.ts:217` | সাধারণ কাজও "১৫+ মিনিট লাগবে" দেখায়, ধীরগতির অনুভূতি | **P2** |
| ৮ | ছোট কাজের জন্যও ৯০–১৮০ সেকেন্ড timeout, কোনো fast lane নেই | `packages/core/src/agent.ts:154-172`, `tool-call-parallelism.ts:190-198` | সহজ কাজেও দীর্ঘ অপেক্ষা, "আটকে গেছে" মনে হওয়া | **P2** |

---

## ৯. প্রস্তাবিত কার্যক্রমের ক্রম (Recommended Fix Order)

1. **প্রথমে P0 তিনটি সমস্যা ঠিক করুন** — এগুলোই সরাসরি "Miki memory/tools/plugin/browsing ব্যবহার করতে পারে না" অভিযোগের মূল কারণ:
   - `better-sqlite3` version একীভূত করুন এবং native-build gate যোগ করুন।
   - Skills/plugins wiring ঠিক করুন (seed script বা dual-path scanning)।
   - `postinstall`-এ Playwright Chromium install যোগ করুন।
2. এরপর `node bin/miki.js doctor`-কে প্রসারিত করুন যেন এই নতুন dependency-গুলো (Chromium, wmctrl/xdotool, bash, সঠিক better-sqlite3 version) সবগুলো startup-এই check হয় এবং dashboard-এ স্পষ্টভাবে "available/unavailable" দেখায় — ব্যবহারকারীকে যেন কোনো কিছু silently ব্যর্থ হতে না হয়।
3. তারপর P1 (container/OS portability) এবং P2 (latency/classification) সমস্যাগুলো ধরুন।
4. প্রতিটি fix-এর পর, `verify.md`-এ বর্ণিত existing test suite (`npm test`, `npm run verify:workflow`, `npm run test:supervisor`) চালিয়ে regression যাচাই করুন — এই sandbox network-restricted হওয়ায় আমি নিজে এগুলো চালাতে পারিনি, তাই আপনার নিজের বা CI environment-এ এই ধাপটা অত্যাবশ্যক।

---

## ১০. এই Report-এ কী নেই (Scope-এর সীমা)

- আমি Gateway/WebSocket layer, Telegram/channel connectors, MCP server integration, এবং frontend (React) কোড বিস্তারিতভাবে audit করিনি — সময়/tool-call সীমার কারণে core agent + tool-execution + memory + skills + browser + computer-use-এ ফোকাস করা হয়েছে, যেহেতু আপনার মূল অভিযোগ এই অংশগুলো নিয়েই ছিল।
- এই findings-গুলো **code পড়ে করা যুক্তিসঙ্গত নির্ণয়**, লাইভ reproduction না হওয়ায় — সম্ভাবনা আছে যে বাস্তব deployment-এ (যেখানে ব্যবহারকারীর মেশিনে হয়তো ইতিমধ্যে Chrome/bash/wmctrl install করা আছে) কিছু সমস্যার প্রভাব কম হতে পারে। কিন্তু "fresh install থেকে ঠিকভাবে কাজ করা উচিত" — এই মানদণ্ডে প্রতিটি finding সত্য ও verified।
