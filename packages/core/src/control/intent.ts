import type { ControlOperationRequest } from "./types.js";

export interface ControlIntentResult {
  matched: boolean;
  request?: ControlOperationRequest;
  explanation: string;
}

/**
 * Handles only unambiguous, reversible management phrases. Complex requests
 * should continue through the normal agent planner instead of being guessed.
 */
export function parseControlIntent(message: string): ControlIntentResult {
  const text = message.trim();
  const lower = text.toLowerCase();
  if (!text)
    return { matched: false, explanation: "Empty management request." };

  const voiceInstall = lower.match(
    /(?:install|download|setup|set up|ইনস্টল|ডাউনলোড|স্থাপন).*(?:voice|speech|vtt|whisper|ভয়েস|ভয়েস|স্পিচ).*(?:model|মডেল)\s*([a-z0-9._-]+)?/i,
  );
  if (voiceInstall) {
    const model = voiceInstall[1] || "base";
    if (!["base", "base.en", "small"].includes(model)) {
      return {
        matched: true,
        explanation:
          "Only the official voice model catalog entries base, base.en, and small can be installed.",
        request: {
          capability: "model_runtime",
          action: "install",
          input: {
            adapter: "voice.local",
            provider: "whisper.cpp",
            model_id: model,
          },
          context: { origin: "local" },
        },
      };
    }
    return {
      matched: true,
      explanation: `Install the allow-listed official whisper.cpp voice model ${model} after owner approval.`,
      request: {
        capability: "model_runtime",
        action: "install",
        input: {
          adapter: "voice.local",
          provider: "whisper.cpp",
          model_id: model,
        },
        context: { origin: "local" },
      },
    };
  }

  if (
    /^(inspect|show|check)\s+(agent\s+)?(control\s+)?(state|configuration|config)$/i.test(
      text,
    )
  ) {
    return {
      matched: true,
      explanation: "Read the sanitized current runtime state.",
      request: {
        capability: "system_state",
        action: "inspect",
        context: { origin: "local" },
      },
    };
  }
  if (/^(list|show)\s+(available\s+)?(agent\s+)?capabilities$/i.test(text)) {
    return {
      matched: true,
      explanation:
        "List typed control operations available in the current runtime.",
      request: {
        capability: "capabilities",
        action: "list",
        context: { origin: "local" },
      },
    };
  }

  const toolToggle = lower.match(
    /\b(enable|disable|turn on|turn off)\s+(?:the\s+)?([a-z0-9_.-]+)\s+tool\b/,
  );
  if (toolToggle) {
    const enabled = toolToggle[1] === "enable" || toolToggle[1] === "turn on";
    return {
      matched: true,
      explanation: `${enabled ? "Enable" : "Disable"} the named tool through validated tool state.`,
      request: {
        capability: "tool_state",
        action: "set",
        input: { name: toolToggle[2], enabled },
        context: { origin: "local" },
      },
    };
  }

  const resourceMode = lower.match(
    /\b(?:set|switch|change)\s+(?:agent\s+)?(?:resource\s+)?mode\s+to\s+(eco|balanced|performance)\b/,
  );
  if (resourceMode) {
    return {
      matched: true,
      explanation: "Apply a supported agent resource profile.",
      request: {
        capability: "config",
        action: "patch",
        input: { patch: { agent: { resource: { mode: resourceMode[1] } } } },
        context: { origin: "local" },
      },
    };
  }

  const modelHealth = lower.match(
    /\b(?:check|inspect|test)\s+(?:the\s+)?(?:local\s+)?model(?:\s+([a-z0-9._/-]+))?\b/,
  );
  if (modelHealth) {
    return {
      matched: true,
      explanation: "Inspect the configured model/runtime adapter health.",
      request: {
        capability: "model_runtime",
        action: "health",
        input: modelHealth[1] ? { model: modelHealth[1] } : {},
        context: { origin: "local" },
      },
    };
  }

  const activateModel = lower.match(
    /\b(?:use|activate|switch to)\s+(?:the\s+)?model\s+([a-z0-9._/-]+)\b/,
  );
  if (activateModel) {
    return {
      matched: true,
      explanation:
        "Activate a configured model through the registered runtime adapter.",
      request: {
        capability: "model_runtime",
        action: "activate",
        input: { model: activateModel[1] },
        context: { origin: "local" },
      },
    };
  }

  return {
    matched: false,
    explanation: "Request is not an unambiguous control intent.",
  };
}
