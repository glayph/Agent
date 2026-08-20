# Agent Miki Web UI Chat Test Notes

## Test 1

Message: হ্যালো Miki, তুমি কে এবং কী কী কাজ করতে পারো?

Observed result: User message was accepted by the Web UI. The assistant response area displayed: “Model quota or rate limit reached. Retrying in a loop. Wait for quota to reset, enable billing, lower traffic, OR configure another provider/model as a fallback.” The dashboard header showed 2 messages and 1 active agent. Screenshot captured at `/home/ubuntu/screenshots/127_0_0_1_2026-08-20_10-10-58_3143.webp`.

## Model fallback check

The model selector exposed `gpt-4o-mini`, `gpt-4o`, and `gemini-3.6-flash`. Selecting `gpt-4o` produced a dashboard notice that the latest configuration was saved and the gateway must be restarted for it to take effect. The current chat remained on the quota/rate-limit error until restart.

## Clean runtime restart

The frontend build was copied into the runtime workspace and served successfully. After the clean gateway/supervisor restart, the dashboard returned to `/launcher-login`, requiring the dashboard password again. Gateway health was healthy before browser navigation.

## Test 2

Message: একটি ছোট কাজ পরিকল্পনা করো: আগামী ৫ মিনিটের জন্য “Miki test timer” নামে একটি timer তৈরি করার আগে তুমি কী কী ধাপ নেবে? এখন কোনো external action নিও না—শুধু পরিকল্পনাটি বলো।

Observed result: The message was accepted and the UI entered `Running` state, but the assistant returned: “The API key for gpt-4o was rejected by the provider. Open Credentials in the dashboard or run `mikiagent config set OPENAI_API_KEY` with a valid key.” Screenshot captured at `/home/ubuntu/screenshots/127_0_0_1_2026-08-20_10-13-16_5406.webp`.

## Test 3

Message: আগের timer পরিকল্পনাটি আপাতত থামাও। এখন শুধু এক লাইনে বলো: আমি যদি তোমাকে একটি ফাইল দিই, তুমি কি সেটি পড়ে সারাংশ ও উন্নতির পরামর্শ দিতে পারবে?

Observed result: The context-switch message was accepted; the transcript reached 4 messages and showed the new user message followed by the same gpt-4o provider key rejection. The UI displayed the expected user message, but no model answer. Screenshot captured at `/home/ubuntu/screenshots/127_0_0_1_2026-08-20_10-13-31_3844.webp`.
