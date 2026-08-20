# Agent Miki Version

**Version:** `1.3.3`

**Release date:** 2026-08-20

এই release-এ Agent Miki-এর adaptive orchestration-এর ওপর **plan-first disciplined developer workflow** যুক্ত হয়েছে। এখন প্রতিটি request-এ planning stage-এই requirements, existing skills/tools, missing capabilities, online research need, plugin/library need, project-file need এবং approval requirement শনাক্ত করা হয়। Planning চলাকালে কোনো skill, plugin, library, credential বা external resource নিজে থেকে install/download করা হয় না।

পরবর্তী implementation stage-এ কেবল অনুমোদিত ও প্রয়োজনীয় capability ব্যবহার করার জন্য এই report model context, route-preview response এবং compact structured memory event-এ প্রকাশিত হয়।

আগের `1.1.0-adaptive` behavior—per-turn capability selection, contextual pruning, bounded tool budget এবং execution allowlist—এই release-এ বজায় আছে।

**Runtime verification:** `npm install`, `npm run build:all`, এবং `npm run dev` সফলভাবে সম্পন্ন হয়েছে।
