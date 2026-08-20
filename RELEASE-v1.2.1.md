# Agent Miki — UI Release v1.2.1

**Release status:** Ready for local use and frontend review  
**Release date:** 2026-08-19  
**Primary area:** Professional Chat UI redesign

## Release summary

Agent Miki-এর Chat UI-কে একটি পরিষ্কার, পেশাদার এবং responsive conversational workspace হিসেবে polish করা হয়েছে। নতুন UI single-column conversation canvas ব্যবহার করে; অপ্রয়োজনীয় Chat inspector/right-side panel সরানো হয়েছে। Dark এবং Light Orange theme এখন কেন্দ্রীয়ভাবে sync হয় এবং saved preference অনুযায়ী page reload-এর পরও সঠিকভাবে থাকে।

## প্রধান পরিবর্তন

| ক্ষেত্র | v1.2.1 পরিবর্তন |
|---|---|
| Chat layout | Single-column workspace; অপ্রয়োজনীয় side panel ও inspector mounting বাদ |
| Theme | Hard-coded dark bootstrap সরানো; AppProviders-এ কেন্দ্রীয় theme synchronization |
| Light Orange palette | উষ্ণ off-white canvas, orange-tinted user bubbles, borders, shadows ও focus states |
| Dark palette | Near-black surfaces, warm orange accents, readable user bubbles ও composer contrast |
| Header | Responsive spacing, translucent backdrop, stronger typography ও status hierarchy |
| Conversation | Readable content width, improved vertical rhythm, assistant response card ও attachment surfaces |
| User messages | Rounded orange bubble, bottom-corner distinction, improved line-height ও image treatment |
| Composer | Elevated rounded surface, accessible controls, orange send action, focus glow ও polished attachments |
| Release metadata | Root এবং frontend package version `1.2.1` |

## QA ফলাফল

Frontend production build সফল হয়েছে। Frontend automated test suite-এ 12টি test file-এর 43টি test সফল হয়েছে এবং lint কোনো error বা warning ছাড়াই সম্পন্ন হয়েছে। Browser-এ Chat page reload করে Light mode এবং Dark mode উভয়ই যাচাই করা হয়েছে। Light mode-এ chat surface `#fffaf7` এবং composer surface `#fffdfb` সক্রিয় ছিল; Dark mode-এ near-black surface ও orange accent সঠিকভাবে render হয়েছে।

বাস্তব browser Chat message সফলভাবে submit হয়েছে এবং user bubble, running state, loading state ও composer layout সঠিকভাবে render হয়েছে। এরপর Gemini provider `Model quota or rate limit reached` error দিয়েছে। UI error card ভেঙে পড়েনি; বরং পরিষ্কারভাবে quota reset, billing, lower traffic বা fallback provider/model ব্যবহারের নির্দেশ দেখিয়েছে। এটি UI build বা layout failure নয়; এটি বহিরাগত provider quota limitation।

> **নিরাপত্তা:** Gemini API key কোনো source file, release note, log বা delivered archive-এ লেখা হয়নি। Runtime credential process environment/dashboard configuration-এ রাখুন এবং প্রয়োজনে প্রকাশিত key rotate করুন।

## Run instructions

প্রকল্প directory-তে গিয়ে root dependency ও frontend dependency ইনস্টল করার পর backend build এবং frontend build চালান। বিদ্যমান launcher ব্যবহার করে gateway ও Web UI চালু করুন। Browser-এ `http://127.0.0.1:18800/` খুললে Miki Chat UI দেখা যাবে। Gemini quota সমস্যা থাকলে Models page থেকে একটি available fallback provider/model configure করুন।

```bash
cd AgentMiki-plan-first-v1.2.1
npm install
cd packages/ui/frontend
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Delivered version

এই release-এর source archive-এর নাম `AgentMiki-plan-first-v1.2.1.zip`। QA evidence `chat-ui-qa-v1.2.1.md` ফাইলে রাখা হয়েছে।

## References

এই release note-এ কোনো external source ব্যবহার করা হয়নি; তথ্যগুলো local build, automated tests এবং browser runtime verification থেকে সংগৃহীত।

— **Manus AI**
