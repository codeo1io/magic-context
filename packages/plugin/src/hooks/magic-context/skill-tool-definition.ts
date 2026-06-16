/**
 * Injects an optional `intent` parameter into the `skill` tool's schema.
 * Called from the `tool.definition` hook. Effect-Schema strips unknown keys
 * at `onExcessProperty: "ignore"` BEFORE the skill tool executes — `intent`
 * is silently dropped from the args that reach the skill tool itself.
 * The `tool.execute.before` hook captures it PRE-validation.
 *
 * Lives here (not in index.ts) to avoid leaking an internal helper through
 * the plugin entry point. index.ts imports and calls it directly.
 */
export function injectSkillIntentParam(
    toolID: string,
    output: {
        parameters?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
    },
): void {
    if (toolID !== "skill") return;
    if (!output.parameters || typeof output.parameters !== "object") return;
    if (!output.parameters.properties) return;
    // Idempotent: don't double-add
    if ("intent" in output.parameters.properties) return;
    output.parameters.properties.intent = {
        type: "string",
        description:
            "Optional: describe what you are trying to accomplish with this skill (used for skill-memory recall). E.g. 'fix a flaky test in the auth module'.",
    };
    // intent is optional — do NOT add to required[]
}
