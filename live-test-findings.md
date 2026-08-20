# Agent Miki live test findings

## External provider verification

The Google Gemini native API reported that `models/gemini-2.0-flash-001` is no longer available and instructed clients to use `models/gemini-3.6-flash`. A direct `generateContent` probe for `gemini-3.6-flash` returned HTTP 200 with `modelVersion: gemini-3.6-flash`, confirming that the supplied test credential can reach the current generation endpoint.

The Miki model connectivity test for `gemini-3.6-flash` also reported `Connection successful` against `https://generativelanguage.googleapis.com/v1beta/openai`.

## Runtime correction

The core provider resolver requires a provider-qualified model identifier. `DEFAULT_MODEL=google/gemini-3.6-flash` and `MIKI_PROVIDER=google` were used for the restart; the unqualified `gemini-3.6-flash` value fell through to the OpenRouter default path.

## Live UI observation

The chat composer still displayed the persisted alias `gemini-2.0-flash-001` after the model identifier was edited, so a separate visible `gemini-3.6-flash` model entry is being added for direct selection in the chat composer.

## Model catalog setup

The dashboard successfully tested the new Google Gemini entry with alias and identifier `gemini-3.6-flash`; the connection test reported **Connection successful** with a 265 ms response time. The model was then saved and marked as the default. The Models page now shows two Google Gemini entries, with `gemini-3.6-flash` marked Default.

## Live agent task result

Task sent in Bengali: calculate the mean, median, minimum, maximum, range, and count of 25 for `[12, 18, 25, 25, 30, 42, 48]`, explain the verification method, and remain responsive to a checkpoint question.

Agent Miki completed the main task and returned the correct results:

- Sum: `200`
- Count: `7`
- Mean: `28.57` (`200 / 7`)
- Median: `25`
- Minimum: `12`
- Maximum: `48`
- Range: `36`
- Count of `25`: `2`

Checkpoint sent during the run: "এখন পর্যন্ত কাজের কোন ধাপ সম্পন্ন হয়েছে, এবং মোট যোগফল ও সংখ্যার count কত পেয়েছ? সংক্ষিপ্ত উত্তর দাও; মূল কাজও চালিয়ে যাও।"

The agent answered the checkpoint after the main report, explicitly stating that data observation, sum, mean, median, min, max, range, and frequency calculation were complete; it reported total `200` and count `7`, then repeated the main report. The run reached a paused/terminal state after the answer, with no provider error.

The dashboard composer visibly continued to display the stale `gemini-2.0-flash-001` label even after `gemini-3.6-flash` was set as default, but the successful result confirms the request was executed through the repaired Gemini configuration.
