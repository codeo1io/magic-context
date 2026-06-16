import { describe, expect, test } from "bun:test";

// Test the intent injection logic in isolation (pure function)
// Import from the dedicated module, not from index.ts (which is the plugin entry point)
import { injectSkillIntentParam } from "./skill-tool-definition";

describe("skill tool definition intent injection", () => {
    test("adds intent param to skill tool schema when toolID is 'skill'", () => {
        const output = {
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Skill name" },
                },
                required: ["name"],
            },
        };
        injectSkillIntentParam("skill", output);
        expect(output.parameters.properties).toHaveProperty("intent");
        expect(output.parameters.properties.intent).toMatchObject({
            type: "string",
        });
        // intent must NOT be in required (it is optional)
        expect(output.parameters.required).not.toContain("intent");
    });

    test("does not modify non-skill tool schemas", () => {
        const output = {
            parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
            },
        };
        const before = JSON.stringify(output);
        injectSkillIntentParam("bash", output);
        expect(JSON.stringify(output)).toBe(before);
    });

    test("is idempotent — does not double-add intent", () => {
        const output = {
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    intent: { type: "string", description: "existing" },
                },
                required: ["name"],
            },
        };
        injectSkillIntentParam("skill", output);
        const intentKeys = Object.keys(output.parameters.properties).filter((k) => k === "intent");
        expect(intentKeys.length).toBe(1);
    });
});
