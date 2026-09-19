import type { AutonomyMode } from "./types.js";

/**
 * Process-wide mirror of AutonomyController's current mode.
 *
 * AutonomyController already owns the authoritative `mode` field, but tool
 * execution gates (destructive-gate.ts, isolated-browser-worker.ts) live
 * several layers below it and have no direct reference to the controller
 * instance. Rather than threading the controller through every handler's
 * constructor, AutonomyController pushes its mode here on boot and on every
 * setMode() call, and gates read it synchronously. Single Node.js process,
 * single mutable binding — no locking needed.
 *
 * IMPORTANT (turbo-mode approval bypass, requested by owner):
 * `isTurboModeActive()` is what lets turbo mode skip the human-approval
 * checkpoint for destructive shell/file/computer-use actions and browser
 * side-effect actions (see destructive-gate.ts / isolated-browser-worker.ts).
 * It deliberately does NOT reach the remote-admin approval gates in
 * admin-control-handlers.ts / admin-skill-handlers.ts — those only fire for
 * `caller.origin === "remote"` (an external caller trying to reconfigure the
 * running agent or install a skill), which is an attacker-facing check, not
 * an autonomous-decision-making check, and turbo mode has no bearing on it.
 */

let currentMode: AutonomyMode = "standard";

export function setRuntimeAutonomyMode(mode: AutonomyMode): void {
  currentMode = mode;
}

export function getRuntimeAutonomyMode(): AutonomyMode {
  return currentMode;
}

export function isTurboModeActive(): boolean {
  return currentMode === "turbo";
}
