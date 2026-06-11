import { describe, expect, test } from "bun:test";
import { MagicContextConfigSchema } from "./magic-context";

describe("MagicContextConfigSchema memory.external.recall", () => {
    test("recall sub-block defaults when omitted", () => {
        const config = MagicContextConfigSchema.parse({
            memory: {
                external: {
                    provider: "hindsight",
                    endpoint: "http://10.0.0.1:8889",
                    main_bank: "main-memory",
                },
            },
        });
        const external = config.memory.external;
        if (external.provider !== "hindsight") throw new Error("expected hindsight");
        expect(external.recall).toEqual({
            enabled: true,
            timeout_ms: 3000,
            max_tokens: 2048,
            dedup_threshold: 0.85,
            global_tags: [],
            global_from_prompt: false,
            search: true,
            mental_models: true,
            profile_mental_models: ["user-preferences"],
        });
    });

    test("recall sub-block bounds enforced", () => {
        const result = MagicContextConfigSchema.safeParse({
            memory: {
                external: {
                    provider: "hindsight",
                    endpoint: "http://10.0.0.1:8889",
                    main_bank: "main-memory",
                    recall: { timeout_ms: 100, dedup_threshold: 1.5 },
                },
            },
        });
        expect(result.success).toBe(false);
    });

    test("recall timeout_ms rejects above max (15000)", () => {
        const result = MagicContextConfigSchema.safeParse({
            memory: {
                external: {
                    provider: "hindsight",
                    endpoint: "http://10.0.0.1:8889",
                    main_bank: "main-memory",
                    recall: { timeout_ms: 20000 },
                },
            },
        });
        expect(result.success).toBe(false);
    });

    test("recall max_tokens rejects below min (256)", () => {
        const result = MagicContextConfigSchema.safeParse({
            memory: {
                external: {
                    provider: "hindsight",
                    endpoint: "http://10.0.0.1:8889",
                    main_bank: "main-memory",
                    recall: { max_tokens: 100 },
                },
            },
        });
        expect(result.success).toBe(false);
    });

    test("recall max_tokens rejects above max (8192)", () => {
        const result = MagicContextConfigSchema.safeParse({
            memory: {
                external: {
                    provider: "hindsight",
                    endpoint: "http://10.0.0.1:8889",
                    main_bank: "main-memory",
                    recall: { max_tokens: 10000 },
                },
            },
        });
        expect(result.success).toBe(false);
    });

    test("recall dedup_threshold rejects below min (0.5)", () => {
        const result = MagicContextConfigSchema.safeParse({
            memory: {
                external: {
                    provider: "hindsight",
                    endpoint: "http://10.0.0.1:8889",
                    main_bank: "main-memory",
                    recall: { dedup_threshold: 0.3 },
                },
            },
        });
        expect(result.success).toBe(false);
    });

    test("provider off ignores recall block", () => {
        const config = MagicContextConfigSchema.parse({
            memory: { external: { provider: "off", recall: { enabled: true } } },
        });
        expect(config.memory.external).toEqual({ provider: "off" });
    });
});
