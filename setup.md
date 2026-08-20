# Agent Miki Setup Guide

**Project:** Agent Miki  
**Version:** `1.3.3`  
**Archive:** `AgentMiki-v1.3.zip`

এই ফাইলে Agent Miki সম্পূর্ণভাবে প্রস্তুত, build এবং run করার জন্য ব্যবহৃত command-গুলোর ধারাবাহিক তালিকা দেওয়া হলো। সব command Ubuntu/Linux shell-এর জন্য লেখা।

## 1. Archive extract করা

```bash
rm -rf /home/ubuntu/AgentMiki-v1.3
mkdir -p /home/ubuntu/AgentMiki-v1.3
unzip -q /home/ubuntu/upload/AgentMiki-v1.3.zip -d /home/ubuntu/AgentMiki-v1.3
```

Extract করা project directory-তে প্রবেশ করুন:

```bash
cd /home/ubuntu/AgentMiki-v1.3/AgentMiki-plan-first-v1.3.0
```

Project files যাচাই করার জন্য ব্যবহৃত command:

```bash
find /home/ubuntu/AgentMiki-v1.3 -maxdepth 3 -type f \
  | sed 's#^/home/ubuntu/AgentMiki-v1.3/##' \
  | sort \
  | head -200
```

## 2. Dependency install করা

```bash
npm install
```

এই command-এর মাধ্যমে root workspace এবং সব `@miki/*` package-এর dependency install হয়।

## 3. Build-এর আগে stale cache পরিষ্কার করা

Archive-এ পুরোনো TypeScript incremental build metadata থাকলে `@miki/config` বা `@miki/installer` module resolve না-ও হতে পারে। নিরাপদভাবে generated build output এবং stale TypeScript cache পরিষ্কার করতে ব্যবহৃত command:

```bash
rm -rf packages/config/dist \
       packages/installer/dist \
       packages/skills/dist \
       packages/core/dist \
       packages/gateway/dist \
       packages/config/.tsbuildinfo \
       packages/installer/.tsbuildinfo \
       packages/skills/.tsbuildinfo \
       packages/core/.tsbuildinfo \
       packages/gateway/.tsbuildinfo
```

## 4. সব workspace build করা

```bash
npm run build:all
```

এই script নিম্নলিখিত workspace-গুলো ধারাবাহিকভাবে build করে:

```text
@miki/config
@miki/installer
@miki/skills
@miki/memory
@miki/core
@miki/gateway
```

সংক্ষেপে, `npm run build:all`-ই সম্পূর্ণ Agent Miki build করার মূল command।

## 5. Development setup চালানো

```bash
npm run dev
```

সফল হলে সাধারণত নিচের ধরনের output দেখা যাবে:

```text
[miki] Monorepo is ready. Use gateway/core start scripts for full runtime.
[miki] OK — setup complete.
```

এই project-এর `npm run dev` command monorepo setup এবং memory system প্রস্তুত করে। এটি নিজে persistent HTTP server চালু না-ও রাখতে পারে। Gateway আলাদাভাবে চালানোর জন্য project-এর মূল command:

```bash
npm run start --workspace=@miki/gateway
```

## 6. সম্পূর্ণ ধারাবাহিক command

নতুন archive extract করে শুরু থেকে চালানোর সংক্ষিপ্ত workflow:

```bash
rm -rf /home/ubuntu/AgentMiki-v1.3
mkdir -p /home/ubuntu/AgentMiki-v1.3
unzip -q /home/ubuntu/upload/AgentMiki-v1.3.zip -d /home/ubuntu/AgentMiki-v1.3
cd /home/ubuntu/AgentMiki-v1.3/AgentMiki-plan-first-v1.3.0
npm install
rm -rf packages/config/dist packages/installer/dist packages/skills/dist packages/core/dist packages/gateway/dist packages/config/.tsbuildinfo packages/installer/.tsbuildinfo packages/skills/.tsbuildinfo packages/core/.tsbuildinfo packages/gateway/.tsbuildinfo
npm run build:all
npm run dev
```

## 7. Verified project archive তৈরি করা

Dependencies এবং generated build output বাদ দিয়ে source archive তৈরি করার command:

```bash
cd /home/ubuntu/AgentMiki-v1.3/AgentMiki-plan-first-v1.3.0
rm -f /home/ubuntu/AgentMiki-v1.3.3-verified.zip
zip -qr /home/ubuntu/AgentMiki-v1.3.3-verified.zip . \
  -x 'node_modules/*' \
     '*/node_modules/*' \
     'packages/*/dist/*' \
     '*/dist/*' \
     'packages/*/.tsbuildinfo' \
     '*/.tsbuildinfo' \
     'data/*.pid'
```

Archive যাচাই করার command:

```bash
unzip -l /home/ubuntu/AgentMiki-v1.3.3-verified.zip | tail -5
stat -c '%n %s bytes' /home/ubuntu/AgentMiki-v1.3.3-verified.zip
```

## গুরুত্বপূর্ণ নোট

`npm install` চলাকালে Node.js version-এর কারণে `undici` engine warning এবং কিছু deprecated-package warning দেখা যেতে পারে। এগুলো installation বা build ব্যর্থ করেনি। যাচাই করা environment-এ `npm install`, `npm run build:all`, এবং `npm run dev` সফলভাবে সম্পন্ন হয়েছে।

**শেষ যাচাইকরণ version:** `Agent Miki v1.3.3`
