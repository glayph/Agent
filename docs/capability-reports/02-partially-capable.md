# Agent Miki Capability Report — Partially or Conditionally Capable

## Classification rule

এই ফাইলে সেই capability রাখা হয়েছে যেগুলোর কিছু অংশ বাস্তবে কাজ করেছে, কিন্তু বর্তমান local LFM2.5 model-এর response quality, context length, tool configuration বা provider setup-এর কারণে প্রতিটি নির্দিষ্ট task-এ নির্ভরযোগ্যভাবে সম্পূর্ণ হয়নি।

## 1. Goal understanding — আংশিক সক্ষম

Agent Miki goal-oriented prompt গ্রহণ করেছে এবং task run শুরু করেছে। কিন্তু test-এ নির্দিষ্ট চারটি heading-সহ goal, subtask, success criteria এবং safety constraints দিতে পারেনি; বরং `write_files` parameter সংক্রান্ত অপ্রাসঙ্গিক refusal দিয়েছে। ফলে intent গ্রহণের basic layer কাজ করলেও goal decomposition ও constraint interpretation ১০০% নির্ভরযোগ্য নয়।

## 2. Planning — আংশিক সক্ষম

আগের live task-এ Miki planning-oriented workflow শুরু করেছে এবং dashboard activity-তে workflow completion দেখা গেছে। তবে read-only তিন ধাপের plan test-এ destructive action চাওয়া হয়েছে বলে ভুলভাবে refusal দিয়েছে। অর্থাৎ planning path আছে, কিন্তু harmless planning এবং “plan only” বনাম “execute” পার্থক্য সবসময় সঠিকভাবে বুঝতে পারেনি।

## 3. Tool use — আংশিক/শর্তসাপেক্ষ সক্ষম

Dashboard-এ tool-related workflow activity (`project_workflow_create`) সম্পন্ন হওয়ার প্রমাণ পাওয়া গেছে এবং runtime tools/build infrastructure কাজ করেছে। কিন্তু সরাসরি read-only top-level directory inspection test-এ Miki কোনো directory result দিতে পারেনি; “No matching verification gates” error দিয়েছে। Tool registry, prompt format এবং model instruction-following একসঙ্গে সঠিক হলে capability কাজ করতে পারে, কিন্তু বর্তমান local model দিয়ে নির্ভরযোগ্য নয়।

## 4. Code development — আংশিক/শর্তসাপেক্ষ সক্ষম

Repository-এর frontend/core tests, build pipeline এবং source-level fixes বাস্তবে সম্পন্ন হয়েছে; এগুলো platform execution-এর সক্ষমতা দেখায়। কিন্তু live LFM prompt-এ null-safe JavaScript function ও দুইটি test case চাওয়া হলে model বলেছে প্রয়োজনীয় context নেই এবং code দেয়নি। আগের pseudo-code review-তেও null handling সম্পর্কে ভুল claim করেছে। তাই code development infrastructure আছে, কিন্তু local model output correctness ও instruction adherence ১০০% নয়।

## Supporting verified infrastructure

| Area | Observed result |
|---|---|
| Dashboard availability | Authenticated chat workspace reached successfully |
| Local model transport | llama.cpp local endpoint loaded and served requests |
| Chat lifecycle | User prompt, running state, activity, and assistant response rendered |
| Runtime source quality | Frontend 68 tests and core 586 tests passed in prior validation |
| Provider state | Local model appeared in the Models UI and was selected as default |

## Verdict

**আংশিক বা শর্তসাপেক্ষ সক্ষম capability: ৪টি।** Agent Miki-এর architecture ও UI execution path আছে, কিন্তু বর্তমান 1.2B local model-এর reasoning, planning, tool selection এবং code-generation reliability সীমিত।
