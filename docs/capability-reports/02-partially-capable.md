# Agent Miki Capability Report — Partially or Conditionally Capable

## Classification rule

এই ফাইলে সেই capability রাখা হয়েছে যেগুলোর infrastructure বা কিছু execution path বাস্তবে কাজ করেছে, কিন্তু নির্দিষ্ট task-এ নির্ভরযোগ্যভাবে সম্পূর্ণ হয়নি।

## 1. Goal understanding — আংশিক সক্ষম

আগের live run-এ goal-oriented prompt গ্রহণ ও task run শুরু হয়েছিল, কিন্তু চারটি নির্দিষ্ট heading-সহ goal decomposition দেওয়া হয়নি; `write_files` নিয়ে অপ্রাসঙ্গিক refusal এসেছিল। Gemma routing retest-এ নতুন inference `Thinking…` অবস্থায় আটকে ছিল। Basic intent গ্রহণের path আছে, কিন্তু structured goal understanding ১০০% নির্ভরযোগ্য নয়।

## 2. Planning — আংশিক/শর্তসাপেক্ষ সক্ষম

Planner specialist, workflow metadata এবং project workflow infrastructure repository-তে উপস্থিত; আগের scaffold workflow-এর plan, dry-run ও smoke modes সফলভাবে exit করেছিল। তবে live read-only planning prompt-এ harmless plan দেওয়ার বদলে ভুল refusal এসেছিল। ফলে planning architecture কাজ করে, model-mediated planning reliability সীমিত।

## 3. Tool use — আংশিক/শর্তসাপেক্ষ সক্ষম

Tool registry, workspace boundary, audit path এবং workflow execution infrastructure চালু আছে। কিন্তু read-only top-level directory inspection test-এ কোনো directory result না দিয়ে “No matching verification gates” error এসেছিল। Tool path available হলেও prompt-to-tool selection end-to-end নির্ভরযোগ্যভাবে verified নয়।

## 4. Code development — আংশিক/শর্তসাপেক্ষ সক্ষম

Frontend 68 tests এবং core 586 tests আগের validation-এ passed; source-level code workflow ও generated scaffold বাস্তবে কাজ করেছে। কিন্তু live null-safe JavaScript function + দুই test case prompt-এ model code দেয়নি। তাই platform code execution সক্ষম, কিন্তু task-specific code generation ও correctness model-dependent।

## Supporting verified infrastructure

| Area | Observed result |
|---|---|
| Dashboard | Authentication ও chat workspace visualভাবে reached |
| Local Gemma runtime | `gemma-4-e2b` model server `/health`-এ `ok` |
| Direct Gemma completion | Exact smoke prompt-এর exact response; exit code `0` |
| Model identity | `/v1/models`-এ `gemma-4-e2b` verified |
| UI model label | `llama.cpp/local-model` run label rendered |
| Source validation | Frontend 68 এবং core 586 tests পূর্বে passed |
| Gemini comparison | Usable credential না থাকায় live comparison unverified |

## Verdict

**আংশিক বা শর্তসাপেক্ষ সক্ষম capability: ৪টি।** Gemma transport সফল হলেও agentic quality, tool selection, planning এবং code output-এর ১০০% end-to-end প্রমাণ পাওয়া যায়নি।

## Gemma retest boundary

Gemma server direct transport সফল হয়েছে। Agent Miki UI-তে Gemma-routed retest একটি দীর্ঘ `Thinking…` state-এ ছিল; final assistant answer আসেনি। তাই direct model transport-কে agentic capability success হিসেবে গণ্য করা হয়নি।
