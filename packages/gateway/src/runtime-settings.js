/** Runtime defaults mirrored from the Settings form so an unset config value
 * has the same effective behavior as the UI's default state. */
export const DEFAULT_MAX_COMPLETION_TOKENS = 32768;
export const DEFAULT_MAX_TOOL_ITERATIONS = 50;
function positiveInteger(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}
export function resolveMaxToolIterations(defaults, env = process.env) {
    return positiveInteger(defaults.max_tool_iterations)
        ?? positiveInteger(env.MIKI_AGENT_MAX_TURNS)
        ?? DEFAULT_MAX_TOOL_ITERATIONS;
}
export function resolveContextWindowTokens(defaults) {
    const explicit = positiveInteger(defaults.context_window);
    if (explicit !== undefined)
        return explicit;
    const maxTokens = positiveInteger(defaults.max_completion_tokens ?? defaults.max_tokens) ?? DEFAULT_MAX_COMPLETION_TOKENS;
    return maxTokens * 4;
}
